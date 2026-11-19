import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { auditLog, inboxConversation, inboxHoliday, inboxMessage, inboxPhoneNumber, inboxWebhookEvent, outboxEvent, waFlow, waFlowResponse } from "@ms/db";
import { SLOT_WINDOWS, makeFlowToken } from "@ms/domain";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";

/**
 * Suite spec 07, Phase B: the encrypted data endpoint for the live delivery-time form, the `flows`
 * webhook field and the secure-connection routes. A throwaway RSA key pair is generated when the
 * file runs and put in process.env; no key is written into this file. The test encrypts the way
 * Meta's guide says WhatsApp does. The Graph API is stubbed; nothing reaches Meta.
 */

const APP_SECRET = "itest-meta-app-secret";
const APP_ID = "1234567890";
const WABA = "WABA-SLOTS";
const WA_NUMBER_ID = "5550008888";

let publicKey: crypto.KeyObject;
let privateB64: string;

interface GraphCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  text: string | null;
}
let calls: GraphCall[] = [];
/** What "Meta" holds for the number's key. */
let metaKey: { pem: string; status: string } | null = null;
const metaFlows = new Map<string, { id: string; name: string; status: string; endpoint_uri?: string; application_id?: string }>();
let seqId = 0;
let wamidSeq = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/")) return real(input, init);
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = decodeURIComponent(url.pathname.replace(/^\/v[\d.]+\//, ""));
    const text = typeof init?.body === "string" ? init.body : null;
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    calls.push({ method, path, body, text });

    if (path === `${WA_NUMBER_ID}/whatsapp_business_encryption`) {
      if (method === "POST") {
        metaKey = { pem: new URLSearchParams(text ?? "").get("business_public_key") ?? "", status: "VALID" };
        return json({ success: true });
      }
      return json(metaKey ? { data: [{ business_public_key: metaKey.pem, business_public_key_signature_status: metaKey.status }] } : { data: [] });
    }
    if (path === `${WA_NUMBER_ID}/messages` && method === "POST") return json({ messages: [{ id: `wamid.slot.out.${++wamidSeq}` }] });
    if (path === `${WABA}/flows` && method === "POST") {
      const id = `80${++seqId}0001`;
      metaFlows.set(id, { id, name: String(body!.name), status: "DRAFT", ...(body!.endpoint_uri ? { endpoint_uri: String(body!.endpoint_uri) } : {}) });
      return json({ id, success: true, validation_errors: [] });
    }
    const [id, action] = path.split("/") as [string, string | undefined];
    const held = metaFlows.get(id);
    if (held) {
      if (action === undefined && method === "POST") {
        Object.assign(held, body);
        return json({ success: true });
      }
      if (action === undefined && method === "GET") return json({ id, name: held.name, status: held.status, validation_errors: [] });
      if (action === "publish") {
        held.status = "PUBLISHED";
        return json({ success: true });
      }
    }
    return json({ error: { message: `unexpected ${method} ${path}`, code: 100 } }, 400);
  }) as typeof fetch;
}

describe("WhatsApp forms, Phase B: the data endpoint (suite spec 07)", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let owner: string;
  let conversationId: string;
  let numberRowId: string;
  let timings: { budgetMs: number };
  const CUSTOMER = "2347055590001";
  let inSeq = 0;

  const sign = (raw: string): string => "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");

  /** Encrypt a payload exactly as WhatsApp does: AES-128-GCM, tag appended; the AES key under RSA-OAEP SHA-256. */
  function seal(payload: unknown) {
    const aesKey = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv("aes-128-gcm", aesKey, iv);
    const data = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final(), c.getAuthTag()]);
    const wrapped = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey);
    const raw = JSON.stringify({ encrypted_flow_data: data.toString("base64"), encrypted_aes_key: wrapped.toString("base64"), initial_vector: iv.toString("base64") });
    return { raw, aesKey, iv };
  }
  /** Read our answer the way the WhatsApp client does: the same key, the IV with every bit flipped. */
  function open(answer: string, aesKey: Buffer, iv: Buffer): Record<string, unknown> {
    const buf = Buffer.from(answer, "base64");
    const d = crypto.createDecipheriv("aes-128-gcm", aesKey, Buffer.from(iv.map((b) => b ^ 0xff)));
    d.setAuthTag(buf.subarray(-16));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]).toString("utf8")) as Record<string, unknown>;
  }
  async function post(raw: string, signature: string | null = sign(raw)): Promise<Response> {
    return fetch(`${baseUrl}/v1/webhooks/whatsapp-flows`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
      body: raw,
    });
  }
  /** One sealed call; returns the status and, on 200, the decrypted answer. */
  async function ask(payload: Record<string, unknown>): Promise<{ status: number; type: string | null; answer: Record<string, unknown> | null; text: string }> {
    const s = seal(payload);
    const res = await post(s.raw);
    const text = await res.text();
    return { status: res.status, type: res.headers.get("content-type"), answer: res.status === 200 ? open(text, s.aesKey, s.iv) : null, text };
  }
  const token = (key: "delivery_slot" | "complaint" = "delivery_slot", at = new Date(), conv = conversationId): string =>
    makeFlowToken(process.env.JWT_SIGNING_KEY!, key, conv, at);
  const slotCall = (action: string, screen: string, data: Record<string, unknown> = {}, flowToken = token()) =>
    ask({ version: "3.0", action, screen, data, flow_token: flowToken });

  async function postWebhook(change: { field: string; value: unknown }): Promise<void> {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: WABA, time: Math.floor(Date.now() / 1000), changes: [change] }] });
    const res = await fetch(`${baseUrl}/v1/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) }, body: raw });
    expect(res.status).toBe(200);
  }
  const messagesChange = (messages: unknown[]) => ({
    field: "messages",
    value: { messaging_product: "whatsapp", metadata: { display_phone_number: "2348000000800", phone_number_id: WA_NUMBER_ID }, contacts: [{ profile: { name: "Test Customer" }, wa_id: CUSTOMER }], messages },
  });
  /** A completed delivery-time form arriving on the messages webhook: this is what makes a booking real. */
  async function book(day: string, slot: string): Promise<string> {
    const wamid = `wamid.slot.in.${++inSeq}`;
    await postWebhook(
      messagesChange([
        {
          from: CUSTOMER,
          id: wamid,
          timestamp: String(Math.floor(Date.now() / 1000) + inSeq),
          type: "interactive",
          interactive: { type: "nfm_reply", nfm_reply: { name: "flow", body: "Sent", response_json: JSON.stringify({ flow_token: token(), flow_key: "delivery_slot", day, slot, slot_label: `${day}, ${slot}` }) } },
        },
      ]),
    );
    return wamid;
  }
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, { method, headers: { cookie: owner, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  beforeAll(async () => {
    const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    publicKey = pair.publicKey;
    privateB64 = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "utf8").toString("base64");

    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = "itest-verify";
    process.env.META_SYSTEM_USER_TOKEN = "itest-token";
    process.env.META_GRAPH_VERSION = "v23.0";
    process.env.META_APP_ID = APP_ID;
    process.env.WA_FLOW_PRIVATE_KEY_B64 = privateB64;
    delete process.env.WA_FLOW_PRIVATE_KEY_PASSPHRASE;
    installGraphStub();
    await seedOwner(db);
    const [num] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000000800", label: "Main line", channels: "whatsapp", wabaId: WABA, waPhoneNumberId: WA_NUMBER_ID })
      .returning();
    numberRowId = num!.id;

    const { buildApp } = await import("../../src/test-app.js");
    timings = (await import("../../src/routes/webhooks-whatsapp-flows.js")).flowEndpointTimings;
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    await postWebhook(messagesChange([{ from: CUSTOMER, id: "wamid.slot.first", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Hello" } }]));
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, "wamid.slot.first"));
    conversationId = msg!.conversationId;
  }, 120_000);

  afterAll(async () => {
    server.close();
    delete process.env.WA_FLOW_PRIVATE_KEY_B64;
    await container?.stop();
  });

  beforeEach(() => {
    calls = [];
    process.env.WA_FLOW_PRIVATE_KEY_B64 = privateB64;
    timings.budgetMs = 8_000;
  });

  it("503 without a key; 432 on a bad signature; 421 on an undecryptable body", async () => {
    const good = seal({ version: "3.0", action: "ping" });

    delete process.env.WA_FLOW_PRIVATE_KEY_B64;
    const off = await post(good.raw);
    expect(off.status).toBe(503);
    expect(await off.text()).toBe("");
    // A setting that is not a usable key is the same as none.
    process.env.WA_FLOW_PRIVATE_KEY_B64 = Buffer.from("not a key").toString("base64");
    expect((await post(good.raw)).status).toBe(503);
    process.env.WA_FLOW_PRIVATE_KEY_B64 = privateB64;

    for (const sig of [null, "sha256=" + "0".repeat(64), sign(good.raw + " ")]) {
      const res = await post(good.raw, sig);
      expect(res.status).toBe(432);
      expect(await res.text()).toBe("");
    }

    const envelope = JSON.parse(good.raw) as Record<string, string>;
    const tampered = JSON.stringify({ ...envelope, encrypted_flow_data: Buffer.from("garbage-garbage-garbage-garbage").toString("base64") });
    const otherKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    const wrongKey = JSON.stringify({
      ...envelope,
      encrypted_aes_key: crypto.publicEncrypt({ key: otherKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, crypto.randomBytes(16)).toString("base64"),
    });
    for (const raw of [tampered, wrongKey, "{}", "not json", JSON.stringify({ encrypted_flow_data: 1 })]) {
      const res = await post(raw);
      expect(res.status, raw.slice(0, 20)).toBe(421);
      expect(await res.text()).toBe("");
    }
  });

  it("ping answers active", async () => {
    const r = await ask({ version: "3.0", action: "ping" });
    expect(r.status).toBe(200);
    expect(r.answer).toEqual({ data: { status: "active" } });
  });

  it("an error notice is acknowledged", async () => {
    const r = await ask({ version: "3.0", action: "data_exchange", screen: "PICK_DAY", data: { error: "invalid_screen_transition", error_message: "Something went wrong" }, flow_token: token() });
    expect(r.status).toBe(200);
    expect(r.answer).toEqual({ data: { acknowledged: true } });
  });

  it("427 with the customer line for an expired token and for another form's token", async () => {
    const expired = token("delivery_slot", new Date(Date.now() - 4 * 24 * 3600_000));
    const cases = [
      expired,
      token("complaint"),
      "unused",
      makeFlowToken("some-other-secret-entirely", "delivery_slot", conversationId, new Date()),
      // A good token for a conversation that no longer exists.
      token("delivery_slot", new Date(), "99999999-9999-4999-8999-999999999999"),
    ];
    for (const t of cases) {
      const r = await slotCall("INIT", "", {}, t);
      expect(r.status, t.slice(0, 20)).toBe(427);
      expect(JSON.parse(r.text)).toEqual({ error_msg: "This form has expired. Please ask us to send it again." });
    }
    // No token at all.
    expect((await ask({ version: "3.0", action: "INIT" })).status).toBe(427);
  });

  it("INIT → PICK_DAY, day → PICK_TIME, slot → SUCCESS, each decryptable with the flipped IV", async () => {
    const init = await slotCall("INIT", "");
    expect(init.status).toBe(200);
    expect(init.answer!.screen).toBe("PICK_DAY");
    const days = (init.answer!.data as { days: { id: string; title: string }[]; error_message?: string }).days;
    expect(days.length).toBeGreaterThanOrEqual(1);
    expect(days.length).toBeLessThanOrEqual(5);
    for (const d of days) {
      expect(d.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.title).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2} [A-Z][a-z]{2}$/); // never a Sunday with no hours profile
    }
    expect((init.answer!.data as { error_message?: string }).error_message).toBeUndefined();

    // The last day offered is at least a day ahead, so every window is open.
    const day = days.at(-1)!;
    const time = await slotCall("data_exchange", "PICK_DAY", { day: day.id });
    expect(time.answer).toEqual({
      screen: "PICK_TIME",
      data: {
        day: day.id,
        day_label: day.title,
        slots: [
          { id: "09:00-11:00", title: "9am to 11am" },
          { id: "11:00-13:00", title: "11am to 1pm" },
          { id: "13:00-15:00", title: "1pm to 3pm" },
          { id: "15:00-17:00", title: "3pm to 5pm" },
          { id: "17:00-19:00", title: "5pm to 7pm" },
        ],
      },
    });

    const t = token();
    const done = await slotCall("data_exchange", "PICK_TIME", { day: day.id, slot: "11:00-13:00" }, t);
    expect(done.answer).toEqual({
      screen: "SUCCESS",
      data: { extension_message_response: { params: { flow_token: t, flow_key: "delivery_slot", day: day.id, slot: "11:00-13:00", slot_label: `${day.title}, 11am to 1pm` } } },
    });
    // Choosing a time books nothing by itself: the booking is the completed form arriving.
    expect(await db.select().from(waFlowResponse).where(eq(waFlowResponse.flowKey, "delivery_slot"))).toHaveLength(0);

    // BACK and anything unrecognised go to the first screen; an unknown day says so.
    expect((await slotCall("BACK", "PICK_DAY")).answer!.screen).toBe("PICK_DAY");
    expect((await slotCall("something_new", "ELSEWHERE")).answer!.screen).toBe("PICK_DAY");
    const bad = await slotCall("data_exchange", "PICK_DAY", { day: "none" });
    expect(bad.answer!.screen).toBe("PICK_DAY");
    expect((bad.answer!.data as { error_message: string }).error_message).toBe("That day is now full. Please choose another.");
  });

  it("a full time is no longer offered and is refused at the last step; a holiday is never offered; a late booking is marked", async () => {
    const days = ((await slotCall("INIT", "")).answer!.data as { days: { id: string; title: string }[] }).days;
    const day = days.at(-1)!;
    const slot = "13:00-15:00";
    for (let i = 0; i < 4; i++) await book(day.id, slot);
    expect(await db.select().from(waFlowResponse).where(and(eq(waFlowResponse.flowKey, "delivery_slot"), sql`${waFlowResponse.data}->>'day' = ${day.id}`))).toHaveLength(4);

    const time = await slotCall("data_exchange", "PICK_DAY", { day: day.id });
    expect((time.answer!.data as { slots: { id: string }[] }).slots.map((s) => s.id)).toEqual(SLOT_WINDOWS.filter((w) => w !== slot));

    // Someone had the form open before it filled up and now confirms that time.
    const late = await slotCall("data_exchange", "PICK_TIME", { day: day.id, slot });
    expect(late.answer!.screen).toBe("PICK_TIME");
    const lateData = late.answer!.data as { error_message: string; slots: { id: string }[]; day: string; day_label: string };
    expect(lateData.error_message).toBe("That time has just been taken. Please choose another.");
    expect(lateData.slots.map((s) => s.id)).not.toContain(slot);
    expect(lateData).toMatchObject({ day: day.id, day_label: day.title });

    // Two customers finished in the same second: the fifth booking arrives anyway and its card says so.
    const fifth = await book(day.id, slot);
    const res = await api("GET", `/v1/inbox/conversations/${conversationId}/timeline`);
    type Item = { kind: string; data: { id: string; body: string | null; flow_response: { title: string; warning: string | null; rows: { label: string; value: string }[] } | null } };
    const cards = ((await res.json()) as { data: Item[] }).data.filter((i) => i.kind === "message" && i.data.flow_response).map((i) => i.data);
    expect(cards).toHaveLength(5);
    expect(cards.map((c) => c.flow_response!.warning)).toEqual([null, null, null, null, "This time was already full when it arrived"]);
    const [fifthMsg] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, fifth));
    expect(cards[4]!.id).toBe(fifthMsg!.id);
    expect(cards[4]!.body).toBe("Completed form: Delivery time");
    // The card shows the label, not the raw day and slot keys.
    expect(cards[0]!.flow_response).toMatchObject({ title: "Delivery time", rows: [{ label: "Delivery time", value: `${day.id}, ${slot}` }] });
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, conversationId));
    expect(conv!.labels).toContain("delivery-slot");

    // A holiday closes a day for every line.
    await db.insert(inboxHoliday).values({ profileId: null, date: day.id, label: "Test holiday" });
    const after = ((await slotCall("INIT", "")).answer!.data as { days: { id: string }[] }).days;
    expect(after.map((d) => d.id)).not.toContain(day.id);
    expect((await slotCall("data_exchange", "PICK_DAY", { day: day.id })).answer!.screen).toBe("PICK_DAY");
    await db.delete(inboxHoliday);
  });

  it("the response is text/plain and nothing is written to inbox_webhook_event", async () => {
    const count = async (): Promise<number> => (await db.select({ n: sql<number>`count(*)::int` }).from(inboxWebhookEvent))[0]!.n;
    const audits = async (): Promise<number> => (await db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]!.n;
    const before = await count();
    const auditsBefore = await audits();
    const ping = await ask({ version: "3.0", action: "ping" });
    const init = await slotCall("INIT", "");
    expect(ping.type).toContain("text/plain");
    expect(init.type).toContain("text/plain");
    // The answer is opaque base64, not readable JSON.
    expect(init.text).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(init.text).not.toContain("PICK_DAY");
    await post("{}", null);
    await slotCall("INIT", "", {}, "unused");
    expect(await count()).toBe(before);
    expect(await audits()).toBe(auditsBefore);
  });

  it("gives up with 500 when the answer is not ready inside the time budget", async () => {
    timings.budgetMs = 0;
    const r = await slotCall("INIT", "");
    expect(r.status).toBe(500);
    expect(r.text).toBe("");
    // The health check never waits on the database, so it still answers.
    expect((await ask({ version: "3.0", action: "ping" })).status).toBe(200);
  });

  it("flows webhook: FLOW_STATUS_CHANGE updates the row and BLOCKED raises one alert", async () => {
    const [row] = await db
      .insert(waFlow)
      .values({ wabaId: WABA, key: "complaint", version: 1, metaFlowId: "700700", metaName: "ms_complaint", status: "PUBLISHED" })
      .returning();
    const alerts = () => db.select().from(outboxEvent).where(and(eq(outboxEvent.eventType, "inbox.flow_health"), sql`${outboxEvent.payload}->>'flow_id' = '700700'`));
    const change = (value: Record<string, unknown>) => postWebhook({ field: "flows", value });

    await change({ event: "FLOW_STATUS_CHANGE", flow_id: "700700", old_status: "PUBLISHED", new_status: "BLOCKED", message: "Endpoint unhealthy" });
    expect((await db.select().from(waFlow).where(eq(waFlow.id, row!.id)))[0]!.status).toBe("BLOCKED");
    let found = await alerts();
    expect(found).toHaveLength(1);
    expect(found[0]!.payload).toEqual({ account: "700700:BLOCKED", flow_id: "700700", event: "BLOCKED", message: "Endpoint unhealthy", title: "Report a problem" });

    // The same news again within a day: no second alert. A different kind of news: its own alert.
    await change({ event: "FLOW_STATUS_CHANGE", flow_id: "700700", old_status: "PUBLISHED", new_status: "BLOCKED" });
    expect(await alerts()).toHaveLength(1);
    await change({ event: "ENDPOINT_LATENCY", flow_id: "700700", message: "p90 above 5s" });
    await change({ event: "ENDPOINT_LATENCY", flow_id: "700700" });
    found = await alerts();
    expect(found.map((a) => (a.payload as { event: string }).event).sort()).toEqual(["BLOCKED", "ENDPOINT_LATENCY"]);

    // Back to live: the row follows, with no alert. CLIENT_ERROR_RATE is only logged.
    await change({ event: "FLOW_STATUS_CHANGE", flow_id: "700700", old_status: "BLOCKED", new_status: "PUBLISHED" });
    await change({ event: "CLIENT_ERROR_RATE", flow_id: "700700", error_rate: 12 });
    expect((await db.select().from(waFlow).where(eq(waFlow.id, row!.id)))[0]!.status).toBe("PUBLISHED");
    expect(await alerts()).toHaveLength(2);

    // A form we do not hold: marked processed and ignored (rule 24).
    await change({ event: "FLOW_STATUS_CHANGE", flow_id: "123123", old_status: "DRAFT", new_status: "BLOCKED" });
    expect(await db.select().from(outboxEvent).where(sql`${outboxEvent.payload}->>'flow_id' = '123123'`)).toHaveLength(0);
    const events = await db.select().from(inboxWebhookEvent).where(eq(inboxWebhookEvent.kind, "flows"));
    expect(events.length).toBeGreaterThanOrEqual(7);
    expect(events.every((e) => e.processedAt !== null)).toBe(true);
    await db.delete(waFlow).where(eq(waFlow.id, row!.id));
  });

  it("encryption routes never return key text", async () => {
    type Enc = { key_configured: boolean; key_unusable: boolean; numbers: { number_id: string; label: string; key_configured: boolean; uploaded: boolean; signature_status: string | null }[] };
    const read = async (): Promise<{ text: string; data: Enc }> => {
      const res = await api("GET", "/v1/wa-flows/encryption");
      expect(res.status).toBe(200);
      const text = await res.text();
      return { text, data: (JSON.parse(text) as { data: Enc }).data };
    };
    metaKey = null;
    const first = await read();
    expect(first.data).toMatchObject({ key_configured: true, key_unusable: false, numbers: [{ number_id: numberRowId, label: "Main line", key_configured: true, uploaded: false, signature_status: null }] });

    const up = await api("POST", `/v1/wa-flows/encryption/${numberRowId}/upload`);
    expect(up.status).toBe(200);
    const upText = await up.text();
    const sent = calls.find((c) => c.method === "POST" && c.path === `${WA_NUMBER_ID}/whatsapp_business_encryption`)!;
    const pem = new URLSearchParams(sent.text ?? "").get("business_public_key")!;
    // Only the public half goes to Meta, and it is the half that matches the server's key.
    expect(pem).toBe(publicKey.export({ type: "spki", format: "pem" }).toString());
    expect(sent.text).not.toContain("PRIVATE");
    const second = await read();
    expect(second.data.numbers[0]).toMatchObject({ uploaded: true, signature_status: "VALID" });

    metaKey = { pem, status: "MISMATCH" };
    expect((await read()).data.numbers[0]!.signature_status).toBe("MISMATCH");
    metaKey = { pem, status: "VALID" };

    // No key text in anything we return or record.
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "wa_flow.key_upload"));
    expect(audits).toHaveLength(1);
    const pemBody = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    for (const text of [first.text, second.text, upText, JSON.stringify(audits)]) {
      expect(text).not.toContain("BEGIN");
      expect(text).not.toContain(pemBody.slice(0, 40));
      expect(text).not.toContain(privateB64.slice(0, 40));
    }
    expect((await api("POST", "/v1/wa-flows/encryption/11111111-1111-4111-8111-111111111111/upload")).status).toBe(404);

    // Without the key on the server: said plainly, Meta is not asked, and nothing can be sent.
    delete process.env.WA_FLOW_PRIVATE_KEY_B64;
    calls = [];
    const off = await read();
    expect(off.data).toMatchObject({ key_configured: false, numbers: [{ key_configured: false, uploaded: false, signature_status: null }] });
    expect((await api("POST", `/v1/wa-flows/encryption/${numberRowId}/upload`)).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("the delivery-time form is hidden without the key, needs the key at WhatsApp before it is published, and is sent with data_exchange", async () => {
    type Dto = { id: string | null; key: string; state: string; uses_endpoint: boolean; meta_flow_id: string | null; title: string };
    const list = async (): Promise<Dto[]> => ((await (await api("GET", "/v1/wa-flows")).json()) as { data: Dto[] }).data;
    const errOf = async (res: Response): Promise<string> => ((await res.json()) as { error: { message: string } }).error.message;

    // Rule 23: no key, no Phase B. Phase A forms are unaffected.
    delete process.env.WA_FLOW_PRIVATE_KEY_B64;
    expect((await list()).map((d) => d.key)).toEqual(["delivery_address", "bulk_order", "complaint", "pickup_request"]);
    const refused = await api("POST", "/v1/wa-flows/delivery_slot/create", { waba_id: WABA });
    expect(refused.status).toBe(503);
    expect(await errOf(refused)).toBe("The secure connection is not set up on this server yet.");
    process.env.WA_FLOW_PRIVATE_KEY_B64 = privateB64;
    expect((await list()).find((d) => d.key === "delivery_slot")).toMatchObject({ state: "not_created", uses_endpoint: true });

    calls = [];
    const made = await api("POST", "/v1/wa-flows/delivery_slot/create", { waba_id: WABA });
    expect(made.status).toBe(201);
    const dto = ((await made.json()) as { data: Dto }).data;
    const create = calls.find((c) => c.method === "POST" && c.path === `${WABA}/flows`)!;
    expect(create.body).toMatchObject({ name: "ms_delivery_slot", categories: ["APPOINTMENT_BOOKING"], endpoint_uri: "http://localhost/v1/webhooks/whatsapp-flows" });
    expect("publish" in create.body!).toBe(false);
    expect(calls.find((c) => c.method === "POST" && c.path === dto.meta_flow_id)!.body).toEqual({ endpoint_uri: "http://localhost/v1/webhooks/whatsapp-flows", application_id: APP_ID });
    expect((await db.select().from(waFlow).where(eq(waFlow.id, dto.id!)))[0]!.usesEndpoint).toBe(true);

    // Publishing needs a valid key at WhatsApp for every active number of the account.
    for (const state of [null, { pem: "x", status: "MISMATCH" }]) {
      metaKey = state;
      const res = await api("POST", `/v1/wa-flows/${dto.id}/publish`, { confirm_title: "Delivery time" });
      expect(res.status).toBe(409);
      expect(await errOf(res)).toBe("Send our key to WhatsApp first (Secure connection).");
    }
    expect(calls.some((c) => c.path.endsWith("/publish"))).toBe(false);
    metaKey = { pem: "x", status: "VALID" };
    expect((await api("POST", `/v1/wa-flows/${dto.id}/publish`, { confirm_title: "Delivery time" })).status).toBe(200);

    // Sending it: data_exchange, no entry-screen payload; and not at all while the server has no key.
    calls = [];
    const sent = await api("POST", `/v1/inbox/conversations/${conversationId}/flows`, { flow_key: "delivery_slot" });
    expect(sent.status).toBe(201);
    const params = (calls.find((c) => c.path === `${WA_NUMBER_ID}/messages`)!.body!.interactive as { action: { parameters: Record<string, unknown> } }).action.parameters;
    expect(params).toMatchObject({ flow_id: dto.meta_flow_id, flow_cta: "Choose a time", flow_action: "data_exchange", mode: "published" });
    expect("flow_action_payload" in params).toBe(false);
    // The token it carries is the one the endpoint accepts.
    expect((await slotCall("INIT", "", {}, String(params.flow_token))).status).toBe(200);

    delete process.env.WA_FLOW_PRIVATE_KEY_B64;
    const noKey = await api("POST", `/v1/inbox/conversations/${conversationId}/flows`, { flow_key: "delivery_slot" });
    expect(noKey.status).toBe(409);
    expect(await errOf(noKey)).toBe("The secure connection is not set up on this server yet.");
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { auditLog, customer, inboxConversation, inboxMessage, inboxNote, inboxPhoneNumber, inboxTemplate, outboxEvent, waFlow, waFlowResponse } from "@ms/db";
import { flowJsonHash, flowJsonText, makeFlowToken, readFlowToken } from "@ms/domain";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

/**
 * Suite spec 07: WhatsApp forms (Flows). The Graph API is stubbed: the stub keeps "Meta's" forms in
 * a map, answers by URL and method, and can be told how the next call should go. Nothing reaches
 * Meta. Phone numbers, names and addresses are made up. The token is fake.
 */

const APP_SECRET = "itest-meta-app-secret";
const WABA = "WABA-FLOWS";
const WA_NUMBER_ID = "5550007777";

interface Dto {
  id: string | null;
  key: string;
  title: string;
  version: number | null;
  meta_flow_id: string | null;
  meta_name: string | null;
  status: string | null;
  state: string;
  validation_errors: { message?: string }[];
  last_error: string | null;
  code_is_newer: boolean;
  only_live_version: boolean;
  published_at: string | null;
}
interface Err {
  error: { code: string; message: string; details?: { reason?: string; meta_code?: string | null } };
}

// ── The Graph stub ──────────────────────────────────────────────────────────

interface MetaFlowRow {
  id: string;
  name: string;
  status: string;
  categories: string[];
  json: string;
  validation_errors: unknown[];
}
interface GraphCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  form: FormData | null;
}

const store = new Map<string, MetaFlowRow>();
let calls: GraphCall[] = [];
let seqId = 0;
let wamidSeq = 0;
/** How "Meta" behaves for the next calls. */
let mode = {
  create: "ok" as "ok" | "name-clash" | "invalid" | "timeout-created" | "token",
  publish: "ok" as "ok" | "unverified" | "stays-draft",
  lockPublished: true,
  send: "ok" as "ok" | "blocked",
};

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
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const form = init?.body instanceof FormData ? init.body : null;
    calls.push({ method, path, query: url.searchParams, body, form });

    if (path === `${WA_NUMBER_ID}/messages` && method === "POST") {
      if (body?.status === "read") return json({ success: true });
      if (mode.send === "blocked" && body?.type === "interactive") {
        return json({ error: { message: "(#132068) Flow is blocked", code: 132068 } }, 400);
      }
      return json({ messages: [{ id: `wamid.flow.out.${++wamidSeq}` }] });
    }
    if (path === `${WABA}/flows`) {
      if (method === "GET") {
        return json({ data: [...store.values()].map((f) => ({ id: f.id, name: f.name, status: f.status, categories: f.categories, validation_errors: f.validation_errors })) });
      }
      if (method === "POST") {
        const b = body!;
        if (mode.create === "token") return json({ error: { message: "Invalid OAuth access token", code: 190 } }, 401);
        if (mode.create === "name-clash" || [...store.values()].some((f) => f.name === b.name)) {
          return json({ error: { message: "Flow with the same name already exists", code: 100, error_subcode: 4016019 } }, 400);
        }
        const id = `90${++seqId}0001`;
        const errors = mode.create === "invalid" ? [{ error: "INVALID_PROPERTY", error_type: "FLOW_JSON_ERROR", message: "The label is too long.", line_start: 12, column_start: 5, pointers: [] }] : [];
        store.set(id, { id, name: String(b.name), status: "DRAFT", categories: b.categories as string[], json: String(b.flow_json), validation_errors: errors });
        if (mode.create === "timeout-created") throw new TypeError("fetch failed");
        return json({ id, success: true, validation_errors: errors });
      }
    }
    const [id, action] = path.split("/") as [string, string | undefined];
    const held = store.get(id);
    if (held) {
      if (action === undefined && method === "GET") {
        if ((url.searchParams.get("fields") ?? "").startsWith("preview")) {
          return json({ id, preview: { preview_url: `https://business.facebook.com/wa/manage/flows/${id}/preview/?token=abc`, expires_at: "2026-12-20T00:00:00+0000" } });
        }
        return json({ id, name: held.name, status: held.status, categories: held.categories, validation_errors: held.validation_errors, json_version: "7.3" });
      }
      if (action === undefined && method === "DELETE") {
        if (held.status !== "DRAFT") return json({ error: { message: "Only draft flows can be deleted", code: 100 } }, 400);
        store.delete(id);
        return json({ success: true });
      }
      if (action === "assets" && method === "POST") {
        if (held.status !== "DRAFT" && mode.lockPublished) {
          return json({ error: { message: "Published flows cannot be updated", code: 139001 } }, 400);
        }
        held.json = await (form!.get("file") as File).text();
        held.validation_errors = [];
        held.status = "DRAFT";
        return json({ success: true, validation_errors: [] });
      }
      if (action === "publish" && method === "POST") {
        if (mode.publish === "unverified") return json({ error: { message: "Business must be verified to publish a flow", code: 139002 } }, 400);
        if (mode.publish !== "stays-draft") held.status = "PUBLISHED";
        return json({ success: true });
      }
      if (action === "deprecate" && method === "POST") {
        held.status = "DEPRECATED";
        return json({ success: true });
      }
    }
    return json({ error: { message: `unexpected ${method} ${path}`, code: 100 } }, 400);
  }) as typeof fetch;
}

const metaCalls = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe("WhatsApp forms (suite spec 07)", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let owner: string;
  let manager: string;
  let agent: string;
  let stranger: string;
  let phoneSeq = 0;
  let inSeq = 0;

  async function call(method: string, path: string, body?: unknown, cookie = owner): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const flows = (method: string, path: string, body?: unknown, cookie = owner) => call(method, `/v1/wa-flows${path === "/" ? "" : path}`, body, cookie);
  const data = async <T = Dto>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
  const err = async (res: Response): Promise<Err["error"]> => ((await res.json()) as Err).error;
  const rowOf = async (id: string) => (await db.select().from(waFlow).where(eq(waFlow.id, id)))[0]!;
  const audits = async (action: string, entityId: string) => db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));

  async function create(key: string): Promise<Dto> {
    const res = await flows("POST", `/${key}/create`, { waba_id: WABA });
    expect(res.status).toBe(201);
    return data(res);
  }
  async function publish(dto: Dto): Promise<Dto> {
    const res = await flows("POST", `/${dto.id}/publish`, { confirm_title: dto.title });
    expect(res.status).toBe(200);
    return data(res);
  }
  const live = async (key: string): Promise<Dto> => publish(await create(key));

  const sign = (raw: string): string => "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  async function postWebhook(messages: unknown[], from: string): Promise<void> {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "2348000000700", phone_number_id: WA_NUMBER_ID },
                contacts: [{ profile: { name: "Test Customer" }, wa_id: from }],
                messages,
              },
            },
          ],
        },
      ],
    });
    const res = await fetch(`${baseUrl}/v1/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) }, body: raw });
    expect(res.status).toBe(200);
  }
  /** A customer writes in, which opens a conversation with the 24-hour window open (unless `agoHours` is 25 or more). */
  async function newChat(agoHours = 0): Promise<{ from: string; conversationId: string; customerId: string }> {
    const from = `23470555${String(++phoneSeq).padStart(5, "0")}`;
    const wamid = `wamid.flow.in.${++inSeq}`;
    await postWebhook([{ from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000) - agoHours * 3600), type: "text", text: { body: "Hello" } }], from);
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, wamid));
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, msg!.conversationId));
    return { from, conversationId: conv!.id, customerId: conv!.customerId };
  }
  async function answer(from: string, responseJson: unknown, contextId?: string): Promise<string> {
    const wamid = `wamid.flow.in.${++inSeq}`;
    await postWebhook(
      [
        {
          from,
          id: wamid,
          // One second apart, so the timeline order is the order of arrival.
          timestamp: String(Math.floor(Date.now() / 1000) + inSeq),
          type: "interactive",
          ...(contextId ? { context: { from: "2348000000700", id: contextId } } : {}),
          interactive: { type: "nfm_reply", nfm_reply: { name: "flow", body: "Sent", response_json: typeof responseJson === "string" ? responseJson : JSON.stringify(responseJson) } },
        },
      ],
      from,
    );
    return wamid;
  }
  const responsesOf = async (conversationId: string) => db.select().from(waFlowResponse).where(eq(waFlowResponse.conversationId, conversationId)).orderBy(waFlowResponse.createdAt);
  const sendForm = (conversationId: string, body: unknown, cookie = owner) => call("POST", `/v1/inbox/conversations/${conversationId}/flows`, body, cookie);
  const act = (id: string, action: string, cookie = owner) => call("POST", `/v1/inbox/flow-responses/${id}/action`, { action }, cookie);
  type TimelineMsg = {
    id: string;
    type: string;
    direction: string;
    body: string | null;
    flow_sent: { title: string; cta: string } | null;
    flow_response: { id: string; flow_key: string; status: string; handled_by_name: string | null; handled_at: string | null; title: string; rows: { label: string; value: string }[] } | null;
  };
  async function timeline(conversationId: string, cookie = owner): Promise<TimelineMsg[]> {
    const res = await call("GET", `/v1/inbox/conversations/${conversationId}/timeline`, undefined, cookie);
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { data: { kind: string; data: TimelineMsg }[] }).data;
    return items.filter((i) => i.kind === "message").map((i) => i.data);
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = "itest-verify";
    process.env.META_SYSTEM_USER_TOKEN = "itest-token";
    process.env.META_GRAPH_VERSION = "v23.0";
    installGraphStub();
    await seedOwner(db);
    await seedUser(db, { email: "manager@example.com", role: "manager" });
    // Sees and answers every chat, but may not manage templates and forms.
    await seedUser(db, { email: "agent@example.com", role: "branch_staff", granted: ["inbox.view", "inbox.view_all", "inbox.reply", "inbox.notes"] });
    // Has the inbox but no line: every chat is hidden from them.
    await seedUser(db, { email: "stranger@example.com", role: "branch_staff", granted: ["inbox.view", "inbox.reply"] });
    await db.insert(inboxPhoneNumber).values({ e164: "+2348000000700", label: "Main line", channels: "whatsapp", wabaId: WABA, waPhoneNumberId: WA_NUMBER_ID });

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    manager = await loginAs(baseUrl, "manager@example.com", "userpassword123");
    agent = await loginAs(baseUrl, "agent@example.com", "userpassword123");
    stranger = await loginAs(baseUrl, "stranger@example.com", "userpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  beforeEach(async () => {
    // Each test starts with no forms at "Meta" or here. Answers already stored keep their form name.
    await db.delete(waFlow);
    store.clear();
    calls = [];
    mode = { create: "ok", publish: "ok", lockPublished: true, send: "ok" };
  });

  // ── Managing forms ──

  it("management routes need templates.manage", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const routes: [string, string, unknown?][] = [
      ["GET", "/"],
      ["POST", "/delivery_address/create", { waba_id: WABA }],
      ["POST", `/${id}/upload`],
      ["POST", `/${id}/new-version`],
      ["GET", `/${id}/preview`],
      ["POST", `/${id}/publish`, { confirm_title: "Delivery address" }],
      ["POST", `/${id}/retire`, { confirm_title: "Delivery address" }],
      ["POST", `/${id}/delete-draft`],
      ["POST", "/sync"],
    ];
    for (const who of [manager, agent]) {
      for (const [method, path, body] of routes) {
        const res = await flows(method, path, body, who);
        expect(res.status, `${method} ${path}`).toBe(403);
      }
    }
    expect((await fetch(`${baseUrl}/v1/wa-flows`)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("the list shows the four built-in forms as not created, without calling Meta", async () => {
    const res = await flows("GET", "/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Dto[]; any_live: boolean };
    expect(body.data.map((d) => d.key)).toEqual(["delivery_address", "bulk_order", "complaint", "pickup_request"]);
    expect(body.data.every((d) => d.state === "not_created" && d.id === null)).toBe(true);
    expect(body.any_live).toBe(false);
    expect(calls).toHaveLength(0);
    // The live slot picker is Phase B: hidden until the server holds its key.
    expect(body.data.some((d) => d.key === "delivery_slot")).toBe(false);
  });

  it("create stores the Meta id, hash and validation errors, and never asks Meta to publish", async () => {
    mode.create = "invalid";
    const dto = await create("delivery_address");
    expect(dto).toMatchObject({ key: "delivery_address", version: 1, meta_name: "ms_delivery_address", status: "DRAFT", state: "draft_invalid", code_is_newer: false });
    expect(dto.validation_errors).toEqual([{ error: "INVALID_PROPERTY", error_type: "FLOW_JSON_ERROR", message: "The label is too long.", line_start: 12, column_start: 5 }]);
    const row = await rowOf(dto.id!);
    expect(row.metaFlowId).toBe(dto.meta_flow_id);
    expect(row.uploadedHash).toBe(flowJsonHash("delivery_address"));
    expect(row.jsonVersion).toBe("7.3");
    expect(row.publishedAt).toBeNull();
    expect(row.usesEndpoint).toBe(false);

    const posts = metaCalls("POST", `${WABA}/flows`);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ name: "ms_delivery_address", categories: ["OTHER"], flow_json: flowJsonText("delivery_address") });
    expect("publish" in posts[0]!.body!).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/publish"))).toBe(false);
    expect(store.get(dto.meta_flow_id!)!.status).toBe("DRAFT");
    expect(await audits("wa_flow.create", dto.id!)).toHaveLength(1);

    // A second create while a draft exists is refused before Meta is asked.
    calls = [];
    const again = await flows("POST", "/delivery_address/create", { waba_id: WABA });
    expect(again.status).toBe(409);
    expect((await err(again)).details?.reason).toBe("draft_exists");
    expect(calls).toHaveLength(0);

    // An unknown form or account.
    expect((await flows("POST", "/nope/create", { waba_id: WABA })).status).toBe(404);
    expect((await flows("POST", "/complaint/create", { waba_id: "WABA-OTHER" })).status).toBe(400);
  });

  it("a name clash at Meta shows the plain message and creates no row; a token refusal tells the owner once", async () => {
    mode.create = "name-clash";
    const clash = await flows("POST", "/complaint/create", { waba_id: WABA });
    expect(clash.status).toBe(409);
    expect((await err(clash)).message).toBe("WhatsApp refused this: Flow with the same name already exists (Meta 100)");
    expect(await db.select().from(waFlow)).toHaveLength(0);

    mode.create = "token";
    const before = (await db.select().from(outboxEvent).where(sql`${outboxEvent.payload}->>'account' = 'whatsapp_flows'`)).length;
    for (let i = 0; i < 2; i++) {
      const refused = await flows("POST", "/complaint/create", { waba_id: WABA });
      expect(refused.status).toBe(409);
      expect((await err(refused)).message).toBe("WhatsApp would not let us in. The connection needs fixing by the technical lead.");
    }
    const alerts = await db.select().from(outboxEvent).where(sql`${outboxEvent.payload}->>'account' = 'whatsapp_flows'`);
    expect(alerts.length - before).toBeLessThanOrEqual(1);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]!.eventType).toBe("inbox.meta_config");
    expect(await db.select().from(waFlow)).toHaveLength(0);
  });

  it("a create that timed out but did reach Meta is found by name, with Upload again offered", async () => {
    mode.create = "timeout-created";
    const res = await flows("POST", "/pickup_request/create", { waba_id: WABA });
    expect(res.status).toBe(201);
    const dto = await data(res);
    expect(dto.meta_flow_id).toBe([...store.keys()][0]);
    expect(dto.code_is_newer).toBe(true);
    expect((await rowOf(dto.id!)).uploadedHash).toBeNull();
    mode.create = "ok";
    const up = await flows("POST", `/${dto.id}/upload`);
    expect(up.status).toBe(200);
    expect((await data(up)).code_is_newer).toBe(false);
  });

  it("publish is refused with errors, with a stale upload, and with the wrong name; succeeds and reads back", async () => {
    mode.create = "invalid";
    const bad = await create("complaint");
    const withErrors = await flows("POST", `/${bad.id}/publish`, { confirm_title: "Report a problem" });
    expect(withErrors.status).toBe(409);
    expect((await err(withErrors)).details?.reason).toBe("validation_errors");

    mode.create = "ok";
    const dto = await create("delivery_address");
    const wrongName = await flows("POST", `/${dto.id}/publish`, { confirm_title: "delivery address please" });
    expect(wrongName.status).toBe(400);

    await db.update(waFlow).set({ uploadedHash: "0".repeat(64) }).where(eq(waFlow.id, dto.id!));
    const stale = await flows("POST", `/${dto.id}/publish`, { confirm_title: "Delivery address" });
    expect(stale.status).toBe(409);
    expect((await err(stale)).message).toBe("Upload the latest version first.");
    expect(calls.some((c) => c.path.endsWith("/publish"))).toBe(false);

    // Upload again brings the hash back in line.
    expect((await flows("POST", `/${dto.id}/upload`)).status).toBe(200);
    calls = [];
    const res = await flows("POST", `/${dto.id}/publish`, { confirm_title: "Delivery address" });
    expect(res.status).toBe(200);
    const done = await data(res);
    expect(done).toMatchObject({ status: "PUBLISHED", state: "live", only_live_version: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${dto.meta_flow_id}/publish`, `GET ${dto.meta_flow_id}`]);
    const row = await rowOf(dto.id!);
    expect(row.publishedHash).toBe(flowJsonHash("delivery_address"));
    expect(row.publishedBy).not.toBeNull();
    expect(row.publishedAt).not.toBeNull();
    const audit = await audits("wa_flow.publish", dto.id!);
    expect(audit).toHaveLength(1);
    expect((audit[0]!.afterJson as { result: string }).result).toBe("published");
    expect(((await (await flows("GET", "/")).json()) as { any_live: boolean }).any_live).toBe(true);

    // Publishing twice is refused.
    expect((await flows("POST", `/${dto.id}/publish`, { confirm_title: "Delivery address" })).status).toBe(409);
  });

  it("a refused publish keeps the draft and shows Meta's reason; a publish that does not take says so", async () => {
    const dto = await create("bulk_order");
    mode.publish = "unverified";
    const refused = await flows("POST", `/${dto.id}/publish`, { confirm_title: "Bulk-order enquiry" });
    expect(refused.status).toBe(409);
    expect((await err(refused)).message).toBe("WhatsApp refused this: Business must be verified to publish a flow (Meta 139002)");
    const row = await rowOf(dto.id!);
    expect(row.status).toBe("DRAFT");
    expect(row.lastError).toContain("Business must be verified");

    mode.publish = "stays-draft";
    const res = await flows("POST", `/${dto.id}/publish`, { confirm_title: "Bulk-order enquiry" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Dto; notice?: string };
    expect(body.data.status).toBe("DRAFT");
    expect(body.notice).toContain("not showing as live yet");
    expect((await rowOf(dto.id!)).publishedAt).toBeNull();
  });

  it("upload on a live form that Meta refuses returns published_locked; new-version makes version 2 with the _v2 name", async () => {
    const v1 = await live("delivery_address");
    const locked = await flows("POST", `/${v1.id}/upload`);
    expect(locked.status).toBe(409);
    const e = await err(locked);
    expect(e.details?.reason).toBe("published_locked");
    expect(e.message).toBe("WhatsApp will not change a form that is already live. Make a new copy instead.");
    expect((await rowOf(v1.id!)).status).toBe("PUBLISHED");

    const res = await flows("POST", `/${v1.id}/new-version`);
    expect(res.status).toBe(201);
    const v2 = await data(res);
    expect(v2).toMatchObject({ version: 2, meta_name: "ms_delivery_address_v2", status: "DRAFT", state: "draft_ready" });
    expect(metaCalls("POST", `${WABA}/flows`).at(-1)!.body!.name).toBe("ms_delivery_address_v2");
    // The old version stays live until the new one is published; both have a card.
    expect((await rowOf(v1.id!)).status).toBe("PUBLISHED");
    const list = (await data<Dto[]>(await flows("GET", "/"))).filter((d) => d.key === "delivery_address");
    expect(list.map((d) => [d.version, d.state])).toEqual([
      [2, "draft_ready"],
      [1, "live"],
    ]);

    // With the new one live, the old one is no longer the only live version.
    await publish(v2);
    const retire = await flows("POST", `/${v1.id}/retire`, { confirm_title: "Delivery address" });
    expect(retire.status).toBe(200);
    expect((await data(retire)).state).toBe("retired");
  });

  it("when Meta accepts a change to a live form it goes back to Draft and must be published again (rule 9)", async () => {
    const v1 = await live("complaint");
    mode.lockPublished = false;
    const res = await flows("POST", `/${v1.id}/upload`);
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ status: "DRAFT", state: "draft_ready" });
  });

  it("retire needs force when it is the only live version", async () => {
    const dto = await live("pickup_request");
    expect((await flows("POST", `/${dto.id}/retire`, { confirm_title: "wrong" })).status).toBe(400);
    const refused = await flows("POST", `/${dto.id}/retire`, { confirm_title: "Pickup request" });
    expect(refused.status).toBe(409);
    const e = await err(refused);
    expect(e.details?.reason).toBe("only_live");
    expect(e.message).toContain("This is the only live version.");
    expect(calls.some((c) => c.path.endsWith("/deprecate"))).toBe(false);

    const res = await flows("POST", `/${dto.id}/retire?force=1`, { confirm_title: "Pickup request" });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ status: "DEPRECATED", state: "retired" });
    expect(store.get(dto.meta_flow_id!)!.status).toBe("DEPRECATED");
    expect((await rowOf(dto.id!)).retiredAt).not.toBeNull();
    expect(await audits("wa_flow.retire", dto.id!)).toHaveLength(1);
    // A retired form cannot be uploaded, published or retired again; a new copy is version 2.
    expect((await flows("POST", `/${dto.id}/upload`)).status).toBe(409);
    expect((await flows("POST", `/${dto.id}/publish`, { confirm_title: "Pickup request" })).status).toBe(409);
    expect((await data(await flows("POST", `/${dto.id}/new-version`))).meta_name).toBe("ms_pickup_request_v2");
  });

  it("only a draft can be deleted, at Meta and here; preview returns Meta's link; sync follows Meta and never creates rows", async () => {
    const draft = await create("complaint");
    const p = await flows("GET", `/${draft.id}/preview`);
    expect(p.status).toBe(200);
    expect(await data<{ url: string; expires_at: string }>(p)).toEqual({
      url: `https://business.facebook.com/wa/manage/flows/${draft.meta_flow_id}/preview/?token=abc`,
      expires_at: "2026-12-20T00:00:00+0000",
    });
    expect(calls.at(-1)!.query.get("fields")).toBe("preview.invalidate(false)");
    await flows("GET", `/${draft.id}/preview?fresh=1`);
    expect(calls.at(-1)!.query.get("fields")).toBe("preview.invalidate(true)");

    const liveOne = await live("bulk_order");
    expect((await flows("POST", `/${liveOne.id}/delete-draft`)).status).toBe(409);

    // Meta blocks the live one and holds a form we never made: sync updates ours and adds nothing.
    store.get(liveOne.meta_flow_id!)!.status = "BLOCKED";
    store.set("777", { id: "777", name: "made_elsewhere", status: "DRAFT", categories: ["OTHER"], json: "{}", validation_errors: [] });
    const sync = await flows("POST", "/sync");
    expect(sync.status).toBe(200);
    expect(await data<{ synced: number }>(sync)).toEqual({ synced: 2 });
    expect((await rowOf(liveOne.id!)).status).toBe("BLOCKED");
    expect(await db.select().from(waFlow)).toHaveLength(2);
    expect((await data<Dto[]>(await flows("GET", "/"))).find((d) => d.key === "bulk_order")!.state).toBe("blocked");

    const del = await flows("POST", `/${draft.id}/delete-draft`);
    expect(del.status).toBe(200);
    expect(store.has(draft.meta_flow_id!)).toBe(false);
    expect(await db.select().from(waFlow).where(eq(waFlow.id, draft.id!))).toHaveLength(0);
    expect(await audits("wa_flow.delete", draft.id!)).toHaveLength(1);
  });

  // ── Sending a form in a chat ──

  it("send: refused outside the window, refused when not live, sends flow_id, cta, token and mode, stores payload.flow", async () => {
    const chat = await newChat();
    // Not created yet, then only a draft: not live.
    const none = await sendForm(chat.conversationId, { flow_key: "delivery_address" });
    expect(none.status).toBe(409);
    expect((await err(none)).message).toBe("This form is not live at WhatsApp yet. Ask an admin to publish it under Templates and forms.");
    const draft = await create("delivery_address");
    expect((await sendForm(chat.conversationId, { flow_key: "delivery_address" })).status).toBe(409);
    expect((await sendForm(chat.conversationId, { flow_key: "nope" })).status).toBe(400);
    expect(metaCalls("POST", `${WA_NUMBER_ID}/messages`)).toHaveLength(0);

    const dto = await publish(draft);
    // Outside the 24 hours: refused on our side, Meta is not called.
    const old = await newChat(30);
    const closed = await sendForm(old.conversationId, { flow_key: "delivery_address" });
    expect(closed.status).toBe(409);
    expect((await err(closed)).details?.reason).toBe("window_closed");
    expect(metaCalls("POST", `${WA_NUMBER_ID}/messages`)).toHaveLength(0);

    const res = await sendForm(chat.conversationId, { flow_key: "delivery_address", message: "  Where shall we bring it?  " }, agent);
    expect(res.status).toBe(201);
    const msg = await data<{ id: string; type: string; body: string; status: string; payload: { flow: Record<string, unknown> } }>(res);
    expect(msg).toMatchObject({ type: "flow", body: "Where shall we bring it?", status: "sent" });
    const sent = metaCalls("POST", `${WA_NUMBER_ID}/messages`);
    expect(sent).toHaveLength(1);
    const interactive = sent[0]!.body!.interactive as { type: string; body: { text: string }; action: { name: string; parameters: Record<string, unknown> } };
    expect(sent[0]!.body).toMatchObject({ messaging_product: "whatsapp", to: chat.from, type: "interactive" });
    expect(interactive.type).toBe("flow");
    expect(interactive.body.text).toBe("Where shall we bring it?");
    const params = interactive.action.parameters;
    expect(params).toMatchObject({
      flow_message_version: "3",
      flow_id: dto.meta_flow_id,
      flow_cta: "Add address",
      flow_action: "navigate",
      flow_action_payload: { screen: "ADDRESS" },
      mode: "published",
    });
    const token = String(params.flow_token);
    expect(readFlowToken(process.env.JWT_SIGNING_KEY!, token, new Date())).toEqual({ ok: true, key: "delivery_address", conversationId: chat.conversationId });
    expect(msg.payload.flow).toEqual({ key: "delivery_address", flow_row_id: dto.id, token, title: "Delivery address", cta: "Add address" });
    const audit = await audits("inbox.flow_send", chat.conversationId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.afterJson).toMatchObject({ flow_key: "delivery_address", message_id: msg.id });

    // With no message of their own, the form's default message goes.
    await sendForm(chat.conversationId, { flow_key: "delivery_address" });
    const second = metaCalls("POST", `${WA_NUMBER_ID}/messages`)[1]!.body!.interactive as { body: { text: string } };
    expect(second.body.text).toBe("Please tap the button and fill in your delivery address. It takes about a minute.");

    // The picker's list.
    type Pick = { key: string; live: boolean; testable: boolean; cta: string };
    const picks = await data<Pick[]>(await call("GET", `/v1/inbox/flows?conversation_id=${chat.conversationId}`, undefined, agent));
    expect(picks.map((x) => x.key)).toEqual(["delivery_address", "bulk_order", "complaint", "pickup_request"]);
    expect(picks.find((x) => x.key === "delivery_address")).toMatchObject({ live: true, testable: true, cta: "Add address" });
    expect(picks.find((x) => x.key === "complaint")).toMatchObject({ live: false, testable: false });

    // A hidden chat is 404; a Meta refusal is a failed message with plain words.
    expect((await sendForm(chat.conversationId, { flow_key: "delivery_address" }, stranger)).status).toBe(404);
    mode.send = "blocked";
    const blocked = await sendForm(chat.conversationId, { flow_key: "delivery_address" });
    expect(blocked.status).toBe(502);
    const failed = await data<{ status: string; errorCode: string; errorMessage: string; payload: { flow: { key: string } } }>(blocked);
    expect(failed).toMatchObject({ status: "failed", errorCode: "132068", errorMessage: "WhatsApp has blocked this form because of errors. It cannot be sent until that is fixed." });
    expect(failed.payload.flow.key).toBe("delivery_address");
  });

  it("send as a test uses mode draft and needs templates.manage", async () => {
    const chat = await newChat();
    const draft = await create("complaint");
    const denied = await sendForm(chat.conversationId, { flow_key: "complaint", test: true }, agent);
    expect(denied.status).toBe(403);
    expect(metaCalls("POST", `${WA_NUMBER_ID}/messages`)).toHaveLength(0);

    const res = await sendForm(chat.conversationId, { flow_key: "complaint", test: true });
    expect(res.status).toBe(201);
    const params = (metaCalls("POST", `${WA_NUMBER_ID}/messages`)[0]!.body!.interactive as { action: { parameters: Record<string, unknown> } }).action.parameters;
    expect(params).toMatchObject({ flow_id: draft.meta_flow_id, mode: "draft", flow_cta: "Report a problem", flow_action_payload: { screen: "PROBLEM" } });

    // Once it is live, a test goes out as published.
    await publish(draft);
    await sendForm(chat.conversationId, { flow_key: "complaint", test: true });
    const again = (metaCalls("POST", `${WA_NUMBER_ID}/messages`)[1]!.body!.interactive as { action: { parameters: Record<string, unknown> } }).action.parameters;
    expect(again.mode).toBe("published");
    // A test of a form that is not at WhatsApp at all is refused.
    expect((await sendForm(chat.conversationId, { flow_key: "bulk_order", test: true })).status).toBe(409);
  });

  // ── A form outside the 24 hours: a template with a form button (5.5a) ──

  const formTemplate = (name: string, flowId: unknown, extra: unknown[] = []) => ({
    wabaId: WABA,
    name,
    language: "en",
    status: "APPROVED",
    category: "UTILITY",
    components: [
      { type: "BODY", text: "Tap the button to tell us where to deliver your order." },
      { type: "BUTTONS", buttons: [...extra, { type: "FLOW", text: "Add address", ...(flowId === undefined ? {} : { flow_id: flowId }), flow_action: "navigate", navigate_screen: "ADDRESS" }] },
    ],
  });
  const sendTemplate = (conversationId: string, name: string, cookie = owner) =>
    call("POST", `/v1/inbox/conversations/${conversationId}/messages`, { type: "template", name, language: "en" }, cookie);

  it("a template with a form button sends outside the window with a token, and its answer is matched to the form", async () => {
    const dto = await live("delivery_address");
    await db.delete(inboxTemplate);
    await db.insert(inboxTemplate).values(formTemplate("address_request", dto.meta_flow_id, [{ type: "QUICK_REPLY", text: "Not now" }]));
    const chat = await newChat(30); // the customer last wrote 30 hours ago

    // The picker now offers it.
    const list = await data<{ name: string; sendable: boolean; unsendable_reason: string | null }[]>(await call("GET", "/v1/inbox/templates"));
    expect(list.find((t) => t.name === "address_request")).toMatchObject({ sendable: true, unsendable_reason: null });

    const res = await sendTemplate(chat.conversationId, "address_request");
    expect(res.status).toBe(201);
    const msg = await data<{ id: string; type: string; waMessageId: string; payload: { flow: Record<string, unknown> } }>(res);
    const sent = metaCalls("POST", `${WA_NUMBER_ID}/messages`);
    expect(sent).toHaveLength(1);
    const template = sent[0]!.body!.template as { name: string; components: { type: string; sub_type: string; index: string; parameters: { type: string; action: { flow_token: string } }[] }[] };
    expect(sent[0]!.body!.type).toBe("template");
    expect(template.name).toBe("address_request");
    expect(template.components).toHaveLength(1);
    expect(template.components[0]).toMatchObject({ type: "button", sub_type: "flow", index: "1" });
    const token = template.components[0]!.parameters[0]!.action.flow_token;
    expect(template.components[0]!.parameters).toEqual([{ type: "action", action: { flow_token: token } }]);
    expect(readFlowToken(process.env.JWT_SIGNING_KEY!, token, new Date())).toEqual({ ok: true, key: "delivery_address", conversationId: chat.conversationId });
    expect(msg.type).toBe("template");
    expect(msg.payload.flow).toEqual({ key: "delivery_address", flow_row_id: dto.id, token, title: "Delivery address", cta: "Add address" });

    // The customer completes the form: matched through context.id even with no flow_key in the answer.
    await answer(chat.from, { flow_token: token, street: "12 Example Street", area: "ajah" }, msg.waMessageId);
    const [resp] = await responsesOf(chat.conversationId);
    expect(resp).toMatchObject({ flowKey: "delivery_address", flowId: dto.id, requestMessageId: msg.id });
  });

  it("a template whose form is unknown or not live is refused before Meta is called", async () => {
    const draft = await create("delivery_address");
    await db.delete(inboxTemplate);
    await db.insert(inboxTemplate).values([
      formTemplate("form_unknown", "4040404"),
      formTemplate("form_unlisted", undefined),
      formTemplate("form_draft", draft.meta_flow_id),
      formTemplate("form_twice", draft.meta_flow_id, [{ type: "FLOW", text: "Again", flow_id: draft.meta_flow_id }]),
    ]);
    const chat = await newChat();
    for (const name of ["form_unknown", "form_unlisted"]) {
      const res = await sendTemplate(chat.conversationId, name);
      expect(res.status, name).toBe(409);
      const e = await err(res);
      expect(e.details?.reason).toBe("template_unsupported");
      expect(e.message).toBe("This template opens a form the suite does not know. Sync forms under Templates and forms, or use another template.");
    }
    const notLive = await sendTemplate(chat.conversationId, "form_draft");
    expect(notLive.status).toBe(409);
    expect((await err(notLive)).message).toBe("The form behind this template is not live at WhatsApp.");
    const twice = await sendTemplate(chat.conversationId, "form_twice");
    expect(twice.status).toBe(409);
    expect((await err(twice)).message).toBe("This template has more than one form button, which the inbox can't send yet");
    expect(metaCalls("POST", `${WA_NUMBER_ID}/messages`)).toHaveLength(0);
    // No message row was written for any of them.
    expect(await db.select().from(inboxMessage).where(and(eq(inboxMessage.conversationId, chat.conversationId), eq(inboxMessage.direction, "out")))).toHaveLength(0);
    await db.delete(inboxTemplate);
  });

  it("the template editor accepts a form button: it submits Meta's shape and the template opens for editing again", async () => {
    const tpl = (method: string, path: string, body?: unknown) => call(method, `/v1/templates${path}`, body);
    const draft = {
      category: "UTILITY",
      header: null,
      body: { text: "Hello {{1}}, please tap the button below and tell us where to deliver your order today.", examples: ["Ada"] },
      footer: "",
      buttons: [{ type: "FLOW", text: "Add address", flowKey: "delivery_address" }],
    };
    await db.delete(inboxTemplate);
    const made = await tpl("POST", "", { waba_id: WABA, name: "address_form_request", language: "en", draft });
    expect(made.status).toBe(201);
    const row = await data<{ id: string; draft_updated_at: string }>(made);

    // The form is not live yet: refused before Meta is asked, and the draft is untouched.
    const early = await tpl("POST", `/${row.id}/submit`, { draft_updated_at: row.draft_updated_at, accept_warnings: true });
    expect(early.status).toBe(409);
    expect((await err(early)).details?.reason).toBe("form_not_live");
    expect(metaCalls("POST", `${WABA}/message_templates`)).toHaveLength(0);

    const dto = await live("delivery_address");
    // "Meta" for the template calls of this one test.
    const real = globalThis.fetch;
    let created: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.includes(`/${WABA}/message_templates`) && init?.method === "POST") {
        created = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ id: "TPL-1", status: "PENDING", category: "UTILITY" });
      }
      if (href.includes("/TPL-1")) return json({ id: "TPL-1", name: "address_form_request", language: "en", status: "APPROVED", category: "UTILITY", components: created?.components });
      return real(input, init);
    }) as typeof fetch;
    try {
      const res = await tpl("POST", `/${row.id}/submit`, { draft_updated_at: row.draft_updated_at, accept_warnings: true });
      expect(res.status).toBe(200);
      const after = await data<{ status: string; editable: boolean; flow_keys: Record<string, string>; components: { type: string; buttons?: unknown[] }[] }>(res);
      const buttons = (created!.components as { type: string; buttons?: unknown[] }[]).find((c) => c.type === "BUTTONS")!.buttons;
      expect(buttons).toEqual([{ type: "FLOW", text: "Add address", flow_id: dto.meta_flow_id, flow_action: "navigate", navigate_screen: "ADDRESS" }]);
      expect(after).toMatchObject({ status: "APPROVED", editable: true, flow_keys: { [dto.meta_flow_id!]: "delivery_address" } });
    } finally {
      globalThis.fetch = real;
    }
    // Two form buttons, or one with no form chosen, are validation errors.
    const bad = await tpl("POST", "", { waba_id: WABA, name: "two_forms", language: "en", draft: { ...draft, buttons: [draft.buttons[0], { type: "FLOW", text: "Other", flowKey: "" }] } });
    const badRow = await data<{ id: string; draft_updated_at: string }>(bad);
    const refused = await tpl("POST", `/${badRow.id}/submit`, { draft_updated_at: badRow.draft_updated_at, accept_warnings: true });
    expect(refused.status).toBe(400);
    const problems = ((await refused.json()) as { error: { details: { problems: { code: string }[] } } }).error.details.problems.map((x) => x.code);
    expect(problems).toEqual(expect.arrayContaining(["flow_count", "flow_missing"]));
    // A template whose form we no longer hold is read-only, with a plain reason.
    await db.delete(waFlow);
    const orphan = await data<{ editable: boolean; not_editable_reason: string | null }>(await tpl("GET", `/${row.id}`));
    expect(orphan).toEqual(expect.objectContaining({ editable: false, not_editable_reason: "This template opens a form the suite does not know. Change it in WhatsApp Manager." }));
    await db.delete(inboxTemplate);
  });

  // ── Answers ──

  it("an nfm_reply webhook stores one response, sets the message body, adds the label, and a replay adds nothing", async () => {
    const chat = await newChat();
    const dto = await live("delivery_address");
    const sent = await data<{ id: string; waMessageId: string }>(await sendForm(chat.conversationId, { flow_key: "delivery_address" }));
    const responseJson = {
      flow_token: "unused",
      flow_key: "delivery_address",
      receiver_name: "Test Receiver",
      receiver_phone: "08000000000",
      street: "12 Example Street",
      area: "lekki",
      landmark: "",
      note: "Blue gate\nSecond floor",
    };
    const wamid = await answer(chat.from, responseJson, sent.waMessageId);

    const rows = await responsesOf(chat.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ flowKey: "delivery_address", flowId: dto.id, requestMessageId: sent.id, status: "new", flowToken: "unused" });
    expect(rows[0]!.data).toEqual({ receiver_name: "Test Receiver", receiver_phone: "08000000000", street: "12 Example Street", area: "lekki", landmark: "", note: "Blue gate\nSecond floor" });
    const [msg] = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, wamid));
    expect(msg).toMatchObject({ type: "interactive", body: "Completed form: Delivery address", direction: "in" });
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, chat.conversationId));
    expect(conv!.labels).toEqual(["delivery-address"]);
    expect(conv!.lastPreview).toBe("Completed form: Delivery address");
    // Ingestion never changes the customer (foundation D2, rule 14).
    const [cust] = await db.select().from(customer).where(eq(customer.id, chat.customerId));
    expect(cust!.defaultAddress).toBeNull();

    // The same webhook again, and a second answer: no duplicate, the label is not added twice.
    await postWebhook(
      [{ from: chat.from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify(responseJson) } } }],
      chat.from,
    );
    expect(await responsesOf(chat.conversationId)).toHaveLength(1);
    await answer(chat.from, responseJson, sent.waMessageId);
    expect(await responsesOf(chat.conversationId)).toHaveLength(2);
    const [after] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, chat.conversationId));
    expect(after!.labels).toEqual(["delivery-address"]);
    // Nothing was sent back to the customer on its own.
    expect(metaCalls("POST", `${WA_NUMBER_ID}/messages`)).toHaveLength(1);
  });

  it("the response is matched to the form through context.id, then flow_key, then the token", async () => {
    const chat = await newChat();
    await live("pickup_request");
    const sent = await data<{ id: string; waMessageId: string }>(await sendForm(chat.conversationId, { flow_key: "pickup_request" }));
    // 1. context.id wins even when the answer names another form.
    await answer(chat.from, { flow_key: "complaint", collector_name: "Test Person" }, sent.waMessageId);
    // 2. No context we know: flow_key.
    await answer(chat.from, { flow_key: "bulk_order", quantity: "40" }, "wamid.not.ours");
    // 3. Neither: the token's first part, when it is for this conversation.
    const token = makeFlowToken("any-secret-the-worker-does-not-hold", "complaint", chat.conversationId, new Date("2026-01-01T00:00:00Z"));
    await answer(chat.from, { flow_token: token, what_happened: "It was late" });
    // 4. A token for another conversation, and no token at all: unknown.
    const other = makeFlowToken("s", "complaint", "99999999-9999-4999-8999-999999999999", new Date());
    await answer(chat.from, { flow_token: other, a: "1" });
    await answer(chat.from, "{not json");

    const rows = await responsesOf(chat.conversationId);
    expect(rows.map((r) => r.flowKey)).toEqual(["pickup_request", "bulk_order", "complaint", "unknown", "unknown"]);
    expect(rows[0]!.requestMessageId).toBe(sent.id);
    expect(rows[1]!.requestMessageId).toBeNull();
    expect(rows[4]!.data).toEqual({ _raw: "{not json" });
    const bodies = (await timeline(chat.conversationId)).filter((m) => m.flow_response).map((m) => m.body);
    expect(bodies).toEqual(["Completed form: Pickup request", "Completed form: Bulk-order enquiry", "Completed form: Report a problem", "Completed form: Form", "Completed form: Form"]);
    // An unknown form adds no label (rule 7).
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, chat.conversationId));
    expect([...conv!.labels].sort()).toEqual(["bulk-order", "complaint", "pickup"]);
  });

  it("a complaint answer raises one owner alert", async () => {
    const chat = await newChat();
    const complaints = () => db.select().from(outboxEvent).where(and(eq(outboxEvent.eventType, "inbox.flow_complaint"), sql`${outboxEvent.payload}->>'conversation_id' = ${chat.conversationId}`));
    const wamid = await answer(chat.from, { flow_key: "complaint", problem_type: "late", what_happened: "It came two hours late", wanted: "call" });
    const alerts = await complaints();
    expect(alerts).toHaveLength(1);
    const [resp] = await responsesOf(chat.conversationId);
    // No customer details in the alert: only where to look.
    expect(alerts[0]!.payload).toEqual({ account: `flow_complaint:${resp!.id}`, conversation_id: chat.conversationId, response_id: resp!.id });
    // A replay raises nothing more; another form raises nothing.
    await postWebhook([{ from: chat.from, id: wamid, type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: "{}" } } }], chat.from);
    await answer(chat.from, { flow_key: "pickup_request", collector_name: "Test Person" });
    expect(await complaints()).toHaveLength(1);
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, chat.conversationId));
    expect(conv!.labels).toContain("complaint");
  });

  it("timeline returns flow_response rows and flow_sent", async () => {
    const chat = await newChat();
    await live("complaint");
    const sent = await data<{ id: string; waMessageId: string }>(await sendForm(chat.conversationId, { flow_key: "complaint" }));
    await answer(chat.from, { flow_token: "t", flow_key: "complaint", wanted: "refund", extra: "x", what_happened: "It leaked", problem_type: "damaged", order_number: "" }, sent.waMessageId);

    const items = await timeline(chat.conversationId, agent);
    const out = items.find((m) => m.id === sent.id)!;
    expect(out.flow_sent).toEqual({ title: "Report a problem", cta: "Report a problem" });
    expect(out.flow_response).toBeNull();
    const card = items.find((m) => m.flow_response)!;
    expect(card.flow_sent).toBeNull();
    expect(card.flow_response).toMatchObject({ flow_key: "complaint", status: "new", handled_by_name: null, handled_at: null, title: "Report a problem" });
    expect(card.flow_response!.rows.map((r) => [r.label, r.value])).toEqual([
      ["Problem", "Damaged or leaking"],
      ["What happened", "It leaked"],
      ["They would like", "A refund"],
      ["Other: extra", "x"],
    ]);
    // Ordinary messages carry neither.
    const plain = items.find((m) => m.type === "text")!;
    expect(plain.flow_sent).toBeNull();
    expect(plain.flow_response).toBeNull();
  });

  it("actions: handled, reopen, add_note, save_address (with before and after), each audited; a hidden conversation is 404", async () => {
    const chat = await newChat();
    await answer(chat.from, { flow_key: "delivery_address", receiver_name: "Test Receiver", street: "12 Example Street", area: "ikeja", landmark: "Opposite the park" });
    const [resp] = await responsesOf(chat.conversationId);
    const id = resp!.id;

    // Hidden, unknown and malformed.
    expect((await act(id, "handled", stranger)).status).toBe(404);
    expect((await act("11111111-1111-4111-8111-111111111111", "handled")).status).toBe(404);
    expect((await act("nope", "handled")).status).toBe(404);
    expect((await act(id, "delete")).status).toBe(400);
    // Someone who may only look cannot act.
    await seedUser(db, { email: "viewer@example.com", role: "branch_staff", granted: ["inbox.view", "inbox.view_all"] });
    const viewer = await loginAs(baseUrl, "viewer@example.com", "userpassword123");
    expect((await act(id, "handled", viewer)).status).toBe(403);

    expect((await act(id, "reopen")).status).toBe(409);
    const handled = await act(id, "handled", agent);
    expect(handled.status).toBe(200);
    expect(await data<{ status: string }>(handled)).toMatchObject({ status: "handled" });
    expect((await act(id, "handled")).status).toBe(409);
    let card = (await timeline(chat.conversationId)).find((m) => m.flow_response)!.flow_response!;
    expect(card).toMatchObject({ status: "handled", handled_by_name: "agent@example.com" });
    expect(card.handled_at).not.toBeNull();

    expect((await act(id, "reopen")).status).toBe(200);
    card = (await timeline(chat.conversationId)).find((m) => m.flow_response)!.flow_response!;
    expect(card).toMatchObject({ status: "new", handled_by_name: null, handled_at: null });

    const note = await act(id, "add_note", agent);
    expect(note.status).toBe(200);
    const notes = await db.select().from(inboxNote).where(eq(inboxNote.conversationId, chat.conversationId));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe("Delivery address\nReceiver: Test Receiver\nHouse and street: 12 Example Street\nArea: Ikeja\nLandmark: Opposite the park");

    await db.update(customer).set({ defaultAddress: "1 Old Road" }).where(eq(customer.id, chat.customerId));
    const save = await act(id, "save_address");
    expect(save.status).toBe(200);
    expect(await data<{ before: string | null; after: string }>(save)).toMatchObject({ before: "1 Old Road", after: "12 Example Street, Ikeja. Landmark: Opposite the park" });
    const [cust] = await db.select().from(customer).where(eq(customer.id, chat.customerId));
    expect(cust!.defaultAddress).toBe("12 Example Street, Ikeja. Landmark: Opposite the park");

    const [after] = await responsesOf(chat.conversationId);
    expect(after!.actions.map((a) => a.action)).toEqual(["handled", "reopen", "add_note", "save_address"]);
    const audit = await audits("inbox.flow_response_action", id);
    expect(audit).toHaveLength(4);
    const saved = audit.find((a) => (a.afterJson as { action: string }).action === "save_address")!;
    expect(saved.beforeJson).toEqual({ default_address: "1 Old Road" });
    expect(saved.afterJson).toMatchObject({ default_address: "12 Example Street, Ikeja. Landmark: Opposite the park" });

    // Only a delivery address can be saved to a contact.
    await answer(chat.from, { flow_key: "complaint", what_happened: "Late" });
    const other = (await responsesOf(chat.conversationId)).find((r) => r.flowKey === "complaint")!;
    expect((await act(other.id, "save_address")).status).toBe(409);
    // Nothing was sent to the customer by any action.
    expect(metaCalls("POST", `${WA_NUMBER_ID}/messages`)).toHaveLength(0);
  });

  it("erasing the customer deletes their form answers", async () => {
    const chat = await newChat();
    await live("delivery_address");
    const sent = await data<{ waMessageId: string }>(await sendForm(chat.conversationId, { flow_key: "delivery_address" }));
    await answer(chat.from, { flow_key: "delivery_address", street: "12 Example Street", area: "yaba" }, sent.waMessageId);
    await answer(chat.from, { flow_key: "complaint", what_happened: "Late" });
    const keep = await newChat();
    await answer(keep.from, { flow_key: "pickup_request", collector_name: "Another Person" });
    expect(await responsesOf(chat.conversationId)).toHaveLength(2);

    const res = await call("POST", `/v1/inbox/contacts/${chat.customerId}/erase`, { confirm: `+${chat.from}` });
    expect(res.status).toBe(200);
    expect(await data<{ form_answers: number; conversations: number }>(res)).toMatchObject({ form_answers: 2, conversations: 1 });
    expect(await responsesOf(chat.conversationId)).toHaveLength(0);
    expect(await db.select().from(inboxMessage).where(eq(inboxMessage.conversationId, chat.conversationId))).toHaveLength(0);
    // Someone else's answers are untouched.
    expect(await responsesOf(keep.conversationId)).toHaveLength(1);
  });

  it("merging two contacts keeps the form answers with the thread they are folded into", async () => {
    const a = await newChat();
    const b = await newChat();
    await answer(a.from, { flow_key: "pickup_request", collector_name: "Test Person" });
    await answer(b.from, { flow_key: "complaint", what_happened: "Late" });
    const res = await call("POST", `/v1/inbox/contacts/${a.customerId}/merge`, { into_customer_id: b.customerId });
    expect(res.status).toBe(200);
    expect(await db.select().from(inboxConversation).where(eq(inboxConversation.id, a.conversationId))).toHaveLength(0);
    const kept = await responsesOf(b.conversationId);
    expect(kept.map((r) => r.flowKey).sort()).toEqual(["complaint", "pickup_request"]);
    expect((await timeline(b.conversationId)).filter((m) => m.flow_response)).toHaveLength(2);
  });

  it("a deleted draft leaves earlier answers readable (they keep their form name)", async () => {
    const chat = await newChat();
    const draft = await create("bulk_order");
    const sent = await data<{ waMessageId: string }>(await sendForm(chat.conversationId, { flow_key: "bulk_order", test: true }));
    await answer(chat.from, { quantity: "25" }, sent.waMessageId);
    expect((await responsesOf(chat.conversationId))[0]).toMatchObject({ flowKey: "bulk_order", flowId: draft.id });
    expect((await flows("POST", `/${draft.id}/delete-draft`)).status).toBe(200);
    const [resp] = await responsesOf(chat.conversationId);
    expect(resp).toMatchObject({ flowKey: "bulk_order", flowId: null });
    expect((await timeline(chat.conversationId)).find((m) => m.flow_response)!.flow_response!.rows).toEqual([{ label: "Bottles", value: "25", kind: "text" }]);
  });

  it("no template is touched and nothing is published or sent on its own", async () => {
    await db.delete(inboxTemplate);
    await create("delivery_address");
    await flows("GET", "/");
    await flows("POST", "/sync");
    expect(calls.filter((c) => c.path.endsWith("/publish") || c.path.endsWith("/deprecate") || c.path.endsWith("/messages"))).toHaveLength(0);
    expect(await db.select().from(inboxTemplate)).toHaveLength(0);
  });
});

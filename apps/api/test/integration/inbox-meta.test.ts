import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  customer,
  inboxConversation,
  inboxIdentity,
  inboxMessage,
  inboxPhoneNumber,
  inboxTeam,
  inboxWebhookEvent,
} from "@ms/db";
import { clearPageTokenCache } from "@ms/domain";
import { setupTestDb, seedOwner } from "./helpers.js";

/**
 * Suite spec 02: Messenger and Instagram direct messages. A messenger line and
 * an instagram line are inserted directly. Graph API calls are stubbed; nothing
 * reaches Meta. Every ID below satisfies the routes' validators (Page and
 * Instagram IDs are digits, 5 to 25 long) and the inbox_phone_number shape
 * CHECK (non-phone rows have external_id and page_external_id).
 */

const APP_SECRET = "itest-meta-app-secret";
const SYSTEM_TOKEN = "itest-system-user-token";
const PAGE_TOKEN = "itest-page-token-XYZ";
const PAGE_ID = "100200300400";
const IG_ID = "17841400000000001";
const UNKNOWN_PAGE_ID = "100200300999";
const OUR_APP_ID = "900800700600";

// ── Graph stub ───────────────────────────────────────────────────────────────

type GraphCall = { method: string; url: string; auth: string | null; body: Record<string, unknown> | null };
const graphCalls: GraphCall[] = [];
/** Queue of Meta errors the next sends answer with (one per call). */
const sendErrors: { status: number; error: Record<string, unknown> }[] = [];
/** What GET {page}/subscribed_apps answers. */
let subscribedApps: { id: string; subscribed_fields: string[] }[] = [];
/** When set, POST {page}/subscribed_apps answers with this error. */
let subscribeError: { status: number; error: Record<string, unknown> } | null = null;
let midCounter = 0;

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://graph.facebook.com/")) return real(input, init);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    graphCalls.push({ method, url, auth, body });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const fail = (e: { status: number; error: Record<string, unknown> }) =>
      new Response(JSON.stringify({ error: e.error }), { status: e.status });
    const path = new URL(url).pathname.replace(/^\/v[\d.]+\//, "");
    if (url.includes("fields=access_token")) return ok({ access_token: PAGE_TOKEN, id: path });
    if (path.endsWith("/subscribed_apps")) {
      if (method === "POST") {
        if (subscribeError) return fail(subscribeError);
        const { searchParams } = new URL(url);
        subscribedApps = [{ id: OUR_APP_ID, subscribed_fields: (searchParams.get("subscribed_fields") ?? "").split(",") }];
        return ok({ success: true });
      }
      return ok({ data: subscribedApps });
    }
    if (path.endsWith("/messages") && method === "POST") {
      if (body?.sender_action) return ok({ recipient_id: (body.recipient as { id: string }).id });
      const err = sendErrors.shift();
      if (err) return fail(err);
      return ok({ recipient_id: (body?.recipient as { id: string }).id, message_id: `m_out_${++midCounter}` });
    }
    if (url.includes("fields=first_name")) return ok({ first_name: "Ada", last_name: "Obi", profile_pic: "https://cdn.example/ada.jpg" });
    if (url.includes("fields=name,username")) return ok({ name: "Bisi", username: "bisi_juice", profile_pic: null });
    if (url.includes("fields=name,instagram_business_account")) {
      return ok({ id: PAGE_ID, name: "Mrs Samuel fruit juice", instagram_business_account: { id: IG_ID, username: "mrs_samuelfruitjuice" } });
    }
    return ok({});
  }) as typeof fetch;
}

function sign(raw: string): string {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
}

// ── Payload builders ─────────────────────────────────────────────────────────

const PSID = "24000000000000001";
const IGSID = "980000000000000001";

function pageEvent(event: Record<string, unknown>, opts: { object?: "page" | "instagram"; entryId?: string; standby?: boolean } = {}) {
  const object = opts.object ?? "page";
  const entryId = opts.entryId ?? (object === "page" ? PAGE_ID : IG_ID);
  return {
    object,
    entry: [{ id: entryId, time: Date.now(), [opts.standby ? "standby" : "messaging"]: [event] }],
  };
}

function textEvent(o: { mid: string; text: string; from?: string; object?: "page" | "instagram"; ts?: number; extra?: Record<string, unknown> }) {
  const object = o.object ?? "page";
  const account = object === "page" ? PAGE_ID : IG_ID;
  return {
    sender: { id: o.from ?? (object === "page" ? PSID : IGSID) },
    recipient: { id: account },
    timestamp: o.ts ?? Date.now(),
    message: { mid: o.mid, text: o.text, ...(o.extra ?? {}) },
  };
}

describe("suite spec 02 — Messenger and Instagram direct messages", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let teamId: string;
  let messengerLineId: string;
  let instagramLineId: string;

  async function postWebhook(payload: unknown, signature?: string): Promise<Response> {
    const raw = JSON.stringify(payload);
    return fetch(`${baseUrl}/v1/webhooks/meta`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? sign(raw) },
      body: raw,
    });
  }

  async function messagesByMidPrefix(prefix: string) {
    return db
      .select()
      .from(inboxMessage)
      .where(sql`${inboxMessage.waMessageId} like ${prefix + "%"}`)
      .orderBy(inboxMessage.waMessageId);
  }

  async function conversationOf(messageId: string) {
    const [m] = await db.select().from(inboxMessage).where(eq(inboxMessage.id, messageId));
    const [c] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, m!.conversationId));
    return c!;
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = "itest-verify";
    process.env.META_SYSTEM_USER_TOKEN = SYSTEM_TOKEN;
    process.env.META_GRAPH_VERSION = "v23.0";
    process.env.META_APP_ID = OUR_APP_ID;
    delete process.env.META_HUMAN_AGENT_ENABLED;
    installGraphStub();
    clearPageTokenCache();
    await seedOwner(db);

    const [team] = await db.insert(inboxTeam).values({ name: "Customer care" }).returning();
    teamId = team!.id;
    const [fb] = await db
      .insert(inboxPhoneNumber)
      .values({
        kind: "messenger",
        e164: null,
        externalId: PAGE_ID,
        pageExternalId: PAGE_ID,
        externalName: "Mrs Samuel fruit juice",
        label: "Facebook Page",
        channels: "whatsapp",
        defaultTeamId: teamId,
      })
      .returning();
    messengerLineId = fb!.id;
    const [ig] = await db
      .insert(inboxPhoneNumber)
      .values({
        kind: "instagram",
        e164: null,
        externalId: IG_ID,
        pageExternalId: PAGE_ID,
        externalName: "mrs_samuelfruitjuice",
        label: "Instagram",
        channels: "whatsapp",
        defaultTeamId: teamId,
      })
      .returning();
    instagramLineId = ig!.id;

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await container?.stop();
  });

  // ── Webhook basics ─────────────────────────────────────────────────────────

  it("answers the handshake only with the right token", async () => {
    const ok = await fetch(`${baseUrl}/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=itest-verify&hub.challenge=777`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("777");
    const bad = await fetch(`${baseUrl}/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
    expect(bad.status).toBe(403);
  });

  it("rejects a bad signature and stores nothing", async () => {
    const res = await postWebhook(pageEvent(textEvent({ mid: "m_bad", text: "x" })), "sha256=00");
    expect(res.status).toBe(401);
    expect(await db.select().from(inboxWebhookEvent)).toHaveLength(0);
  });

  it("ignores objects other than page and instagram", async () => {
    const res = await postWebhook({ object: "user", entry: [{ id: "1", changes: [{ field: "feed" }] }] });
    expect(res.status).toBe(200);
    expect(await db.select().from(inboxWebhookEvent)).toHaveLength(0);
  });

  it("stores one event per entry with kind page.messages / instagram.messages", async () => {
    const payload = {
      object: "page",
      entry: [
        { id: PAGE_ID, time: Date.now(), messaging: [textEvent({ mid: "m_entry_1", text: "one" })] },
        { id: PAGE_ID, time: Date.now(), messaging: [textEvent({ mid: "m_entry_2", text: "two" })] },
      ],
    };
    expect((await postWebhook(payload)).status).toBe(200);
    expect((await postWebhook(pageEvent(textEvent({ object: "instagram", mid: "ig_entry_1", text: "three" }), { object: "instagram" }))).status).toBe(200);
    const rows = await db.select().from(inboxWebhookEvent).orderBy(inboxWebhookEvent.receivedAt);
    expect(rows.map((r) => r.kind)).toEqual(["page.messages", "page.messages", "instagram.messages"]);
    expect(rows.every((r) => r.processedAt !== null && r.source === "meta")).toBe(true);
    expect(rows.every((r) => ((r.payload as { entry: unknown[] }).entry).length === 1)).toBe(true);
  });

  it("a Messenger text creates identity, phone-less customer, conversation (channel messenger) and message; a replay creates nothing", async () => {
    const from = "24000000000000101";
    const payload = pageEvent(textEvent({ mid: "m_text_1", text: "Do you deliver to Lekki?", from }));
    expect((await postWebhook(payload)).status).toBe(200);
    expect((await postWebhook(payload)).status).toBe(200); // Meta retry

    const msgs = await messagesByMidPrefix("m_text_1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: "in", status: "received", type: "text", channel: "messenger", body: "Do you deliver to Lekki?" });
    const conv = await conversationOf(msgs[0]!.id);
    expect(conv).toMatchObject({ phoneNumberId: messengerLineId, channel: "messenger", teamId, unreadCount: 1, status: "open" });
    expect(conv.lastInboundWaAt).not.toBeNull();
    const [ident] = await db.select().from(inboxIdentity).where(eq(inboxIdentity.id, conv.identityId!));
    expect(ident).toMatchObject({ channel: "messenger", accountExternalId: PAGE_ID, externalId: from, customerId: conv.customerId });
    const [cust] = await db.select().from(customer).where(eq(customer.id, conv.customerId));
    expect(cust).toMatchObject({ phone: null, source: "online" });
    const idents = await db.select().from(inboxIdentity).where(eq(inboxIdentity.externalId, from));
    expect(idents).toHaveLength(1);
  });

  it("an Instagram text does the same on the instagram line", async () => {
    const from = "980000000000000101";
    await postWebhook(pageEvent(textEvent({ object: "instagram", mid: "ig_text_1", text: "Hi from IG", from }), { object: "instagram" }));
    const [msg] = await messagesByMidPrefix("ig_text_1");
    expect(msg).toMatchObject({ channel: "instagram", direction: "in", body: "Hi from IG" });
    const conv = await conversationOf(msg!.id);
    expect(conv).toMatchObject({ phoneNumberId: instagramLineId, channel: "instagram" });
    const [ident] = await db.select().from(inboxIdentity).where(eq(inboxIdentity.id, conv.identityId!));
    expect(ident).toMatchObject({ channel: "instagram", accountExternalId: IG_ID, externalId: from });
  });

  it("the live signal for a customer message carries direction in", async () => {
    const signals: { event: string; direction?: string }[] = [];
    const sub = await db.$client.listen("inbox_events", (raw) => {
      signals.push(JSON.parse(raw) as (typeof signals)[number]);
    });
    try {
      await postWebhook(pageEvent(textEvent({ mid: "m_signal_1", text: "Open Sunday?" })));
      for (let i = 0; i < 40 && !signals.some((s) => s.event === "message.created"); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await sub.unlisten();
    }
    const created = signals.filter((s) => s.event === "message.created");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ direction: "in" });
  });
});

// Keep imports used by later sections referenced (and type-checked) here.
void and;

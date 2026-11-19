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
  inboxTeamMember,
  inboxUserNumberAccess,
  inboxWebhookEvent,
  outboxEvent,
} from "@ms/db";
import { clearPageTokenCache, InboxSendError, META_SEND_RETRY_DELAYS_MS, metaConfigFromEnv, sendFromConversation } from "@ms/domain";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

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

  const loginOwner = () => loginAs(baseUrl, "owner@example.com", "ownerpassword123");

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

  // ── Every kind of event ────────────────────────────────────────────────────

  /** A fresh customer's thread on a line: they write once, we return the conversation. */
  async function threadFor(from: string, object: "page" | "instagram" = "page", ts = Date.now()) {
    const mid = `${object === "page" ? "m" : "ig"}_open_${from}`;
    await postWebhook(pageEvent(textEvent({ object, mid, text: "hello", from, ts }), { object }));
    const [msg] = await messagesByMidPrefix(mid);
    return conversationOf(msg!.id);
  }

  async function outbound(conversationId: string, o: { mid: string | null; status: "queued" | "sent" | "delivered" | "read" | "failed"; at: Date; channel?: string }) {
    const [row] = await db
      .insert(inboxMessage)
      .values({
        conversationId,
        direction: "out",
        type: "text",
        body: `out ${o.mid ?? "queued"}`,
        channel: o.channel ?? "messenger",
        waMessageId: o.mid,
        status: o.status,
        createdAt: o.at,
      })
      .returning();
    return row!;
  }
  const reload = async (id: string) => (await db.select().from(inboxMessage).where(eq(inboxMessage.id, id)))[0]!;

  type TimelineMessage = {
    id: string;
    media_pending: boolean;
    story_reply: boolean;
    external_sender: boolean;
    link: string | null;
    advert: string | null;
    edited: boolean;
    deleted: boolean;
    channel: string;
    tap_caption: string | null;
  };
  /** One message row as the timeline route returns it. */
  async function timelineMessage(conversationId: string, messageId: string): Promise<TimelineMessage | undefined> {
    const res = await fetch(`${baseUrl}/v1/inbox/conversations/${conversationId}/timeline`, { headers: { cookie: await loginOwner() } });
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { data: { kind: string; data: TimelineMessage }[] }).data;
    return items.find((i) => i.kind === "message" && i.data.id === messageId)?.data;
  }
  const reloadConv = async (id: string) => (await db.select().from(inboxConversation).where(eq(inboxConversation.id, id)))[0]!;

  it("a story mention is saved without media_url", async () => {
    const ev = {
      sender: { id: "980000000000000201" },
      recipient: { id: IG_ID },
      timestamp: Date.now(),
      message: { mid: "ig_story_1", attachments: [{ type: "story_mention", payload: { url: "https://cdn.example.test/story1" } }] },
    };
    await postWebhook(pageEvent(ev, { object: "instagram" }));
    const [msg] = await messagesByMidPrefix("ig_story_1");
    expect(msg).toMatchObject({ type: "story_mention", body: "Mentioned you in their story", mediaUrl: null, mediaId: null });
    // The link stays only in the raw copy (offered for 24 hours), never downloaded.
    expect(JSON.stringify(msg!.payload)).toContain("https://cdn.example.test/story1");
    const row = await timelineMessage(msg!.conversationId, msg!.id);
    expect(row).toMatchObject({ link: "https://cdn.example.test/story1", media_pending: false });
  });

  it("an image attachment is saved with media_url and reported as media_pending", async () => {
    const ev = {
      sender: { id: "24000000000000202" },
      recipient: { id: PAGE_ID },
      timestamp: Date.now(),
      message: { mid: "m_image_1", attachments: [{ type: "image", payload: { url: "https://cdn.example.test/photo.jpg" } }] },
    };
    await postWebhook(pageEvent(ev));
    const [msg] = await messagesByMidPrefix("m_image_1");
    expect(msg).toMatchObject({ type: "image", mediaUrl: "https://cdn.example.test/photo.jpg", mediaKey: null, mediaId: null });
    expect((await timelineMessage(msg!.conversationId, msg!.id))?.media_pending).toBe(true);
  });

  it("a story reply is flagged story_reply in the timeline", async () => {
    const ev = textEvent({
      object: "instagram",
      mid: "ig_story_reply_1",
      text: "Is the mango one still on?",
      from: "980000000000000202",
      extra: { reply_to: { story: { url: "https://cdn.example.test/our-story", id: "17900000000000001" } } },
    });
    await postWebhook(pageEvent(ev, { object: "instagram" }));
    const [msg] = await messagesByMidPrefix("ig_story_reply_1");
    expect(msg).toMatchObject({ type: "text", direction: "in" });
    expect((await timelineMessage(msg!.conversationId, msg!.id))?.story_reply).toBe(true);
  });

  it("a postback and a reaction open the reply window; a referral opens it without unread or alert", async () => {
    const from = "24000000000000301";
    const old = Date.now() - 3 * 86_400_000;
    const conv = await threadFor(from, "page", old);
    await db.update(inboxConversation).set({ unreadCount: 0 }).where(eq(inboxConversation.id, conv.id));

    // Referral: window opens, unread unchanged, no "in" signal.
    const signals: { event: string; direction?: string }[] = [];
    const sub = await db.$client.listen("inbox_events", (raw) => signals.push(JSON.parse(raw) as (typeof signals)[number]));
    const refTs = Date.now() - 60_000;
    try {
      await postWebhook(pageEvent({ sender: { id: from }, recipient: { id: PAGE_ID }, timestamp: refTs, referral: { source: "ADS", type: "OPEN_THREAD", ad_id: "123", ads_context_data: { ad_title: "Mango Monday" } } }));
      for (let i = 0; i < 20 && !signals.some((s) => s.event === "message.created"); i++) await new Promise((r) => setTimeout(r, 50));
    } finally {
      await sub.unlisten();
    }
    const [ref] = await messagesByMidPrefix(`ref:${from}:`);
    expect(ref).toMatchObject({ type: "referral", direction: "in", body: "Came from an advert: Mango Monday" });
    let c = await reloadConv(conv.id);
    expect(c.unreadCount).toBe(0);
    expect(c.lastInboundWaAt!.getTime()).toBe(refTs);
    expect(signals.filter((s) => s.event === "message.created").every((s) => s.direction === undefined)).toBe(true);

    // Postback: chat set-up payload without a title gets the fallback title.
    const pbTs = Date.now() - 30_000;
    await postWebhook(pageEvent({ sender: { id: from }, recipient: { id: PAGE_ID }, timestamp: pbTs, postback: { payload: "ms:v1:ice:2" } }));
    const [pb] = await messagesByMidPrefix(`pb:${from}:`);
    expect(pb).toMatchObject({ type: "interactive", direction: "in", body: "Starter question 2" });
    expect((pb!.payload as { postback: { payload: string } }).postback.payload).toBe("ms:v1:ice:2");
    expect((await timelineMessage(conv.id, pb!.id))?.tap_caption).toBe("Tapped a starter question");
    expect((await timelineMessage(conv.id, ref!.id))?.advert).toBeNull(); // the referral row's body says it instead
    c = await reloadConv(conv.id);
    expect(c.unreadCount).toBe(1);
    expect(c.lastInboundWaAt!.getTime()).toBe(pbTs);

    // Reaction: opens the window and counts as unread; unreact does neither.
    const reTs = Date.now() - 10_000;
    await postWebhook(pageEvent({ sender: { id: from }, recipient: { id: PAGE_ID }, timestamp: reTs, reaction: { mid: "m_x", action: "react", emoji: "❤️" } }));
    const [react] = await messagesByMidPrefix("react:m_x:");
    expect(react).toMatchObject({ type: "reaction", body: "Reacted ❤️" });
    c = await reloadConv(conv.id);
    expect(c.unreadCount).toBe(2);
    expect(c.lastInboundWaAt!.getTime()).toBe(reTs);
    await postWebhook(pageEvent({ sender: { id: from }, recipient: { id: PAGE_ID }, timestamp: Date.now(), reaction: { mid: "m_y", action: "unreact" } }));
    c = await reloadConv(conv.id);
    expect(c.unreadCount).toBe(2);
    expect(c.lastInboundWaAt!.getTime()).toBe(reTs);
  });

  it("an edit replaces the body and keeps the old text; an unsend blanks the message and queues the file for removal", async () => {
    const from = "980000000000000301";
    await threadFor(from, "instagram");
    await postWebhook(pageEvent(textEvent({ object: "instagram", mid: "ig_edit_1", text: "Two mangos", from }), { object: "instagram" }));
    await postWebhook(pageEvent({ sender: { id: from }, recipient: { id: IG_ID }, timestamp: Date.now(), message_edit: { mid: "ig_edit_1", text: "Three mangos", num_edit: 1 } }, { object: "instagram" }));
    const [edited] = await messagesByMidPrefix("ig_edit_1");
    expect(edited!.body).toBe("Three mangos");
    expect(edited!.editedAt).not.toBeNull();
    expect((edited!.payload as { edits: { text: string }[] }).edits.map((x) => x.text)).toEqual(["Two mangos"]);

    // A photo that was stored, then unsent.
    await postWebhook(pageEvent({ sender: { id: from }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid: "ig_unsend_1", text: "secret", attachments: [{ type: "image", payload: { url: "https://cdn.example.test/p.jpg" } }] } }, { object: "instagram" }));
    const [photo] = await messagesByMidPrefix("ig_unsend_1");
    await db.update(inboxMessage).set({ mediaKey: "inbox/media/2026/11/x.jpg", mediaUrl: null }).where(eq(inboxMessage.id, photo!.id));
    await postWebhook(pageEvent({ sender: { id: from }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid: "ig_unsend_1", is_deleted: true } }, { object: "instagram" }));
    const gone = await reload(photo!.id);
    expect(gone).toMatchObject({ body: null, mediaKey: null, mediaUrl: null });
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.payload).toEqual({ purge_key: "inbox/media/2026/11/x.jpg" });
    expect((await reloadConv(gone.conversationId)).lastPreview).toBe("Message deleted");
  });

  it("an echo with our metadata fills the mid on the queued row and inserts nothing", async () => {
    const from = "24000000000000401";
    const conv = await threadFor(from);
    const queued = await outbound(conv.id, { mid: null, status: "queued", at: new Date() });
    const echo = { sender: { id: PAGE_ID }, recipient: { id: from }, timestamp: Date.now(), message: { mid: "m_echo_meta", is_echo: true, app_id: Number(OUR_APP_ID), metadata: `suite:${queued.id}`, text: queued.body } };
    await postWebhook(pageEvent(echo));
    expect(await reload(queued.id)).toMatchObject({ waMessageId: "m_echo_meta", status: "sent" });
    expect(await messagesByMidPrefix("m_echo_meta")).toHaveLength(1);
  });

  it("a fresh unknown echo is left unprocessed (EchoBeforeSendError); an old one becomes an outbound message marked external_sender", async () => {
    const from = "24000000000000501";
    await threadFor(from);
    const fresh = { sender: { id: PAGE_ID }, recipient: { id: from }, timestamp: Date.now(), message: { mid: "m_echo_fresh", is_echo: true, app_id: Number(OUR_APP_ID), text: "from us?" } };
    await postWebhook(pageEvent(fresh));
    expect(await messagesByMidPrefix("m_echo_fresh")).toHaveLength(0);
    const [ev] = await db.select().from(inboxWebhookEvent).where(sql`${inboxWebhookEvent.payload}::text like '%m_echo_fresh%'`);
    expect(ev!.processedAt).toBeNull();
    expect(ev!.lastError).toContain("echo");

    const old = { ...fresh, timestamp: Date.now() - 120_000, message: { ...fresh.message, mid: "m_echo_old", text: "Answered in the Page inbox" } };
    await postWebhook(pageEvent(old));
    const [row] = await messagesByMidPrefix("m_echo_old");
    expect(row).toMatchObject({ direction: "out", status: "sent", senderUserId: null, body: "Answered in the Page inbox" });
    expect((row!.payload as { echo: { app_id: string } }).echo.app_id).toBe(OUR_APP_ID);
    expect((await timelineMessage(row!.conversationId, row!.id))?.external_sender).toBe(true);
  });

  it("an echo from another app id is inserted at once", async () => {
    const from = "24000000000000601";
    await threadFor(from);
    await postWebhook(pageEvent({ sender: { id: PAGE_ID }, recipient: { id: from }, timestamp: Date.now(), message: { mid: "m_echo_other", is_echo: true, app_id: 263902037430900, text: "Hi from Business Suite" } }));
    const [row] = await messagesByMidPrefix("m_echo_other");
    expect(row).toMatchObject({ direction: "out", senderUserId: null, status: "sent" });
  });

  it("delivery and read watermarks move statuses forward only", async () => {
    const from = "24000000000000701";
    const conv = await threadFor(from);
    const t = Date.now();
    const a = await outbound(conv.id, { mid: "m_wm_a", status: "sent", at: new Date(t - 10_000) });
    const b = await outbound(conv.id, { mid: "m_wm_b", status: "sent", at: new Date(t - 5_000) });
    const r = await outbound(conv.id, { mid: "m_wm_r", status: "read", at: new Date(t - 20_000) });
    const f = await outbound(conv.id, { mid: "m_wm_f", status: "failed", at: new Date(t - 20_000) });
    await postWebhook(pageEvent({ sender: { id: from }, recipient: { id: PAGE_ID }, timestamp: t, delivery: { watermark: t - 7_000 } }));
    expect((await reload(a.id)).status).toBe("delivered");
    expect((await reload(b.id)).status).toBe("sent");
    expect((await reload(r.id)).status).toBe("read");
    expect((await reload(f.id)).status).toBe("failed");
    await postWebhook(pageEvent({ sender: { id: from }, recipient: { id: PAGE_ID }, timestamp: t + 1, read: { watermark: t } }));
    expect((await reload(a.id)).status).toBe("read");
    expect((await reload(b.id)).status).toBe("read");
    expect((await reload(b.id)).deliveredAt).not.toBeNull();
    // A late delivery never moves read back.
    await postWebhook(pageEvent({ sender: { id: from }, recipient: { id: PAGE_ID }, timestamp: t + 2, delivery: { mids: ["m_wm_a", "m_wm_b"], watermark: t } }));
    expect((await reload(a.id)).status).toBe("read");
    expect((await reload(f.id)).status).toBe("failed");
  });

  it("Instagram seen marks the message and earlier sent ones read", async () => {
    const from = "980000000000000701";
    const conv = await threadFor(from, "instagram");
    const t = Date.now();
    const a = await outbound(conv.id, { mid: "ig_seen_a", status: "sent", at: new Date(t - 10_000), channel: "instagram" });
    const b = await outbound(conv.id, { mid: "ig_seen_b", status: "sent", at: new Date(t - 5_000), channel: "instagram" });
    const later = await outbound(conv.id, { mid: "ig_seen_c", status: "sent", at: new Date(t - 1_000), channel: "instagram" });
    await postWebhook(pageEvent({ sender: { id: from }, recipient: { id: IG_ID }, timestamp: t, read: { mid: "ig_seen_b" } }, { object: "instagram" }));
    expect((await reload(a.id)).status).toBe("read");
    expect((await reload(b.id)).status).toBe("read");
    expect((await reload(later.id)).status).toBe("sent");
  });

  it("standby events are ingested and flagged", async () => {
    await postWebhook(pageEvent(textEvent({ mid: "m_standby_1", text: "while another app has the chat", from: "24000000000000801" }), { standby: true }));
    const [row] = await messagesByMidPrefix("m_standby_1");
    expect(row).toMatchObject({ direction: "in", body: "while another app has the chat" });
    expect((row!.payload as { standby?: boolean }).standby).toBe(true);
    const [ev] = await db.select().from(inboxWebhookEvent).where(sql`${inboxWebhookEvent.payload}::text like '%m_standby_1%'`);
    expect(ev!.kind).toBe("page.standby");
  });

  // ── Accounts we don't know, or have switched off ───────────────────────────

  it("an event for an unknown account is parked and raises one alert", async () => {
    const ev1 = pageEvent(textEvent({ mid: "m_unknown_1", text: "anyone?", from: "24000000000000901" }), { entryId: UNKNOWN_PAGE_ID });
    const ev2 = pageEvent(textEvent({ mid: "m_unknown_2", text: "hello?", from: "24000000000000901" }), { entryId: UNKNOWN_PAGE_ID });
    expect((await postWebhook(ev1)).status).toBe(200);
    expect((await postWebhook(ev2)).status).toBe(200);
    expect(await messagesByMidPrefix("m_unknown_")).toHaveLength(0);
    const parked = await db.select().from(inboxWebhookEvent).where(sql`${inboxWebhookEvent.lastError} like ${`unknown_account:%messenger:${UNKNOWN_PAGE_ID}%`}`);
    expect(parked).toHaveLength(2);
    expect(parked.every((p) => p.processedAt === null && p.attempts >= 1000)).toBe(true);
    const alerts = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "inbox.unknown_channel_account"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ account: `messenger:${UNKNOWN_PAGE_ID}` });
  });

  it("an event for a switched-off account creates nothing", async () => {
    const offPage = "100200300555";
    await db.insert(inboxPhoneNumber).values({
      kind: "messenger",
      e164: null,
      externalId: offPage,
      pageExternalId: offPage,
      label: "Old Page",
      channels: "whatsapp",
      isActive: false,
    });
    await postWebhook(pageEvent(textEvent({ mid: "m_off_1", text: "hi", from: "24000000000001001" }), { entryId: offPage }));
    expect(await messagesByMidPrefix("m_off_1")).toHaveLength(0);
    expect(await db.select().from(inboxIdentity).where(eq(inboxIdentity.externalId, "24000000000001001"))).toHaveLength(0);
    const [ev] = await db.select().from(inboxWebhookEvent).where(sql`${inboxWebhookEvent.payload}::text like '%m_off_1%'`);
    expect(ev!.processedAt).not.toBeNull();
    expect(ev!.lastError).toBe("account_inactive");
  });

  // ── Replying ───────────────────────────────────────────────────────────────

  async function reply(conversationId: string, body: unknown, cookie?: string) {
    return fetch(`${baseUrl}/v1/inbox/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { cookie: cookie ?? (await loginOwner()), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  const sendsTo = (recipientId: string) =>
    graphCalls.filter((g) => g.method === "POST" && g.url.endsWith("/messages") && !g.body?.sender_action && (g.body?.recipient as { id?: string } | undefined)?.id === recipientId);

  it("reply inside 24 hours goes to POST {page}/messages with the page token and RESPONSE", async () => {
    const from = "24000000000001101";
    const conv = await threadFor(from);
    const res = await reply(conv.id, { type: "text", body: "Yes, we deliver to Lekki." });
    expect(res.status).toBe(201);
    const [call] = sendsTo(from);
    expect(call!.url).toBe(`https://graph.facebook.com/v23.0/${PAGE_ID}/messages`);
    expect(call!.auth).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(call!.auth).not.toContain(SYSTEM_TOKEN);
    expect(call!.body).toMatchObject({ recipient: { id: from }, messaging_type: "RESPONSE", message: { text: "Yes, we deliver to Lekki." } });
    expect((call!.body!.message as { metadata?: string }).metadata).toMatch(/^suite:[0-9a-f-]{36}$/);
    const { data } = (await res.json()) as { data: { id: string; status: string; channel: string; wa_message_id?: string; waMessageId?: string } };
    expect(data).toMatchObject({ status: "sent", channel: "messenger" });
    // The Instagram line sends from the linked Page, with no metadata.
    const igFrom = "980000000000001101";
    const ig = await threadFor(igFrom, "instagram");
    expect((await reply(ig.id, { type: "text", body: "Hello on Instagram" })).status).toBe(201);
    const [igCall] = sendsTo(igFrom);
    expect(igCall!.url).toBe(`https://graph.facebook.com/v23.0/${PAGE_ID}/messages`);
    expect((igCall!.body!.message as { metadata?: string }).metadata).toBeUndefined();
  });

  it("reply after 24 hours is refused with window_closed; with human agent on it is sent with the tag; an automatic send never uses the tag", async () => {
    const from = "24000000000001201";
    const conv = await threadFor(from, "page", Date.now() - 2 * 86_400_000);
    const closed = await reply(conv.id, { type: "text", body: "Sorry for the wait" });
    expect(closed.status).toBe(409);
    const err = (await closed.json()) as { error: { message: string; details?: { reason?: string } } };
    expect(err.error.details?.reason).toBe("window_closed");
    expect(err.error.message).toBe("More than 24 hours since the customer last wrote. On Messenger you can reply again once they write.");
    expect(sendsTo(from)).toHaveLength(0);

    process.env.META_HUMAN_AGENT_ENABLED = "true";
    try {
      expect((await reply(conv.id, { type: "text", body: "Sorry for the wait" })).status).toBe(201);
      const [call] = sendsTo(from);
      expect(call!.body).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
      const [row] = await db.select().from(inboxMessage).where(and(eq(inboxMessage.conversationId, conv.id), eq(inboxMessage.body, "Sorry for the wait")));
      expect(row!.payload).toMatchObject({ tag: "HUMAN_AGENT" });

      // No person → no tag, so outside 24 hours it is refused.
      await expect(
        sendFromConversation(db, metaConfigFromEnv(), { conversationId: conv.id, userId: null, content: { type: "text", body: "auto" } }),
      ).rejects.toMatchObject({ code: "window_closed" });
      // Over 7 days, even a person can't.
      await db.update(inboxConversation).set({ lastInboundWaAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(inboxConversation.id, conv.id));
      expect((await reply(conv.id, { type: "text", body: "too late" })).status).toBe(409);
    } finally {
      delete process.env.META_HUMAN_AGENT_ENABLED;
    }
  });

  it("a template or a captioned file is refused on Messenger", async () => {
    const from = "24000000000001301";
    const conv = await threadFor(from);
    const before = await db.select().from(inboxMessage).where(eq(inboxMessage.conversationId, conv.id));
    const tpl = await reply(conv.id, { type: "template", name: "conversation_reopen", language: "en", params: [] });
    expect(tpl.status).toBe(409);
    expect(((await tpl.json()) as { error: { message: string } }).error.message).toBe("Templates are only for WhatsApp.");
    const captioned = sendFromConversation(db, metaConfigFromEnv(), {
      conversationId: conv.id,
      userId: null,
      content: { type: "image", link: "https://files.example.test/a.jpg", caption: "Our menu" },
    });
    await expect(captioned).rejects.toBeInstanceOf(InboxSendError);
    await expect(captioned).rejects.toMatchObject({ code: "not_supported", message: "Messenger can't send a caption with a file. Send the text as its own message." });
    const after = await db.select().from(inboxMessage).where(eq(inboxMessage.conversationId, conv.id));
    expect(after).toHaveLength(before.length); // nothing written
    expect(sendsTo(from)).toHaveLength(0);
  });

  it("Instagram text over 1000 bytes is refused with too_long", async () => {
    const from = "980000000000001401";
    const conv = await threadFor(from, "instagram");
    const res = await reply(conv.id, { type: "text", body: "é".repeat(600) }); // 600 characters, 1200 bytes
    expect(res.status).toBe(409);
    const err = (await res.json()) as { error: { message: string; details?: { reason?: string } } };
    expect(err.error.details?.reason).toBe("too_long");
    expect(err.error.message).toBe("That is too long for Instagram. Shorten it or send it in two parts.");
    expect((await reply(conv.id, { type: "text", body: "é".repeat(500) })).status).toBe(201); // exactly 1000 bytes
  });

  it("Meta 551 stores the plain sentence and code on the failed message", async () => {
    const from = "24000000000001501";
    const conv = await threadFor(from);
    sendErrors.push({ status: 400, error: { message: "This person isn't available right now.", code: 551, error_subcode: 1545041 } });
    const res = await reply(conv.id, { type: "text", body: "Hello?" });
    expect(res.status).toBe(502);
    const { data } = (await res.json()) as { data: { id: string } };
    const row = await reload(data.id);
    expect(row).toMatchObject({
      status: "failed",
      errorCode: "551/1545041",
      errorMessage: "This person can't receive messages from us right now. They may have blocked us or closed their account.",
    });
    expect(row.payload).toMatchObject({ retryable: false, meta_message: "This person isn't available right now." });
  });

  it("Meta 613 is retried twice and then marked retryable", async () => {
    const from = "24000000000001601";
    const conv = await threadFor(from);
    const saved = [...META_SEND_RETRY_DELAYS_MS];
    META_SEND_RETRY_DELAYS_MS.splice(0, saved.length, 0, 0);
    try {
      for (let i = 0; i < 3; i++) sendErrors.push({ status: 400, error: { message: "Calls to this api have exceeded the rate limit.", code: 613 } });
      const res = await reply(conv.id, { type: "text", body: "Busy?" });
      expect(res.status).toBe(502);
      expect(sendsTo(from)).toHaveLength(3);
      const { data } = (await res.json()) as { data: { id: string } };
      const row = await reload(data.id);
      expect(row).toMatchObject({ status: "failed", errorCode: "613", errorMessage: "Messenger is busy. Try again in a minute." });
      expect(row.payload).toMatchObject({ retryable: true });
    } finally {
      META_SEND_RETRY_DELAYS_MS.splice(0, META_SEND_RETRY_DELAYS_MS.length, ...saved);
      sendErrors.length = 0;
    }
  });

  it("Meta 200/2534041 marks the line with a problem and raises one alert; a later success clears it", async () => {
    const from = "980000000000001701";
    const conv = await threadFor(from, "instagram");
    const refusal = { status: 403, error: { message: "Message access is off", code: 200, error_subcode: 2534041 } };
    sendErrors.push(refusal, refusal);
    expect((await reply(conv.id, { type: "text", body: "one" })).status).toBe(502);
    expect((await reply(conv.id, { type: "text", body: "two" })).status).toBe(502);
    const [line] = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, instagramLineId));
    expect(line).toMatchObject({ problemCode: "200/2534041", problemText: "Message access is switched off in the Instagram app. The owner has been told." });
    const alerts = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "inbox.meta_config"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ account: IG_ID, code: "200/2534041" });
    // The banner text reaches the conversation detail.
    const detail = await fetch(`${baseUrl}/v1/inbox/conversations/${conv.id}`, { headers: { cookie: await loginOwner() } });
    expect(((await detail.json()) as { data: { number: { problem_text: string | null } } }).data.number.problem_text).toContain("Message access is switched off");

    expect((await reply(conv.id, { type: "text", body: "three" })).status).toBe(201);
    const [cleared] = await db.select().from(inboxPhoneNumber).where(eq(inboxPhoneNumber.id, instagramLineId));
    expect(cleared).toMatchObject({ problemCode: null, problemText: null, problemAt: null });
  });

  it("an agent sees and answers only on the lines granted to them", async () => {
    // Foundation rule 6 has one visibility rule: without inbox.view_all a person sees
    // only the lines granted to them, so "can read but not reply" on a line cannot
    // happen; the line they lack is hidden (404) for reading and replying alike.
    const user = await seedUser(db, { email: "dm-agent@example.com", role: "branch_staff", granted: ["inbox.view", "inbox.view_team", "inbox.reply"] });
    await db.insert(inboxTeamMember).values({ teamId, userId: user.id });
    await db.insert(inboxUserNumberAccess).values({ userId: user.id, phoneNumberId: messengerLineId });
    const cookie = await loginAs(baseUrl, "dm-agent@example.com", "userpassword123");

    const fb = await threadFor("24000000000001801");
    const ig = await threadFor("980000000000001801", "instagram");
    expect((await fetch(`${baseUrl}/v1/inbox/conversations/${fb.id}`, { headers: { cookie } })).status).toBe(200);
    expect((await reply(fb.id, { type: "text", body: "Hi from the agent" }, cookie)).status).toBe(201);
    expect((await fetch(`${baseUrl}/v1/inbox/conversations/${ig.id}`, { headers: { cookie } })).status).toBe(404);
    expect((await reply(ig.id, { type: "text", body: "not allowed" }, cookie)).status).toBe(404);
  });

  it("uploads use the channel's rules when conversation_id is given", async () => {
    const cookie = await loginOwner();
    const ig = await threadFor("980000000000001901", "instagram");
    const fb = await threadFor("24000000000001901");
    const upload = (b: Record<string, unknown>) =>
      fetch(`${baseUrl}/v1/inbox/uploads`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(b) });
    const msg = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;

    // WhatsApp rules (and wording) without a conversation, as before.
    const wa = await upload({ filename: "a.gif", content_type: "image/gif", size_bytes: 1000 });
    expect(wa.status).toBe(400);
    expect(await msg(wa)).toBe("This file type can't be sent on WhatsApp: image/gif");

    const gif = await upload({ filename: "a.gif", content_type: "image/gif", size_bytes: 1000, conversation_id: ig.id });
    expect(gif.status).toBe(400);
    expect(await msg(gif)).toBe("This kind of file can't be sent on Instagram: image/gif");
    const big = await upload({ filename: "a.jpg", content_type: "image/jpeg", size_bytes: 9 * 1024 * 1024, conversation_id: ig.id });
    expect(big.status).toBe(400);
    expect(await msg(big)).toBe("This file is too large for Instagram (limit 8 MB)");
    // Allowed on Messenger: it passes the rules and only stops because this test has no storage configured.
    const ok = await upload({ filename: "a.jpg", content_type: "image/jpeg", size_bytes: 9 * 1024 * 1024, conversation_id: fb.id });
    expect(ok.status).toBe(503);
  });

  it("no response body or stored row contains the stubbed page token", async () => {
    const cookie = await loginOwner();
    const list = await fetch(`${baseUrl}/v1/inbox/conversations?view=all`, { headers: { cookie } });
    expect(await list.text()).not.toContain(PAGE_TOKEN);
    const channels = await fetch(`${baseUrl}/v1/channels`, { headers: { cookie } });
    expect(await channels.text()).not.toContain(PAGE_TOKEN);
    for (const table of ["inbox_message", "inbox_webhook_event", "inbox_phone_number", "inbox_identity", "outbox_event", "audit_log"]) {
      const rows = await db.execute(sql.raw(`select count(*)::int as n from ${table} where ${table}::text like '%${PAGE_TOKEN}%'`));
      expect((rows as unknown as { n: number }[])[0]!.n).toBe(0);
    }
  });
});

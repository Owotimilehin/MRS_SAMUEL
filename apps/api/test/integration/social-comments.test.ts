import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  auditLog,
  inboxConversation,
  inboxIdentity,
  inboxMessage,
  inboxPhoneNumber,
  inboxTeam,
  inboxUserNumberAccess,
  inboxWebhookEvent,
  outboxEvent,
  socialComment,
  socialCommentAccount,
  socialPostRef,
} from "@ms/db";
import { clearPageTokenCache, registerSocialPostRef } from "@ms/domain";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

/**
 * Suite spec 03: comments on Facebook Page posts and Instagram posts. A
 * messenger line and an instagram line are inserted directly. Every Graph API
 * call is stubbed; nothing reaches Meta. The names and IDs below are made up.
 */

const APP_SECRET = "itest-meta-app-secret";
const PAGE_TOKEN = "itest-page-token-XYZ";
const PAGE_ID = "100200300400";
const IG_ID = "17841400000000001";
const UNKNOWN_PAGE_ID = "100200300999";
const OUR_APP_ID = "900800700600";
const POST = `${PAGE_ID}_555`;
const MEDIA = "17900000000000001";
const ADA = "24000000000000001";
const BISI = "980000000000000001";

// ── Graph stub ───────────────────────────────────────────────────────────────

type GraphCall = { method: string; path: string; query: string; auth: string | null; body: Record<string, unknown> | null };
let graphCalls: GraphCall[] = [];
/** The next call that is not a token fetch fails with this Meta error, or never answers. */
let nextFailure: { status: number; error: Record<string, unknown> } | "timeout" | null = null;
/** What GET {comment id} answers; anything not listed answers {id}. */
const remoteComments = new Map<string, Record<string, unknown> | { error: Record<string, unknown>; status: number }>();
/** Runs after Meta "accepted" a reply or a private message and before we hear back. */
let beforeAnswer: ((newId: string) => Promise<void>) | null = null;
let outCounter = 0;
/** recipient_id the private-reply answer carries (null = Meta sent none). */
let recipientId: string | null = "PSID1";

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://graph.facebook.com/")) return real(input, init);
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(u.pathname.replace(/^\/v[\d.]+\//, ""));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.search.includes("fields=access_token")) return ok({ access_token: PAGE_TOKEN, id: path });
    graphCalls.push({ method, path, query: decodeURIComponent(u.search), auth, body });
    if (nextFailure) {
      const f = nextFailure;
      nextFailure = null;
      if (f === "timeout") throw new Error("The operation was aborted due to timeout");
      return new Response(JSON.stringify({ error: f.error }), { status: f.status });
    }
    if (method === "POST" && (path.endsWith("/comments") || path.endsWith("/replies"))) {
      const newId = `c_out_${++outCounter}`;
      if (beforeAnswer) await beforeAnswer(newId);
      return ok({ id: newId });
    }
    if (method === "POST" && path.endsWith("/messages")) {
      const mid = `m_out_${++outCounter}`;
      if (beforeAnswer) await beforeAnswer(mid);
      return ok({ ...(recipientId ? { recipient_id: recipientId } : {}), message_id: mid });
    }
    if (method === "POST" || method === "DELETE") return ok({ success: true });
    if (path === POST) {
      return ok({
        id: POST,
        message: "Fresh pineapple juice is back",
        created_time: "2026-11-18T08:00:00+0000",
        permalink_url: "https://www.facebook.com/posts/555",
        full_picture: "https://cdn.example.test/p.jpg",
      });
    }
    const remote = remoteComments.get(path);
    if (remote && "error" in remote) return new Response(JSON.stringify({ error: remote.error }), { status: remote.status as number });
    return ok(remote ?? { id: path });
  }) as typeof fetch;
}

function sign(raw: string): string {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
}

// ── Payload builders ─────────────────────────────────────────────────────────

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${++seq}`;

function feed(value: Record<string, unknown>, entryId = PAGE_ID) {
  return { object: "page", entry: [{ id: entryId, time: Math.floor(Date.now() / 1000), changes: [{ field: "feed", value }] }] };
}

function fbComment(o: { id: string; message?: string; parent?: string; from?: { id: string; name: string }; verb?: string; post?: string }) {
  const post = o.post ?? POST;
  return {
    item: "comment",
    verb: o.verb ?? "add",
    comment_id: o.id,
    post_id: post,
    parent_id: o.parent ?? post,
    from: o.from ?? { id: ADA, name: "Ada Obi" },
    message: o.message ?? "Do you deliver to Ikeja?",
    created_time: Math.floor(Date.now() / 1000),
    post: { permalink_url: "https://www.facebook.com/posts/555" },
  };
}

function igComments(value: Record<string, unknown>, field = "comments") {
  return { object: "instagram", entry: [{ id: IG_ID, time: Math.floor(Date.now() / 1000), changes: [{ field, value }] }] };
}

describe("suite spec 03 — comments on Facebook and Instagram posts", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let fbLineId: string;
  let igLineId: string;
  let owner: string;
  let ownerId: string;

  async function postWebhook(payload: unknown): Promise<Response> {
    const raw = JSON.stringify(payload);
    return fetch(`${baseUrl}/v1/webhooks/meta`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) },
      body: raw,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads many response shapes
  async function call(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}/v1/social/comments${path}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  const byExt = async (externalId: string) => {
    const [row] = await db.select().from(socialComment).where(eq(socialComment.externalId, externalId));
    return row;
  };
  const byId = async (id: string) => {
    const [row] = await db.select().from(socialComment).where(eq(socialComment.id, id));
    return row!;
  };
  /** A customer's top-level Facebook comment, through the webhook. */
  async function customerComment(message = "Do you deliver to Ikeja?", from = { id: ADA, name: "Ada Obi" }) {
    const id = nextId(`${POST}_c`);
    expect((await postWebhook(feed(fbComment({ id, message, from })))).status).toBe(200);
    const row = await byExt(id);
    expect(row).toBeTruthy();
    return row!;
  }
  const graphWrites = () => graphCalls.filter((g) => g.method !== "GET");

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = "itest-verify";
    process.env.META_SYSTEM_USER_TOKEN = "itest-system-user-token";
    process.env.META_GRAPH_VERSION = "v23.0";
    process.env.META_APP_ID = OUR_APP_ID;
    installGraphStub();
    clearPageTokenCache();
    ownerId = (await seedOwner(db)).id;

    const [team] = await db.insert(inboxTeam).values({ name: "Customer care" }).returning();
    const line = (kind: "messenger" | "instagram", externalId: string, label: string) =>
      db
        .insert(inboxPhoneNumber)
        .values({ kind, e164: null, externalId, pageExternalId: PAGE_ID, externalName: label, label, channels: "whatsapp", defaultTeamId: team!.id })
        .returning();
    fbLineId = (await line("messenger", PAGE_ID, "Mrs Samuel fruit juice"))[0]!.id;
    igLineId = (await line("instagram", IG_ID, "Instagram"))[0]!.id;

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await container?.stop();
  });

  beforeEach(() => {
    graphCalls = [];
    nextFailure = null;
    beforeAnswer = null;
    recipientId = "PSID1";
    remoteComments.clear();
  });

  // ── Webhook ────────────────────────────────────────────────────────────────

  it("webhook: a Page comment creates a thread, a post ref and one unread", async () => {
    const id = nextId(`${POST}_c`);
    const res = await postWebhook(feed(fbComment({ id })));
    expect(res.status).toBe(200);
    const row = (await byExt(id))!;
    expect(row).toMatchObject({
      network: "facebook",
      accountId: fbLineId,
      rootId: null,
      kind: "comment",
      authorExternalId: ADA,
      authorName: "Ada Obi",
      fromBusiness: false,
      message: "Do you deliver to Ikeja?",
      status: "visible",
      workState: "open",
      unreadCount: 1,
      lastPreview: "Do you deliver to Ikeja?",
    });
    const [post] = await db.select().from(socialPostRef).where(eq(socialPostRef.id, row.postId));
    expect(post).toMatchObject({ network: "facebook", externalId: POST, accountId: fbLineId, permalinkUrl: "https://www.facebook.com/posts/555", fetchedAt: null });
    const [event] = await db.select().from(inboxWebhookEvent).where(sql`${inboxWebhookEvent.payload}::text like ${"%" + id + "%"}`);
    expect(event).toMatchObject({ source: "meta", kind: "page.feed", lastError: null });
    expect(event!.processedAt).not.toBeNull();
    // No call to Meta is made on the webhook path.
    expect(graphCalls).toHaveLength(0);
  });

  it("webhook: the same payload twice changes nothing the second time", async () => {
    const id = nextId(`${POST}_c`);
    const payload = feed(fbComment({ id }));
    await postWebhook(payload);
    const before = (await byExt(id))!;
    await postWebhook(payload);
    const rows = await db.select().from(socialComment).where(eq(socialComment.externalId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unreadCount).toBe(1);
    expect(rows[0]!.lastActivityAt.getTime()).toBe(before.lastActivityAt.getTime());
  });

  it("webhook: a reply before its parent creates a placeholder root", async () => {
    const parentId = nextId(`${POST}_c`);
    const replyId = nextId(`${POST}_c`);
    await postWebhook(feed(fbComment({ id: replyId, parent: parentId, message: "Me too!" })));
    const reply = (await byExt(replyId))!;
    const placeholder = (await byExt(parentId))!;
    expect(placeholder).toMatchObject({ rootId: null, message: null, needsFetch: true, workState: "open", unreadCount: 1, lastPreview: "Me too!" });
    expect(reply.rootId).toBe(placeholder.id);
    expect(reply.parentExternalId).toBe(parentId);

    // The parent itself arrives later: the placeholder is filled in, not doubled.
    await postWebhook(feed(fbComment({ id: parentId, message: "Is the mango one back?" })));
    const rows = await db.select().from(socialComment).where(eq(socialComment.externalId, parentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: placeholder.id, message: "Is the mango one back?", needsFetch: false, unreadCount: 1 });
  });

  it("webhook: remove marks the comment deleted and closes its thread", async () => {
    const row = await customerComment();
    await postWebhook(feed({ item: "comment", verb: "remove", comment_id: row.externalId, post_id: POST }));
    expect(await byId(row.id)).toMatchObject({ status: "deleted", workState: "done", unreadCount: 0 });
    // A deleted comment is never brought back by a late copy of its webhook.
    await postWebhook(feed(fbComment({ id: row.externalId!, message: "edited later", verb: "edited" })));
    expect(await byId(row.id)).toMatchObject({ status: "deleted", message: "Do you deliver to Ikeja?" });
  });

  it("webhook: hide from outside sets hidden_source outside", async () => {
    const row = await customerComment();
    await postWebhook(feed({ item: "comment", verb: "hide", comment_id: row.externalId, post_id: POST }));
    expect(await byId(row.id)).toMatchObject({ status: "hidden", hiddenSource: "outside" });
    await postWebhook(feed({ item: "comment", verb: "unhide", comment_id: row.externalId, post_id: POST }));
    expect(await byId(row.id)).toMatchObject({ status: "visible", hiddenSource: null });
  });

  it("webhook: an edit updates the text and moves the thread up without reopening it (R12)", async () => {
    const row = await customerComment("Do you delivr?");
    await call(owner, "PATCH", `/threads/${row.id}`, { work_state: "done" });
    await postWebhook(feed(fbComment({ id: row.externalId!, message: "Do you deliver?", verb: "edited" })));
    const after = await byId(row.id);
    expect(after).toMatchObject({ message: "Do you deliver?", workState: "done", unreadCount: 0, lastPreview: "Do you deliver?" });
    expect(after.editedAt).not.toBeNull();
  });

  it("webhook: an Instagram comment creates a thread on the instagram account", async () => {
    const id = nextId("ig_c");
    const res = await postWebhook(igComments({ id, from: { id: BISI, username: "bisi_juice" }, media: { id: MEDIA, media_product_type: "FEED" }, text: "How much?" }));
    expect(res.status).toBe(200);
    expect(await byExt(id)).toMatchObject({
      network: "instagram",
      accountId: igLineId,
      authorUsername: "bisi_juice",
      authorExternalId: BISI,
      message: "How much?",
      workState: "open",
      unreadCount: 1,
    });
    // A live-video comment is stored but starts as done, with nothing unread (R16).
    const liveId = nextId("ig_live");
    await postWebhook(igComments({ id: liveId, from: { id: BISI, username: "bisi_juice" }, media: { id: MEDIA }, text: "hi" }, "live_comments"));
    expect(await byExt(liveId)).toMatchObject({ kind: "live", workState: "done", unreadCount: 0 });
    // A mention in a comment waits for the worker to fetch its text.
    const mentionId = nextId("ig_m");
    await postWebhook(igComments({ media_id: "17900000000000777", comment_id: mentionId }, "mentions"));
    expect(await byExt(mentionId)).toMatchObject({ kind: "mention", needsFetch: true, unreadCount: 1, lastPreview: "Mentioned you in a comment" });
  });

  it("webhook: a comment by the Page itself raises no unread", async () => {
    const row = await customerComment();
    await call(owner, "PATCH", `/threads/${row.id}`, { work_state: "done" });
    const replyId = nextId(`${POST}_c`);
    await postWebhook(feed(fbComment({ id: replyId, parent: row.externalId!, from: { id: PAGE_ID, name: "Mrs Samuel fruit juice" }, message: "Yes we do." })));
    expect(await byExt(replyId)).toMatchObject({ fromBusiness: true, rootId: row.id, sentByUserId: null });
    expect(await byId(row.id)).toMatchObject({ workState: "done", unreadCount: 0, lastPreview: "You: Yes we do." });
    // The Page commenting on its own post: a thread of its own, already done.
    const ownId = nextId(`${POST}_c`);
    await postWebhook(feed(fbComment({ id: ownId, from: { id: PAGE_ID, name: "Mrs Samuel fruit juice" }, message: "Order before 4pm." })));
    expect(await byExt(ownId)).toMatchObject({ fromBusiness: true, rootId: null, workState: "done", unreadCount: 0 });
  });

  it("webhook: an unknown page id stores the event and creates nothing", async () => {
    const id = nextId("unknown_c");
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(socialComment);
    const res = await postWebhook(feed(fbComment({ id }), UNKNOWN_PAGE_ID));
    expect(res.status).toBe(200);
    expect(await byExt(id)).toBeUndefined();
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(socialComment))[0]!.n).toBe(before[0]!.n);
    const [event] = await db.select().from(inboxWebhookEvent).where(sql`${inboxWebhookEvent.payload}::text like ${"%" + id + "%"}`);
    expect(event!.processedAt).toBeNull();
    expect(event!.lastError).toBe(`unknown_account:messenger:${UNKNOWN_PAGE_ID}`);
  });

  it("webhook: a reaction on the feed is ignored and the event is still marked processed (R2)", async () => {
    const marker = nextId("reaction");
    await postWebhook(feed({ item: "reaction", verb: "add", post_id: POST, reaction_type: "like", marker }));
    const [event] = await db.select().from(inboxWebhookEvent).where(sql`${inboxWebhookEvent.payload}::text like ${"%" + marker + "%"}`);
    expect(event!.processedAt).not.toBeNull();
    expect(event!.lastError).toBe("ignored");
  });

  it("webhook: one entry with a message and a comment handles both, and a switched-off account writes nothing", async () => {
    const commentId = nextId(`${POST}_c`);
    const mid = nextId("m_mixed");
    const res = await postWebhook({
      object: "page",
      entry: [
        {
          id: PAGE_ID,
          time: Date.now(),
          changes: [{ field: "feed", value: fbComment({ id: commentId }) }],
          messaging: [{ sender: { id: ADA }, recipient: { id: PAGE_ID }, timestamp: Date.now(), message: { mid, text: "Hello from Messenger" } }],
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await byExt(commentId)).toBeTruthy();
    expect(await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, mid))).toHaveLength(1);

    await db.update(inboxPhoneNumber).set({ isActive: false }).where(eq(inboxPhoneNumber.id, igLineId));
    const offId = nextId("ig_off");
    await postWebhook(igComments({ id: offId, from: { id: BISI, username: "bisi_juice" }, media: { id: MEDIA }, text: "x" }));
    await db.update(inboxPhoneNumber).set({ isActive: true }).where(eq(inboxPhoneNumber.id, igLineId));
    expect(await byExt(offId)).toBeUndefined();
  });

  // ── Reading and who sees what ──────────────────────────────────────────────

  it("list: a user without social.comments gets 403; a user without the account gets an empty list and 404 on the thread", async () => {
    const row = await customerComment("Who can see this?");
    await seedUser(db, { email: "till@example.com", role: "branch_staff" });
    const till = await loginAs(baseUrl, "till@example.com", "userpassword123");
    expect((await call(till, "GET", "/threads")).status).toBe(403);
    expect((await call(till, "GET", "/unread")).status).toBe(403);

    // Holds the permission, but no channel account has been given to them.
    await seedUser(db, { email: "nolines@example.com", role: "branch_staff", granted: ["social.comments"] });
    const noLines = await loginAs(baseUrl, "nolines@example.com", "userpassword123");
    const list = await call(noLines, "GET", "/threads?state=all&kind=all");
    expect(list.status).toBe(200);
    expect(list.json.data).toEqual([]);
    expect((await call(noLines, "GET", `/threads/${row.id}`)).status).toBe(404);
    expect((await call(noLines, "POST", `/comments/${row.id}/reply`, { message: "hi" })).status).toBe(404);
    expect((await call(noLines, "GET", "/accounts")).json.data).toEqual([]);
    expect((await call(noLines, "GET", "/unread")).json.data).toEqual({ threads: 0 });

    // Given the Instagram account only: sees Instagram threads, not the Page's.
    const igOnly = await seedUser(db, { email: "igonly@example.com", role: "branch_staff", granted: ["social.comments"] });
    await db.insert(inboxUserNumberAccess).values({ userId: igOnly.id, phoneNumberId: igLineId });
    const igCookie = await loginAs(baseUrl, "igonly@example.com", "userpassword123");
    const igList = await call(igCookie, "GET", "/threads?state=all&kind=all");
    expect(igList.json.data.length).toBeGreaterThan(0);
    expect(igList.json.data.every((t: { network: string }) => t.network === "instagram")).toBe(true);
    expect((await call(igCookie, "GET", `/threads/${row.id}`)).status).toBe(404);
    expect((await call(igCookie, "GET", "/accounts")).json.data.map((a: { network: string }) => a.network)).toEqual(["instagram"]);

    // The owner sees it, with the post beside it and the buttons worked out by the server.
    const mine = await call(owner, "GET", "/threads?q=Who can see");
    expect(mine.json.data.map((t: { id: string }) => t.id)).toEqual([row.id]);
    expect(mine.json.data[0]).toMatchObject({ network: "facebook", account_label: "Mrs Samuel fruit juice", unread: 1, work_state: "open", author_name: "Ada Obi" });
    const detail = await call(owner, "GET", `/threads/${row.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.data.comments[0]).toMatchObject({
      is_root: true,
      message: "Who can see this?",
      actions: { reply: true, hide: true, unhide: false, delete: true, like: true, unlike: false, private_reply: true },
    });
  });

  it("list: unread count, mark read, assign and done, with audit rows", async () => {
    const row = await customerComment("Count me");
    const before = (await call(owner, "GET", "/unread")).json.data.threads as number;
    expect(before).toBeGreaterThan(0);
    expect((await call(owner, "POST", `/threads/${row.id}/read`)).json).toEqual({ ok: true });
    expect((await call(owner, "GET", "/unread")).json.data.threads).toBe(before - 1);

    const bad = await call(owner, "PATCH", `/threads/${row.id}`, { assignee_id: crypto.randomUUID() });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toBe("That person can't work on comments");
    expect((await call(owner, "PATCH", `/threads/${row.id}`, { nope: 1 })).status).toBe(400);

    const assigned = await call(owner, "PATCH", `/threads/${row.id}`, { assignee_id: ownerId });
    expect(assigned.json.data).toMatchObject({ assignee_id: ownerId, work_state: "open" });
    expect((await call(owner, "GET", "/threads?view=mine")).json.data.map((t: { id: string }) => t.id)).toContain(row.id);
    const done = await call(owner, "PATCH", `/threads/${row.id}`, { work_state: "done" });
    expect(done.json.data).toMatchObject({ work_state: "done", unread: 0 });
    expect((await call(owner, "GET", "/threads?state=done")).json.data.map((t: { id: string }) => t.id)).toContain(row.id);
    expect(await byId(row.id)).toMatchObject({ doneByUserId: ownerId });
    const actions = (await db.select().from(auditLog).where(eq(auditLog.entityId, row.id))).map((a) => a.action).sort();
    expect(actions).toEqual(["social.comment_assign", "social.comment_state"]);
  });

  it("thread: opening it checks Meta (R13): hidden outside shows, and a comment Meta no longer has shows as deleted", async () => {
    const row = await customerComment("Refresh me");
    remoteComments.set(row.externalId!, { id: row.externalId, message: "Refresh me", is_hidden: true, like_count: 3 });
    const detail = await call(owner, "GET", `/threads/${row.id}`);
    expect(detail.json.data.thread).toMatchObject({ status: "hidden", hidden_source: "outside", refresh_error: null });
    expect(detail.json.data.comments[0]).toMatchObject({ like_count: 3, actions: { reply: false, unhide: true, delete: true, hide: false } });
    expect((await byId(row.id)).refreshedAt).not.toBeNull();
    // Fresh for a minute: opening it again asks Meta nothing.
    graphCalls = [];
    await call(owner, "GET", `/threads/${row.id}`);
    expect(graphCalls).toHaveLength(0);

    const gone = await customerComment("About to vanish");
    remoteComments.set(gone.externalId!, { status: 404, error: { message: "Unsupported get request. Object with ID does not exist", code: 100, error_subcode: 33 } });
    const after = await call(owner, "GET", `/threads/${gone.id}`);
    expect(after.json.data.thread).toMatchObject({ status: "deleted", work_state: "done" });

    // A refusal while checking is swallowed: the stored thread still shows.
    const quiet = await customerComment("Meta is down");
    nextFailure = { status: 500, error: { message: "An unknown error occurred", code: 1 } };
    const shown = await call(owner, "GET", `/threads/${quiet.id}`);
    expect(shown.status).toBe(200);
    expect(shown.json.data.thread.refresh_error).toContain("Could not check Facebook");
    expect(shown.json.data.thread.status).toBe("visible");
  });

  // ── Public reply ───────────────────────────────────────────────────────────

  it("reply: posts to {comment}/comments, stores the id, marks the thread done, writes an audit row", async () => {
    const row = await customerComment();
    const res = await call(owner, "POST", `/comments/${row.id}/reply`, { message: "  Yes, we deliver to Ikeja every day.  " });
    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({ from_business: true, message: "Yes, we deliver to Ikeja every day.", send_status: "sent", is_root: false });
    const writes = graphWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", path: `${row.externalId}/comments`, auth: `Bearer ${PAGE_TOKEN}`, body: { message: "Yes, we deliver to Ikeja every day." } });
    const reply = await byId(res.json.data.id);
    expect(reply).toMatchObject({ externalId: res.json.data.external_id, rootId: row.id, parentExternalId: row.externalId, sentByUserId: ownerId, sendStatus: "sent" });
    expect(reply.externalId).toMatch(/^c_out_/);
    expect(await byId(row.id)).toMatchObject({ workState: "done", doneByUserId: ownerId, unreadCount: 0, lastPreview: "You: Yes, we deliver to Ikeja every day." });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, "social.comment_reply"), eq(auditLog.entityId, reply.id)));
    expect(audit!.afterJson).toMatchObject({ network: "facebook", post_external_id: POST, to_comment: row.externalId, message: "Yes, we deliver to Ikeja every day.", result: "sent" });
    expect(audit!.actorUserId).toBe(ownerId);

    // On Instagram the reply goes to {comment}/replies.
    const igId = nextId("ig_c");
    await postWebhook(igComments({ id: igId, from: { id: BISI, username: "bisi_juice" }, media: { id: MEDIA }, text: "Price?" }));
    graphCalls = [];
    const igRes = await call(owner, "POST", `/comments/${(await byExt(igId))!.id}/reply`, { message: "From 1,500 naira." });
    expect(igRes.status).toBe(201);
    expect(graphWrites()[0]).toMatchObject({ method: "POST", path: `${igId}/replies` });
  });

  it("reply: the rules that stop a reply before Meta is asked (R5, R6, R8, R25, R26)", async () => {
    const row = await customerComment();
    expect((await call(owner, "POST", `/comments/${row.id}/reply`, { message: "" })).status).toBe(400);
    expect((await call(owner, "POST", `/comments/${row.id}/reply`, { message: "x".repeat(1001) })).status).toBe(400);
    await postWebhook(feed({ item: "comment", verb: "hide", comment_id: row.externalId, post_id: POST }));
    const hidden = await call(owner, "POST", `/comments/${row.id}/reply`, { message: "hi" });
    expect(hidden.status).toBe(409);
    expect(hidden.json.error.message).toBe("Show this comment again before answering it.");
    await postWebhook(feed({ item: "comment", verb: "remove", comment_id: row.externalId, post_id: POST }));
    const deleted = await call(owner, "POST", `/comments/${row.id}/reply`, { message: "hi" });
    expect(deleted.status).toBe(409);
    expect(deleted.json.error.message).toBe("This comment was deleted, so it can't be answered.");

    const off = await customerComment();
    await db.update(inboxPhoneNumber).set({ isActive: false }).where(eq(inboxPhoneNumber.id, fbLineId));
    const res = await call(owner, "POST", `/comments/${off.id}/reply`, { message: "hi" });
    const detail = await call(owner, "GET", `/threads/${off.id}`);
    await db.update(inboxPhoneNumber).set({ isActive: true }).where(eq(inboxPhoneNumber.id, fbLineId));
    expect(res.status).toBe(409);
    expect(res.json.error.message).toBe("This account is switched off in Channels.");
    // Stored comments stay readable, with no buttons.
    expect(detail.status).toBe(200);
    expect(Object.values(detail.json.data.comments[0].actions).some(Boolean)).toBe(false);
    expect(graphWrites()).toHaveLength(0);
  });

  it("reply: Meta refusal returns 502 with a failed row; nothing is retried", async () => {
    const row = await customerComment();
    nextFailure = { status: 400, error: { message: "(#1705) There was an error posting to this wall", code: 1705 } };
    const res = await call(owner, "POST", `/comments/${row.id}/reply`, { message: "Yes." });
    expect(res.status).toBe(502);
    expect(res.json.data).toMatchObject({ send_status: "failed", external_id: null });
    expect(res.json.data.error_message).toBe("Facebook refused this: (#1705) There was an error posting to this wall (code 1705).");
    expect(graphWrites()).toHaveLength(1);
    expect(await byId(res.json.data.id)).toMatchObject({ sendStatus: "failed", errorCode: "1705" });
    // The thread is still waiting for an answer.
    expect(await byId(row.id)).toMatchObject({ workState: "open" });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, "social.comment_reply"), eq(auditLog.entityId, res.json.data.id)));
    expect(audit!.afterJson).toMatchObject({ result: "failed", meta_code: "1705" });

    // A permission problem is also a 502 with the row, and tells the owner once.
    nextFailure = { status: 403, error: { message: "(#200) Permissions error", code: 200 } };
    const config = await call(owner, "POST", `/comments/${row.id}/reply`, { message: "Yes again." });
    expect(config.status).toBe(502);
    expect(config.json.data.error_message).toContain("lost its permission");
    nextFailure = { status: 403, error: { message: "(#200) Permissions error", code: 200 } };
    await call(owner, "POST", `/comments/${row.id}/reply`, { message: "Yes a third time." });
    const alerts = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "social.comments_config"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ account_id: fbLineId, label: "Mrs Samuel fruit juice", code: "200" });
    expect(JSON.stringify(alerts[0]!.payload)).not.toContain(PAGE_TOKEN);
    const [state] = await db.select().from(socialCommentAccount).where(eq(socialCommentAccount.accountId, fbLineId));
    expect(state).toMatchObject({ lastErrorCode: "200" });
    await db.delete(socialCommentAccount).where(eq(socialCommentAccount.accountId, fbLineId));
  });

  it("reply: timeout leaves the row unknown; a later webhook for the same text adopts it", async () => {
    const row = await customerComment();
    nextFailure = "timeout";
    const res = await call(owner, "POST", `/comments/${row.id}/reply`, { message: "We open at 8am." });
    expect(res.status).toBe(502);
    expect(res.json.data).toMatchObject({ send_status: "unknown", external_id: null });
    expect(graphWrites()).toHaveLength(1);
    expect(await byId(row.id)).toMatchObject({ workState: "open" });

    const realId = nextId(`${POST}_c`);
    await postWebhook(feed(fbComment({ id: realId, parent: row.externalId!, from: { id: PAGE_ID, name: "Mrs Samuel fruit juice" }, message: "We open at 8am." })));
    const replies = await db.select().from(socialComment).where(and(eq(socialComment.rootId, row.id), eq(socialComment.fromBusiness, true)));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: res.json.data.id, externalId: realId, sendStatus: "sent", sentByUserId: ownerId });
    expect(await byId(row.id)).toMatchObject({ workState: "done", doneByUserId: ownerId });
    // Still exactly one call to Meta: nothing re-sent it.
    expect(graphWrites()).toHaveLength(1);
  });

  it("reply: webhook arriving before the send result leaves exactly one row", async () => {
    const row = await customerComment();
    // (a) Meta's webhook for our reply lands while we still wait for the answer: same text.
    beforeAnswer = async (newId) => {
      await postWebhook(feed(fbComment({ id: newId, parent: row.externalId!, from: { id: PAGE_ID, name: "Mrs Samuel fruit juice" }, message: "Yes, daily." })));
    };
    const res = await call(owner, "POST", `/comments/${row.id}/reply`, { message: "Yes, daily." });
    expect(res.status).toBe(201);
    let rows = await db.select().from(socialComment).where(eq(socialComment.externalId, res.json.data.external_id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: res.json.data.id, sendStatus: "sent", sentByUserId: ownerId });

    // (b) The webhook's text differs (Meta changed it), so it could not be matched: its copy goes, ours stays.
    const second = await customerComment();
    beforeAnswer = async (newId) => {
      await postWebhook(feed(fbComment({ id: newId, parent: second.externalId!, from: { id: PAGE_ID, name: "Mrs Samuel fruit juice" }, message: "Yes,  daily! (edited by Meta)" })));
    };
    const res2 = await call(owner, "POST", `/comments/${second.id}/reply`, { message: "Yes, daily!" });
    expect(res2.status).toBe(201);
    rows = await db.select().from(socialComment).where(eq(socialComment.rootId, second.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: res2.json.data.id, externalId: res2.json.data.external_id, sendStatus: "sent", sentByUserId: ownerId });
    expect(await db.select().from(socialComment).where(and(eq(socialComment.rootId, second.id), isNull(socialComment.externalId)))).toHaveLength(0);
  });

  // ── Hide, show, delete, like ───────────────────────────────────────────────

  it("hide, unhide, delete, like: call the right endpoints and update the row", async () => {
    const row = await customerComment();
    const ext = row.externalId!;
    const hide = await call(owner, "POST", `/comments/${row.id}/hide`);
    expect(hide.status).toBe(200);
    expect(hide.json.data).toMatchObject({ status: "hidden", hidden_source: "suite", actions: { unhide: true, hide: false, reply: false } });
    // Facebook's own "hide" webhook for our action does not relabel it as hidden outside.
    await postWebhook(feed({ item: "comment", verb: "hide", comment_id: ext, post_id: POST }));
    expect(await byId(row.id)).toMatchObject({ status: "hidden", hiddenSource: "suite" });
    const unhide = await call(owner, "POST", `/comments/${row.id}/unhide`);
    expect(unhide.json.data).toMatchObject({ status: "visible", hidden_source: null });
    const like = await call(owner, "POST", `/comments/${row.id}/like`);
    expect(like.json.data).toMatchObject({ liked_by_business: true, actions: { like: false, unlike: true } });
    const unlike = await call(owner, "DELETE", `/comments/${row.id}/like`);
    expect(unlike.json.data).toMatchObject({ liked_by_business: false });
    const del = await call(owner, "DELETE", `/comments/${row.id}`);
    expect(del.status).toBe(200);
    expect(del.json.data).toMatchObject({ status: "deleted" });
    expect(await byId(row.id)).toMatchObject({ status: "deleted", workState: "done", unreadCount: 0 });

    expect(graphWrites().map((g) => [g.method, g.path, g.body])).toEqual([
      ["POST", ext, { is_hidden: true }],
      ["POST", ext, { is_hidden: false }],
      ["POST", `${ext}/likes`, null],
      ["DELETE", `${ext}/likes`, null],
      ["DELETE", ext, null],
    ]);
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, row.id));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "social.comment_delete",
      "social.comment_hide",
      "social.comment_like",
      "social.comment_unhide",
      "social.comment_unlike",
    ]);
    expect(audits.find((a) => a.action === "social.comment_delete")!.beforeJson).toMatchObject({ message: "Do you deliver to Ikeja?", author_name: "Ada Obi" });

    // Instagram hides with ?hide=true and no body.
    const igId = nextId("ig_c");
    await postWebhook(igComments({ id: igId, from: { id: BISI, username: "bisi_juice" }, media: { id: MEDIA }, text: "spam" }));
    graphCalls = [];
    await call(owner, "POST", `/comments/${(await byExt(igId))!.id}/hide`);
    expect(graphWrites()[0]).toMatchObject({ method: "POST", path: igId, query: "?hide=true", body: null });
  });

  it("hide, delete, like: Meta's answers become plain words and nothing changes locally", async () => {
    const row = await customerComment();
    nextFailure = { status: 400, error: { message: "(#613) Calls to this api have exceeded the rate limit.", code: 613 } };
    const busy = await call(owner, "POST", `/comments/${row.id}/hide`);
    expect(busy.status).toBe(503);
    expect(busy.json.error.message).toBe("Facebook is busy or is limiting how often we can ask. Nothing was changed. Try again in a few minutes.");
    expect(await byId(row.id)).toMatchObject({ status: "visible" });

    nextFailure = "timeout";
    const silent = await call(owner, "POST", `/comments/${row.id}/like`);
    expect(silent.status).toBe(504);
    expect(silent.json.error.message).toContain("No answer from Facebook");
    expect(await byId(row.id)).toMatchObject({ likedByBusiness: false });

    nextFailure = { status: 400, error: { message: "(#1705) Not allowed", code: 1705 } };
    const refused = await call(owner, "POST", `/comments/${row.id}/hide`);
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toBe("Facebook refused this: (#1705) Not allowed (code 1705).");

    // Gone at Meta: hiding says so and marks it deleted; deleting it counts as done.
    nextFailure = { status: 404, error: { message: "Unsupported get request. Object does not exist", code: 100, error_subcode: 33 } };
    const gone = await call(owner, "POST", `/comments/${row.id}/hide`);
    expect(gone.status).toBe(409);
    expect(gone.json.error.message).toBe("This comment no longer exists on Facebook.");
    expect(await byId(row.id)).toMatchObject({ status: "deleted" });

    const other = await customerComment();
    nextFailure = { status: 404, error: { message: "Unsupported get request. Object does not exist", code: 100, error_subcode: 33 } };
    const del = await call(owner, "DELETE", `/comments/${other.id}`);
    expect(del.status).toBe(200);
    expect(del.json.data.status).toBe("deleted");

    // The Page's own comment cannot be hidden; a reply still being posted cannot be touched (R6, R8).
    const ownId = nextId(`${POST}_c`);
    await postWebhook(feed(fbComment({ id: ownId, from: { id: PAGE_ID, name: "Mrs Samuel fruit juice" }, message: "Hello all" })));
    expect((await call(owner, "POST", `/comments/${(await byExt(ownId))!.id}/hide`)).status).toBe(409);
    const [queued] = await db
      .insert(socialComment)
      .values({ postId: other.postId, accountId: fbLineId, network: "facebook", rootId: other.id, fromBusiness: true, sentByUserId: ownerId, message: "…", sendStatus: "queued", commentedAt: new Date() })
      .returning();
    const wait = await call(owner, "DELETE", `/comments/${queued!.id}`);
    expect(wait.status).toBe(409);
    expect(wait.json.error.message).toBe("Wait until this reply has been posted");
  });

  it("like on instagram returns 409", async () => {
    const igId = nextId("ig_c");
    await postWebhook(igComments({ id: igId, from: { id: BISI, username: "bisi_juice" }, media: { id: MEDIA }, text: "Nice" }));
    const res = await call(owner, "POST", `/comments/${(await byExt(igId))!.id}/like`);
    expect(res.status).toBe(409);
    expect(res.json.error.message).toBe("Likes can't be given from here on Instagram");
    expect(graphWrites()).toHaveLength(0);
  });

  // ── Private reply ──────────────────────────────────────────────────────────

  it("private reply: sends recipient.comment_id, creates the identity, the conversation and one outbound message, and does not set last_inbound_wa_at", async () => {
    const row = await customerComment("Please send me your price list");
    recipientId = "PSID_ADA_1";
    const res = await call(owner, "POST", `/comments/${row.id}/private-reply`, { text: "Hello, here is our delivery price list." });
    expect(res.status).toBe(201);
    const writes = graphWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "POST",
      path: `${PAGE_ID}/messages`,
      auth: `Bearer ${PAGE_TOKEN}`,
      body: { recipient: { comment_id: row.externalId }, message: { text: "Hello, here is our delivery price list." } },
    });
    const after = await byId(row.id);
    expect(after).toMatchObject({ privateReplyStatus: "sent", privateReplyBody: "Hello, here is our delivery price list.", privateReplyByUserId: ownerId });
    expect(after.privateReplyMessageId).toMatch(/^m_out_/);
    expect(after.conversationId).not.toBeNull();
    // The thread is not marked done by a private message (R20).
    expect(after.workState).toBe("open");

    const [identity] = await db.select().from(inboxIdentity).where(eq(inboxIdentity.externalId, "PSID_ADA_1"));
    expect(identity).toMatchObject({ channel: "messenger", accountExternalId: PAGE_ID, displayName: "Ada Obi" });
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, after.conversationId!));
    expect(conv).toMatchObject({ customerId: identity!.customerId, phoneNumberId: fbLineId, channel: "messenger", identityId: identity!.id, lastPreview: "Hello, here is our delivery price list." });
    // The 24-hour window opens only when the customer answers.
    expect(conv!.lastInboundWaAt).toBeNull();
    expect(conv!.unreadCount).toBe(0);
    const messages = await db.select().from(inboxMessage).where(eq(inboxMessage.conversationId, conv!.id));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ direction: "out", type: "text", body: "Hello, here is our delivery price list.", status: "sent", senderUserId: ownerId, channel: "messenger", waMessageId: after.privateReplyMessageId });
    expect(messages[0]!.payload).toMatchObject({ comment_ref: { thread_id: row.id, comment_id: row.id, network: "facebook", excerpt: "Please send me your price list" } });

    expect(res.json.data.private_reply).toMatchObject({ status: "sent", body: "Hello, here is our delivery price list.", conversation_id: conv!.id });
    expect(res.json.data.actions.private_reply).toBe(false);
    // The inbox timeline carries the link back to the comment.
    const timeline = await fetch(`${baseUrl}/v1/inbox/conversations/${conv!.id}/timeline`, { headers: { cookie: owner } });
    const items = ((await timeline.json()) as { data: { kind: string; data: { comment_ref: unknown } }[] }).data;
    expect(items.find((i) => i.kind === "message")!.data.comment_ref).toMatchObject({ thread_id: row.id, excerpt: "Please send me your price list" });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, "social.comment_private_reply"), eq(auditLog.entityId, row.id)));
    expect(audit!.afterJson).toMatchObject({ network: "facebook", comment: row.externalId, result: "sent", conversation_id: conv!.id });

    // When the customer answers in Messenger, spec 02 puts it in the same chat and opens the window.
    await postWebhook({
      object: "page",
      entry: [{ id: PAGE_ID, time: Date.now(), messaging: [{ sender: { id: "PSID_ADA_1" }, recipient: { id: PAGE_ID }, timestamp: Date.now(), message: { mid: nextId("m_in"), text: "Thank you!" } }] }],
    });
    const [answered] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, conv!.id));
    expect(answered!.lastInboundWaAt).not.toBeNull();
    expect(await db.select().from(inboxMessage).where(eq(inboxMessage.conversationId, conv!.id))).toHaveLength(2);
  });

  it("private reply: a second one returns 409 and makes no Graph call", async () => {
    const row = await customerComment();
    recipientId = "PSID_ADA_2";
    expect((await call(owner, "POST", `/comments/${row.id}/private-reply`, { text: "First." })).status).toBe(201);
    graphCalls = [];
    const again = await call(owner, "POST", `/comments/${row.id}/private-reply`, { text: "Second." });
    expect(again.status).toBe(409);
    expect(again.json.error.message).toBe("A private message was already sent for this comment");
    expect(graphCalls).toHaveLength(0);
    expect(await byId(row.id)).toMatchObject({ privateReplyBody: "First." });
  });

  it("private reply: comment older than 7 days returns 409 and makes no Graph call", async () => {
    const row = await customerComment();
    await db.update(socialComment).set({ commentedAt: new Date(Date.now() - 8 * 24 * 3600_000) }).where(eq(socialComment.id, row.id));
    const res = await call(owner, "POST", `/comments/${row.id}/private-reply`, { text: "Hello." });
    expect(res.status).toBe(409);
    expect(res.json.error.message).toBe("This comment is more than 7 days old, so a private message can't be sent");
    expect(graphCalls).toHaveLength(0);
    expect((await byId(row.id)).privateReplyStatus).toBeNull();
  });

  it("private reply: needs inbox.reply", async () => {
    const row = await customerComment();
    const user = await seedUser(db, { email: "comments-only@example.com", role: "branch_staff", granted: ["social.comments"] });
    await db.insert(inboxUserNumberAccess).values({ userId: user.id, phoneNumberId: fbLineId });
    const cookie = await loginAs(baseUrl, "comments-only@example.com", "userpassword123");
    const res = await call(cookie, "POST", `/comments/${row.id}/private-reply`, { text: "Hello." });
    expect(res.status).toBe(403);
    expect(graphCalls).toHaveLength(0);
    // They can still read the thread and answer in public; the private-message button is not offered.
    const detail = await call(cookie, "GET", `/threads/${row.id}`);
    expect(detail.json.data.comments[0].actions).toMatchObject({ reply: true, private_reply: false });
  });

  it("private reply: a refusal or a timeout is recorded, can be tried again, and never opens a chat", async () => {
    const row = await customerComment();
    recipientId = "PSID_ADA_3";
    nextFailure = { status: 400, error: { message: "(#10) This message is sent outside of allowed window", code: 10, error_subcode: 2018278 } };
    const refused = await call(owner, "POST", `/comments/${row.id}/private-reply`, { text: "Hello." });
    expect(refused.status).toBe(502);
    expect(refused.json.data.private_reply).toMatchObject({ status: "failed", conversation_id: null });
    expect(refused.json.data.private_reply.error).toContain("Facebook refused this");
    expect(await byId(row.id)).toMatchObject({ privateReplyStatus: "failed", privateReplyErrorCode: "10/2018278", conversationId: null });
    // A refusal about one person is not a configuration problem: the owner is not alerted.
    expect(await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "social.comments_config"))).toHaveLength(1);

    nextFailure = "timeout";
    const silent = await call(owner, "POST", `/comments/${row.id}/private-reply`, { text: "Hello again." });
    expect(silent.status).toBe(502);
    expect(silent.json.data.private_reply.status).toBe("unknown");
    expect(silent.json.data.actions.private_reply).toBe(true);

    const ok = await call(owner, "POST", `/comments/${row.id}/private-reply`, { text: "Third time lucky." });
    expect(ok.status).toBe(201);
    expect(graphWrites()).toHaveLength(3);
  });

  it("private reply: with no recipient id and no author id it is sent with no conversation (R19)", async () => {
    const id = nextId(`${POST}_c`);
    const value: Record<string, unknown> = fbComment({ id });
    delete value.from;
    await postWebhook(feed(value));
    const row = (await byExt(id))!;
    recipientId = null;
    const res = await call(owner, "POST", `/comments/${row.id}/private-reply`, { text: "Hello." });
    expect(res.status).toBe(201);
    expect(await byId(row.id)).toMatchObject({ privateReplyStatus: "sent", conversationId: null });
    expect(res.json.data.private_reply).toMatchObject({ status: "sent", conversation_id: null });
  });

  it("private reply: echo with the same mid already stored does not duplicate the message", async () => {
    // (a) The echo arrives after our row is saved: spec 02 finds the mid and adds nothing.
    const first = await customerComment();
    recipientId = "PSID_ADA_4";
    const res = await call(owner, "POST", `/comments/${first.id}/private-reply`, { text: "Hello after." });
    expect(res.status).toBe(201);
    const mid = (await byId(first.id)).privateReplyMessageId!;
    const echo = (m: string, text: string, timestamp: number) => ({
      object: "page",
      entry: [{ id: PAGE_ID, time: Date.now(), messaging: [{ sender: { id: PAGE_ID }, recipient: { id: "PSID_ADA_4" }, timestamp, message: { mid: m, text, is_echo: true, app_id: Number(OUR_APP_ID) } }] }],
    });
    await postWebhook(echo(mid, "Hello after.", Date.now()));
    expect(await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, mid))).toHaveLength(1);

    // (b) The echo was stored first (it was already old when it reached us): ours joins that row.
    const second = await customerComment("Another question");
    beforeAnswer = async (m) => {
      await postWebhook(echo(m, "Hello before.", Date.now() - 60_000));
    };
    const res2 = await call(owner, "POST", `/comments/${second.id}/private-reply`, { text: "Hello before." });
    expect(res2.status).toBe(201);
    const after = await byId(second.id);
    const rows = await db.select().from(inboxMessage).where(eq(inboxMessage.waMessageId, after.privateReplyMessageId!));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: "out", senderUserId: ownerId, conversationId: after.conversationId });
    expect(rows[0]!.payload).toMatchObject({ comment_ref: { comment_id: second.id } });
    const all = await db.select().from(inboxMessage).where(eq(inboxMessage.conversationId, after.conversationId!));
    expect(all.filter((m) => m.body === "Hello before.")).toHaveLength(1);
  });

  it("private reply on Instagram goes to the Instagram account and opens an instagram chat", async () => {
    const igId = nextId("ig_c");
    await postWebhook(igComments({ id: igId, from: { id: BISI, username: "bisi_juice" }, media: { id: MEDIA }, text: "DM me" }));
    const row = (await byExt(igId))!;
    recipientId = BISI;
    const res = await call(owner, "POST", `/comments/${row.id}/private-reply`, { text: "Hello Bisi." });
    expect(res.status).toBe(201);
    expect(graphWrites()[0]).toMatchObject({ path: `${IG_ID}/messages`, body: { recipient: { comment_id: igId } } });
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, (await byId(row.id)).conversationId!));
    expect(conv).toMatchObject({ channel: "instagram", phoneNumberId: igLineId });
    expect(conv!.lastInboundWaAt).toBeNull();
  });

  // ── Rulings that touch other people's routes ───────────────────────────────

  it("erasing a contact's inbox history succeeds and removes the private message from the comment (ruling 9.2.8)", async () => {
    const row = await customerComment("Erase me", { id: "24000000000000777", name: "Chidi Eze" });
    recipientId = "PSID_CHIDI";
    expect((await call(owner, "POST", `/comments/${row.id}/private-reply`, { text: "Private words." })).status).toBe(201);
    const linked = await byId(row.id);
    const [conv] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, linked.conversationId!));
    const res = await fetch(`${baseUrl}/v1/inbox/contacts/${conv!.customerId}/erase`, {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify({ confirm: "Chidi Eze" }),
    });
    expect(res.status).toBe(200);
    const after = await byId(row.id);
    // The public comment stays; the private text and the link to the chat are gone; "sent" stays so no second one goes.
    expect(after).toMatchObject({ message: "Erase me", conversationId: null, privateReplyBody: null, privateReplyStatus: "sent" });
    expect(await db.select().from(inboxConversation).where(eq(inboxConversation.id, conv!.id))).toHaveLength(0);
  });

  it("merging two contacts keeps the comment pointing at the chat that holds its private message", async () => {
    const a = await customerComment("From profile one", { id: "24000000000000801", name: "Ngozi A" });
    recipientId = "PSID_NGOZI_1";
    await call(owner, "POST", `/comments/${a.id}/private-reply`, { text: "To profile one." });
    const b = await customerComment("From profile two", { id: "24000000000000802", name: "Ngozi B" });
    recipientId = "PSID_NGOZI_2";
    await call(owner, "POST", `/comments/${b.id}/private-reply`, { text: "To profile two." });
    const [convA] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, (await byId(a.id)).conversationId!));
    const [convB] = await db.select().from(inboxConversation).where(eq(inboxConversation.id, (await byId(b.id)).conversationId!));
    const res = await fetch(`${baseUrl}/v1/inbox/contacts/${convA!.customerId}/merge`, {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify({ into_customer_id: convB!.customerId }),
    });
    expect(res.status).toBe(200);
    expect((await byId(a.id)).conversationId).toBe(convB!.id);
    expect((await byId(b.id)).conversationId).toBe(convB!.id);
  });

  // ── Accounts, re-sync and the hook for spec 09 ─────────────────────────────

  it("accounts: lists the Page and the Instagram account; sync needs channels.manage and clears the first-load marks", async () => {
    await db
      .insert(socialCommentAccount)
      .values({ accountId: fbLineId, backfilledAt: new Date(), backfillStartedAt: new Date(), lastError: "Something went wrong", pausedUntil: new Date(Date.now() + 3600_000) })
      .onConflictDoUpdate({ target: socialCommentAccount.accountId, set: { backfilledAt: new Date(), lastError: "Something went wrong" } });
    const list = await call(owner, "GET", "/accounts");
    expect(list.json.data).toEqual([
      expect.objectContaining({ id: igLineId, label: "Instagram", network: "instagram", comments_ready: false, last_error: null }),
      expect.objectContaining({ id: fbLineId, label: "Mrs Samuel fruit juice", network: "facebook", comments_ready: true, last_error: "Something went wrong" }),
    ]);

    await seedUser(db, { email: "manager@example.com", role: "manager" });
    const manager = await loginAs(baseUrl, "manager@example.com", "userpassword123");
    expect((await call(manager, "POST", "/sync", { account_id: fbLineId })).status).toBe(403);
    expect((await call(owner, "POST", "/sync", { account_id: crypto.randomUUID() })).status).toBe(404);
    const res = await call(owner, "POST", "/sync", { account_id: fbLineId });
    expect(res.status).toBe(202);
    const [state] = await db.select().from(socialCommentAccount).where(eq(socialCommentAccount.accountId, fbLineId));
    expect(state).toMatchObject({ backfilledAt: null, backfillStartedAt: null, pausedUntil: null, lastError: null });
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "social.comment_resync"), eq(auditLog.entityId, fbLineId)))).toHaveLength(1);
  });

  it("registerSocialPostRef (the hook for spec 09) records a published post once, and comments then attach to it", async () => {
    const externalId = `${PAGE_ID}_9001`;
    const first = await registerSocialPostRef(db, {
      network: "facebook",
      accountExternalId: PAGE_ID,
      externalId,
      permalink: "https://www.facebook.com/posts/9001",
      caption: "Weekend offer",
      publishedAt: new Date("2026-11-19T09:00:00Z"),
    });
    const again = await registerSocialPostRef(db, { network: "facebook", accountExternalId: PAGE_ID, externalId, permalink: null, caption: null });
    expect(first).not.toBeNull();
    expect(again).toEqual(first);
    const [post] = await db.select().from(socialPostRef).where(eq(socialPostRef.externalId, externalId));
    expect(post).toMatchObject({ id: first!.id, accountId: fbLineId, message: "Weekend offer", permalinkUrl: "https://www.facebook.com/posts/9001", fetchedAt: null });
    expect(await registerSocialPostRef(db, { network: "instagram", accountExternalId: "17841400000009999", externalId: "x" })).toBeNull();

    const id = nextId(`${externalId}_c`);
    await postWebhook(feed(fbComment({ id, post: externalId })));
    expect((await byExt(id))!.postId).toBe(first!.id);
  });
});

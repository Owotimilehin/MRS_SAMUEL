import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { adminUser, createDbClient, inboxPhoneNumber, inboxWebhookEvent, outboxEvent, socialComment, socialCommentAccount, socialPostRef } from "@ms/db";
import { clearPageTokenCache, PAGE_WEBHOOK_FIELDS, type MetaConfig } from "@ms/domain";
import { backfillComments, fillCommentDetails, pollComments } from "./social-comments.js";
import { retryWebhookEvents } from "./inbox-whatsapp.js";

/**
 * Suite spec 03 worker jobs, against a real Postgres. Every Graph API call is
 * stubbed by path; nothing reaches Meta. Names and IDs are made up.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");
const PAGE_ID = "100200300400";
const IG_ID = "17841400000000001";
const log = { info: () => {}, warn: () => {}, error: () => {} };
const cfg: MetaConfig = { token: "itest-system-user-token", graphVersion: "v23.0", appId: "APP1" };
const NOW = new Date("2026-11-19T12:00:00Z");
const iso = (d: Date) => d.toISOString().replace(".000Z", "+0000");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

type Call = { method: string; path: string; query: string };
let calls: Call[] = [];
/** GET answers by path (the part after the version). A function sees the query string. */
const answers = new Map<string, unknown | ((query: string) => unknown)>();
/** Paths that answer with a Meta error. */
const errors = new Map<string, { status: number; error: Record<string, unknown> }>();
let subscribedFields: string[] = [...PAGE_WEBHOOK_FIELDS];

function installStub(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://graph.facebook.com/")) throw new Error(`unexpected network call in test: ${url}`);
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const p = decodeURIComponent(u.pathname.replace(/^\/v[\d.]+\//, ""));
    const query = decodeURIComponent(u.search);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (query.includes("fields=access_token")) return ok({ access_token: "itest-worker-page-token" });
    calls.push({ method, path: p, query });
    const err = errors.get(p);
    if (err) return new Response(JSON.stringify({ error: err.error }), { status: err.status });
    if (p.endsWith("/subscribed_apps")) {
      if (method === "POST") {
        subscribedFields = (u.searchParams.get("subscribed_fields") ?? "").split(",");
        return ok({ success: true });
      }
      return ok({ data: [{ id: "APP1", subscribed_fields: subscribedFields }] });
    }
    if (method !== "GET") throw new Error(`the comment jobs must only read from Meta: ${method} ${p}`);
    const a = answers.get(p);
    return ok(typeof a === "function" ? (a as (q: string) => unknown)(query) : (a ?? { data: [] }));
  }) as typeof fetch;
}

const reads = (suffix: string) => calls.filter((c) => c.method === "GET" && c.path.endsWith(suffix));

describe("spec 03 worker: comments", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let fbId: string;
  let igId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());
    installStub();
    const line = (kind: "messenger" | "instagram", externalId: string, label: string) =>
      db.insert(inboxPhoneNumber).values({ kind, e164: null, externalId, pageExternalId: PAGE_ID, label, channels: "whatsapp" }).returning();
    fbId = (await line("messenger", PAGE_ID, "Facebook Page"))[0]!.id;
    igId = (await line("instagram", IG_ID, "Instagram"))[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(async () => {
    calls = [];
    answers.clear();
    errors.clear();
    subscribedFields = [...PAGE_WEBHOOK_FIELDS];
    clearPageTokenCache();
    await db.delete(socialComment);
    await db.delete(socialPostRef);
    await db.delete(socialCommentAccount);
    await db.delete(outboxEvent);
    await db.update(inboxPhoneNumber).set({ isActive: true });
  });

  const state = async (accountId: string) => (await db.select().from(socialCommentAccount).where(eq(socialCommentAccount.accountId, accountId)))[0];
  const comment = async (externalId: string) => (await db.select().from(socialComment).where(eq(socialComment.externalId, externalId)))[0];
  /** Only the Facebook Page takes part (the Instagram line is switched off) unless a test says otherwise. */
  const facebookOnly = () => db.update(inboxPhoneNumber).set({ isActive: false }).where(eq(inboxPhoneNumber.id, igId));
  const instagramOnly = () => db.update(inboxPhoneNumber).set({ isActive: false }).where(eq(inboxPhoneNumber.id, fbId));

  const POST_A = `${PAGE_ID}_1`;
  const POST_B = `${PAGE_ID}_2`;
  function facebookFeed(): void {
    answers.set(`${PAGE_ID}/feed`, {
      data: [
        { id: POST_A, message: "Old post", created_time: iso(hoursAgo(240)), updated_time: iso(hoursAgo(200)), permalink_url: "https://www.facebook.com/posts/1", full_picture: "https://cdn.example.test/a.jpg" },
        { id: POST_B, message: "New post", created_time: iso(hoursAgo(30)), updated_time: iso(hoursAgo(1)), permalink_url: "https://www.facebook.com/posts/2" },
      ],
    });
    // Meta lists newest first; a reply sits before its parent.
    answers.set(`${POST_A}/comments`, {
      data: [
        { id: "a_reply", message: "Yes we do", created_time: iso(hoursAgo(199)), from: { id: PAGE_ID, name: "Facebook Page" }, parent: { id: "a_old" } },
        { id: "a_old", message: "Do you deliver?", created_time: iso(hoursAgo(200)), from: { id: "U1", name: "Ada Obi" }, like_count: 2 },
      ],
    });
    answers.set(`${POST_B}/comments`, {
      data: [
        { id: "b_new", message: "How much is it?", created_time: iso(hoursAgo(1)), from: { id: "U2", name: "Chidi Eze" }, is_hidden: true },
        { id: "b_mid", message: "Lovely", created_time: iso(hoursAgo(20)), from: { id: "U3", name: "Ngozi A" } },
      ],
    });
  }

  it("does nothing when Meta is not set up, and skips a switched-off account", async () => {
    expect(await backfillComments(db, log, null, NOW)).toBe(0);
    expect(await pollComments(db, log, null, NOW)).toBe(0);
    expect(await fillCommentDetails(db, log, null, NOW)).toBe(0);
    await db.update(inboxPhoneNumber).set({ isActive: false });
    expect(await backfillComments(db, log, cfg, NOW)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("backfill: loads posts and comments oldest first and marks old ones done", async () => {
    await facebookOnly();
    facebookFeed();
    expect(await backfillComments(db, log, cfg, NOW)).toBe(4);

    // The Page is subscribed to feed and mention on top of the messaging fields it had.
    expect(subscribedFields).toEqual([...PAGE_WEBHOOK_FIELDS, "feed", "mention"]);
    expect(reads("/feed")[0]!.query).toContain(`since=${Math.floor((NOW.getTime() - 30 * 86400_000) / 1000)}`);
    expect(reads("/feed")[0]!.query).toContain("limit=50");

    const old = (await comment("a_old"))!;
    const reply = (await comment("a_reply"))!;
    // Older than 48 hours: done, nothing unread (R21). The parent was stored before its reply.
    expect(old).toMatchObject({ rootId: null, workState: "done", unreadCount: 0, likeCount: 2, needsFetch: false, authorName: "Ada Obi" });
    expect(reply).toMatchObject({ rootId: old.id, fromBusiness: true });
    expect(old.lastPreview).toBe("You: Yes we do");
    // Newer ones are waiting; one was hidden on Facebook itself.
    expect(await comment("b_mid")).toMatchObject({ workState: "open", unreadCount: 1 });
    expect(await comment("b_new")).toMatchObject({ workState: "open", unreadCount: 1, status: "hidden", hiddenSource: "outside" });

    const posts = await db.select().from(socialPostRef);
    expect(posts).toHaveLength(2);
    const a = posts.find((p) => p.externalId === POST_A)!;
    expect(a).toMatchObject({ accountId: fbId, network: "facebook", message: "Old post", pictureUrl: "https://cdn.example.test/a.jpg", permalinkUrl: "https://www.facebook.com/posts/1" });
    expect(a.fetchedAt).not.toBeNull();
    expect(a.remoteUpdatedAt?.toISOString()).toBe(hoursAgo(200).toISOString());
    expect((await state(fbId))!.backfilledAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("backfill: running twice inserts nothing new", async () => {
    await facebookOnly();
    facebookFeed();
    await backfillComments(db, log, cfg, NOW);
    const before = await db.select().from(socialComment);
    // Finished: the job leaves the account alone.
    calls = [];
    expect(await backfillComments(db, log, cfg, NOW)).toBe(0);
    expect(calls).toHaveLength(0);
    // "Try again" clears the marks; the load runs again and only adds what is missing.
    await db.update(socialCommentAccount).set({ backfilledAt: null, backfillStartedAt: null }).where(eq(socialCommentAccount.accountId, fbId));
    expect(await backfillComments(db, log, cfg, new Date(NOW.getTime() + 60_000))).toBe(0);
    const after = await db.select().from(socialComment);
    expect(after).toHaveLength(before.length);
    expect(after.map((c) => [c.externalId, c.unreadCount, c.workState]).sort()).toEqual(before.map((c) => [c.externalId, c.unreadCount, c.workState]).sort());
    // The subscription already had both fields: it is read, not written again.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("poll: only fetches comments for posts whose count changed", async () => {
    await instagramOnly();
    const media = (count1: number, count2: number) => ({
      data: [
        { id: "m1", caption: "Mango", media_type: "IMAGE", media_url: "https://cdn.example.test/m1.jpg", permalink: "https://www.instagram.com/p/1/", timestamp: iso(hoursAgo(50)), comments_count: count1 },
        { id: "m2", caption: "Pineapple", media_type: "IMAGE", permalink: "https://www.instagram.com/p/2/", timestamp: iso(hoursAgo(40)), comments_count: count2 },
      ],
    });
    answers.set(`${IG_ID}/media`, media(1, 0));
    answers.set("m1/comments", { data: [{ id: "ig1", text: "Price?", timestamp: iso(hoursAgo(3)), username: "bisi_juice", from: { id: "IGU1", username: "bisi_juice" } }] });
    await backfillComments(db, log, cfg, NOW);
    expect(await comment("ig1")).toMatchObject({ network: "instagram", accountId: igId, authorUsername: "bisi_juice", workState: "open", unreadCount: 1 });

    // Too soon: Instagram is asked at most every 5 minutes.
    calls = [];
    expect(await pollComments(db, log, cfg, new Date(NOW.getTime() + 2 * 60_000))).toBe(0);
    expect(calls).toHaveLength(0);

    // Nothing moved: one call (the list of posts), no comment reads.
    const later = new Date(NOW.getTime() + 6 * 60_000);
    expect(await pollComments(db, log, cfg, later)).toBe(0);
    expect(reads("/media")).toHaveLength(1);
    expect(reads("/comments")).toHaveLength(0);

    // m2 gained a comment: only m2 is read. A reply by our own account raises no unread.
    calls = [];
    answers.set(`${IG_ID}/media`, media(1, 2));
    answers.set("m2/comments", {
      data: [
        {
          id: "ig2",
          text: "Do you ship to Abuja?",
          timestamp: iso(hoursAgo(0.05)),
          username: "tunde_k",
          replies: { data: [{ id: "ig3", text: "Yes!", timestamp: iso(hoursAgo(0.01)), from: { id: IG_ID, username: "mrs_samuelfruitjuice" } }] },
        },
      ],
    });
    expect(await pollComments(db, log, cfg, new Date(later.getTime() + 6 * 60_000))).toBe(2);
    expect(reads("/comments").map((c) => c.path)).toEqual(["m2/comments"]);
    const root = (await comment("ig2"))!;
    expect(root).toMatchObject({ workState: "open", unreadCount: 1, lastPreview: "You: Yes!" });
    expect(await comment("ig3")).toMatchObject({ rootId: root.id, fromBusiness: true });
    const [m2] = await db.select().from(socialPostRef).where(eq(socialPostRef.externalId, "m2"));
    expect(m2!.remoteCommentCount).toBe(2);
    // Instagram needs no Page subscription call.
    expect(calls.filter((c) => c.path.endsWith("/subscribed_apps"))).toHaveLength(0);
  });

  it("poll: Facebook re-reads a post whose updated_time moved, at most every 30 minutes, and keeps feed subscribed", async () => {
    await facebookOnly();
    facebookFeed();
    await backfillComments(db, log, cfg, NOW);
    calls = [];
    expect(await pollComments(db, log, cfg, new Date(NOW.getTime() + 10 * 60_000))).toBe(0);
    expect(calls).toHaveLength(0);

    // Something dropped `feed` from the subscription (a messaging-only re-subscribe): the poll puts it back.
    subscribedFields = [...PAGE_WEBHOOK_FIELDS];
    const feed = answers.get(`${PAGE_ID}/feed`) as { data: Record<string, unknown>[] };
    feed.data[1]!.updated_time = iso(new Date(NOW.getTime() + 20 * 60_000));
    answers.set(`${POST_B}/comments`, {
      data: [
        { id: "b_newer", message: "Still waiting", created_time: iso(new Date(NOW.getTime() + 20 * 60_000)), from: { id: "U2", name: "Chidi Eze" } },
        { id: "b_new", message: "How much is it?", created_time: iso(hoursAgo(1)), from: { id: "U2", name: "Chidi Eze" }, is_hidden: false },
      ],
    });
    expect(await pollComments(db, log, cfg, new Date(NOW.getTime() + 31 * 60_000))).toBe(1);
    expect(reads("/comments").map((c) => c.path)).toEqual([`${POST_B}/comments`]);
    expect(subscribedFields).toEqual([...PAGE_WEBHOOK_FIELDS, "feed", "mention"]);
    expect(await comment("b_newer")).toMatchObject({ workState: "open", unreadCount: 1 });
    // The comment that had been hidden on Facebook is showing again.
    expect(await comment("b_new")).toMatchObject({ status: "visible", hiddenSource: null, unreadCount: 1 });
  });

  it("fill: reads a new post's details, and a gone post is marked unavailable", async () => {
    await facebookOnly();
    const [ok] = await db.insert(socialPostRef).values({ accountId: fbId, network: "facebook", externalId: `${PAGE_ID}_77` }).returning();
    const [gone] = await db.insert(socialPostRef).values({ accountId: fbId, network: "facebook", externalId: `${PAGE_ID}_78` }).returning();
    answers.set(`${PAGE_ID}_77`, { id: `${PAGE_ID}_77`, story: "Mrs Samuel shared a photo.", created_time: iso(hoursAgo(5)), permalink_url: "https://www.facebook.com/posts/77", full_picture: "https://cdn.example.test/77.jpg" });
    errors.set(`${PAGE_ID}_78`, { status: 404, error: { message: "Unsupported get request. Object with ID does not exist", code: 100, error_subcode: 33 } });
    expect(await fillCommentDetails(db, log, cfg, NOW)).toBe(1);
    const [a] = await db.select().from(socialPostRef).where(eq(socialPostRef.id, ok!.id));
    expect(a).toMatchObject({ message: "Mrs Samuel shared a photo.", pictureUrl: "https://cdn.example.test/77.jpg", permalinkUrl: "https://www.facebook.com/posts/77", fetchError: null });
    expect(a!.fetchedAt).not.toBeNull();
    // The poll's own marks are not touched by this job, so the next poll still reads the post's comments.
    expect(a!.remoteUpdatedAt).toBeNull();
    const [b] = await db.select().from(socialPostRef).where(eq(socialPostRef.id, gone!.id));
    expect(b).toMatchObject({ fetchError: "no longer available", fetchAttempts: 5, fetchedAt: null });
    // Given up: not asked again.
    calls = [];
    expect(await fillCommentDetails(db, log, cfg, new Date(NOW.getTime() + 60_000))).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await state(fbId))?.pausedUntil ?? null).toBeNull();
  });

  it("fill: a placeholder gets its text; when it is itself a reply its parent becomes the thread (R11); a gone one is marked deleted", async () => {
    await facebookOnly();
    const [post] = await db.insert(socialPostRef).values({ accountId: fbId, network: "facebook", externalId: POST_A, fetchedAt: NOW }).returning();
    const base = { postId: post!.id, accountId: fbId, network: "facebook", commentedAt: hoursAgo(1) };
    const [plain] = await db.insert(socialComment).values({ ...base, externalId: "p_plain", needsFetch: true, unreadCount: 1, lastPreview: "Me too" }).returning();
    const [nested] = await db.insert(socialComment).values({ ...base, externalId: "p_nested", needsFetch: true, unreadCount: 2, lastPreview: "Same here" }).returning();
    const [child] = await db.insert(socialComment).values({ ...base, externalId: "p_child", rootId: nested!.id, parentExternalId: "p_nested", message: "Same here" }).returning();
    const [lost] = await db.insert(socialComment).values({ ...base, externalId: "p_lost", needsFetch: true, unreadCount: 1 }).returning();
    answers.set("p_plain", { id: "p_plain", message: "Is it sweet?", created_time: iso(hoursAgo(3)), from: { id: "U9", name: "Kemi B" } });
    answers.set("p_nested", { id: "p_nested", message: "I want one", created_time: iso(hoursAgo(2)), from: { id: "U8", name: "Tunde K" }, parent: { id: "p_top" } });
    errors.set("p_lost", { status: 404, error: { message: "Unsupported get request. Object does not exist", code: 100 } });

    expect(await fillCommentDetails(db, log, cfg, NOW)).toBe(2);
    const reload = async (id: string) => (await db.select().from(socialComment).where(eq(socialComment.id, id)))[0]!;
    expect(await reload(plain!.id)).toMatchObject({ message: "Is it sweet?", authorName: "Kemi B", needsFetch: false, rootId: null, unreadCount: 1 });
    expect((await reload(plain!.id)).commentedAt.toISOString()).toBe(hoursAgo(3).toISOString());

    const top = (await comment("p_top"))!;
    // The real top-level comment is a new placeholder that carries the thread; the worker fetches it next.
    expect(top).toMatchObject({ rootId: null, needsFetch: true, unreadCount: 2, lastPreview: "Same here", workState: "open" });
    expect(await reload(nested!.id)).toMatchObject({ rootId: top.id, parentExternalId: "p_top", message: "I want one", unreadCount: 0, needsFetch: false });
    expect(await reload(child!.id)).toMatchObject({ rootId: top.id });
    expect(await reload(lost!.id)).toMatchObject({ status: "deleted", needsFetch: false, workState: "done", unreadCount: 0 });
  });

  it("fill: a reply left queued for two minutes becomes 'not confirmed' and is never sent", async () => {
    await facebookOnly();
    const [user] = await db.insert(adminUser).values({ email: "staff-worker@example.com", passwordHash: "x", role: "manager" }).returning();
    const [post] = await db.insert(socialPostRef).values({ accountId: fbId, network: "facebook", externalId: POST_A, fetchedAt: NOW }).returning();
    const base = { postId: post!.id, accountId: fbId, network: "facebook", commentedAt: hoursAgo(1) };
    const [root] = await db.insert(socialComment).values({ ...base, externalId: "q_root", message: "Hello?", privateReplyStatus: "queued", privateReplyAt: new Date(NOW.getTime() - 5 * 60_000), privateReplyBody: "Hi" }).returning();
    const queued = { ...base, rootId: root!.id, fromBusiness: true, sentByUserId: user!.id, message: "Yes", sendStatus: "queued" };
    const [stuck] = await db.insert(socialComment).values({ ...queued, createdAt: new Date(NOW.getTime() - 3 * 60_000) }).returning();
    const [fresh] = await db.insert(socialComment).values({ ...queued, createdAt: new Date(NOW.getTime() - 30_000) }).returning();
    expect(await fillCommentDetails(db, log, cfg, NOW)).toBe(2);
    const rows = await db.select().from(socialComment).where(eq(socialComment.rootId, root!.id));
    expect(rows.find((r) => r.id === stuck!.id)).toMatchObject({ sendStatus: "unknown", externalId: null });
    expect(rows.find((r) => r.id === fresh!.id)).toMatchObject({ sendStatus: "queued" });
    expect((await db.select().from(socialComment).where(eq(socialComment.id, root!.id)))[0]).toMatchObject({ privateReplyStatus: "unknown" });
    // Nothing was written to Meta (the stub throws on any write that is not the subscription).
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("temporary error pauses the account", async () => {
    await facebookOnly();
    errors.set(`${PAGE_ID}/feed`, { status: 400, error: { message: "(#80001) There have been too many calls to this Page account.", code: 80001 } });
    expect(await backfillComments(db, log, cfg, NOW)).toBe(0);
    let s = (await state(fbId))!;
    // Paused for an hour, and left unfinished so the load resumes.
    expect(s.pausedUntil?.toISOString()).toBe(new Date(NOW.getTime() + 60 * 60_000).toISOString());
    expect(s.backfilledAt).toBeNull();
    expect(s.lastError).toBeNull();
    calls = [];
    expect(await backfillComments(db, log, cfg, new Date(NOW.getTime() + 40 * 60_000))).toBe(0);
    expect(await fillCommentDetails(db, log, cfg, new Date(NOW.getTime() + 40 * 60_000))).toBe(0);
    expect(calls).toHaveLength(0);

    // After the pause it resumes and finishes.
    errors.clear();
    facebookFeed();
    expect(await backfillComments(db, log, cfg, new Date(NOW.getTime() + 61 * 60_000))).toBe(4);
    s = (await state(fbId))!;
    expect(s.backfilledAt).not.toBeNull();

    // In the fill job a busy answer pauses the account for 15 minutes and counts an attempt.
    const [post] = await db.insert(socialPostRef).values({ accountId: fbId, network: "facebook", externalId: `${PAGE_ID}_90` }).returning();
    errors.set(`${PAGE_ID}_90`, { status: 400, error: { message: "(#613) Calls to this api have exceeded the rate limit.", code: 613 } });
    const t = new Date(NOW.getTime() + 3 * 3600_000);
    await db.update(socialCommentAccount).set({ pausedUntil: null }).where(eq(socialCommentAccount.accountId, fbId));
    await fillCommentDetails(db, log, cfg, t);
    expect((await state(fbId))!.pausedUntil?.toISOString()).toBe(new Date(t.getTime() + 15 * 60_000).toISOString());
    expect((await db.select().from(socialPostRef).where(eq(socialPostRef.id, post!.id)))[0]).toMatchObject({ fetchAttempts: 1, fetchedAt: null });
  });

  it("the webhook retry applies a stored comment event through the same dispatch as the API", async () => {
    const value = { item: "comment", verb: "add", comment_id: `${POST_A}_retry`, post_id: POST_A, parent_id: POST_A, from: { id: "U5", name: "Kemi B" }, message: "Any sugar-free one?", created_time: Math.floor(NOW.getTime() / 1000) };
    const [event] = await db
      .insert(inboxWebhookEvent)
      .values({
        source: "meta",
        kind: "page.feed",
        payload: { object: "page", entry: [{ id: PAGE_ID, time: Math.floor(NOW.getTime() / 1000), changes: [{ field: "feed", value }] }] },
        receivedAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning();
    expect(await retryWebhookEvents(db, log)).toBeGreaterThanOrEqual(1);
    expect(await comment(`${POST_A}_retry`)).toMatchObject({ accountId: fbId, message: "Any sugar-free one?", workState: "open", unreadCount: 1 });
    const [after] = await db.select().from(inboxWebhookEvent).where(eq(inboxWebhookEvent.id, event!.id));
    expect(after!.processedAt).not.toBeNull();
    expect(after!.lastError).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a permission error tells the owner once, pauses an hour and shows on the Comments page (R23)", async () => {
    await facebookOnly();
    errors.set(`${PAGE_ID}/feed`, { status: 403, error: { message: "(#283) Requires pages_read_engagement permission", code: 283 } });
    await backfillComments(db, log, cfg, NOW);
    // Tried again after the pause: still refused, but only one alert in 24 hours.
    await backfillComments(db, log, cfg, new Date(NOW.getTime() + 61 * 60_000));
    const alerts = await db.select().from(outboxEvent).where(eq(outboxEvent.eventType, "social.comments_config"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ account_id: fbId, label: "Facebook Page", code: "283" });
    expect(JSON.stringify(alerts[0]!.payload)).not.toContain("itest-worker-page-token");
    const s = (await state(fbId))!;
    expect(s).toMatchObject({ lastErrorCode: "283", backfilledAt: null });
    expect(s.lastError).toContain("pages_read_engagement");
    expect(s.pausedUntil).not.toBeNull();
    // The other account is untouched by this one's trouble.
    expect(await db.select().from(socialComment).where(and(eq(socialComment.accountId, igId)))).toHaveLength(0);
  });
});

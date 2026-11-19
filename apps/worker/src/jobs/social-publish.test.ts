import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { appSetting, createDbClient, inboxPhoneNumber, socialPost, socialPostTarget, SOCIAL_PUBLISHING_KEY } from "@ms/db";
import { clearPageTokenCache, postFingerprint } from "@ms/domain";
import { NOT_RUNNING_NOTE, SWITCHED_OFF_NOTE, publishDuePosts, reconcileUnknownTargets } from "./social-publish.js";

/**
 * Suite spec 09 worker jobs, against a real Postgres (testcontainers). The Graph API is
 * stubbed and any other network call fails the test. The tokens below are fake.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../../../packages/db/migrations");
const PAGE_ID = "100200300400";
const log = { info: () => {}, warn: () => {}, error: () => {} };
const cfg = { token: "itest-worker-system-token", graphVersion: "v23.0" };

interface GraphCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
let graphCalls: GraphCall[] = [];
let feedPostMode: "ok" | "timeout" = "ok";
let feedRows: Record<string, unknown>[] = [];
let postNo = 5000;

function installStub(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/")) throw new Error(`unexpected network call in test: ${href}`);
    const url = new URL(href);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.searchParams.get("fields") === "access_token") return ok({ access_token: "itest-worker-page-token" });
    const method = (init?.method ?? "GET").toUpperCase();
    const p = url.pathname.replace(/^\/v[\d.]+\//, "");
    graphCalls.push({ method, path: p, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    if (p === `${PAGE_ID}/feed` && method === "POST") {
      if (feedPostMode === "timeout") throw new TypeError("fetch failed");
      return ok({ id: `${PAGE_ID}_${++postNo}` });
    }
    if (p === `${PAGE_ID}/feed` && method === "GET") return ok({ data: feedRows });
    if (url.searchParams.get("fields") === "permalink_url") return ok({ permalink_url: `https://www.facebook.com/${p}` });
    return ok({});
  }) as typeof fetch;
}

const feedPosts = () => graphCalls.filter((c) => c.method === "POST" && c.path === `${PAGE_ID}/feed`);

describe("spec 09 worker: publishing posts", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let accountId: string;

  /** A text post for the Page with one Facebook target, approved (its fingerprint stored) unless told otherwise. */
  async function makePost(over: Partial<typeof socialPost.$inferInsert> = {}, targetOver: Partial<typeof socialPostTarget.$inferInsert> = {}) {
    const [post] = await db
      .insert(socialPost)
      .values({ kind: "text", caption: "Fresh juice today", status: "scheduled", approvedAt: new Date(), ...over })
      .returning();
    const [target] = await db
      .insert(socialPostTarget)
      .values({ postId: post!.id, accountId, network: "facebook", nextAttemptAt: new Date(Date.now() - 60_000), ...targetOver })
      .returning();
    if (over.approvedHash === undefined) {
      await db
        .update(socialPost)
        .set({ approvedHash: postFingerprint(post!, [target!]) })
        .where(eq(socialPost.id, post!.id));
    }
    return { postId: post!.id, targetId: target!.id };
  }
  const postRow = async (id: string) => (await db.select().from(socialPost).where(eq(socialPost.id, id)))[0]!;
  const targetRow = async (id: string) => (await db.select().from(socialPostTarget).where(eq(socialPostTarget.id, id)))[0]!;
  const switchScheduling = async (on: boolean) => {
    await db
      .insert(appSetting)
      .values({ key: SOCIAL_PUBLISHING_KEY, value: { scheduled_enabled: on } })
      .onConflictDoUpdate({ target: appSetting.key, set: { value: { scheduled_enabled: on } } });
  };
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const sql = postgres(container.getConnectionUri(), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
    await sql.end();
    db = createDbClient(container.getConnectionUri());
    installStub();
    const [line] = await db
      .insert(inboxPhoneNumber)
      .values({ kind: "messenger", e164: null, externalId: PAGE_ID, pageExternalId: PAGE_ID, label: "Facebook Page", channels: "whatsapp" })
      .returning();
    accountId = line!.id;
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  beforeEach(async () => {
    graphCalls = [];
    feedPostMode = "ok";
    feedRows = [];
    clearPageTokenCache();
    await db.delete(socialPost);
    await db.delete(appSetting).where(eq(appSetting.key, SOCIAL_PUBLISHING_KEY));
  });

  it("publishDuePosts: promotes a due post, leaves a future one", async () => {
    await switchScheduling(true);
    const due = await makePost({ scheduledAt: minutesAgo(1) });
    const future = await makePost({ scheduledAt: new Date(Date.now() + 3_600_000), caption: "Tomorrow's special" });

    expect(await publishDuePosts(db, log, { cfg, signUrl: null })).toBe(1);

    expect((await postRow(due.postId)).status).toBe("published");
    const sent = await targetRow(due.targetId);
    expect(sent).toMatchObject({ status: "published", step: "done", attempts: 1, externalKind: "post" });
    expect(sent.externalId).toMatch(new RegExp(`^${PAGE_ID}_\\d+$`));
    expect(sent.permalink).toContain("https://www.facebook.com/");
    expect(feedPosts()).toHaveLength(1);
    expect(feedPosts()[0]!.body).toEqual({ message: "Fresh juice today" });

    expect((await postRow(future.postId)).status).toBe("scheduled");
    expect((await targetRow(future.targetId)).status).toBe("pending");

    // Running again sends nothing more.
    expect(await publishDuePosts(db, log, { cfg, signUrl: null })).toBe(0);
    expect(feedPosts()).toHaveLength(1);
  });

  it("publishDuePosts: a post up to 60 minutes late still goes out", async () => {
    await switchScheduling(true);
    const late = await makePost({ scheduledAt: minutesAgo(59) });
    expect(await publishDuePosts(db, log, { cfg, signUrl: null })).toBe(1);
    expect((await postRow(late.postId)).status).toBe("published");
  });

  it("publishDuePosts: a post 61 minutes late becomes missed", async () => {
    await switchScheduling(true);
    const late = await makePost({ scheduledAt: minutesAgo(61) });
    expect(await publishDuePosts(db, log, { cfg, signUrl: null })).toBe(0);
    expect(await postRow(late.postId)).toMatchObject({ status: "missed", statusNote: NOT_RUNNING_NOTE });
    expect((await targetRow(late.targetId)).status).toBe("pending");
    expect(graphCalls).toHaveLength(0);
  });

  it("publishDuePosts: owner switch off makes a due post missed", async () => {
    // No settings row at all means off (the default).
    const a = await makePost({ scheduledAt: minutesAgo(1) });
    expect(await publishDuePosts(db, log, { cfg, signUrl: null })).toBe(0);
    expect(await postRow(a.postId)).toMatchObject({ status: "missed", statusNote: SWITCHED_OFF_NOTE });

    await switchScheduling(false);
    const b = await makePost({ scheduledAt: minutesAgo(1) });
    expect(await publishDuePosts(db, log, { cfg, signUrl: null })).toBe(0);
    expect(await postRow(b.postId)).toMatchObject({ status: "missed", statusNote: SWITCHED_OFF_NOTE });

    // Rule 7: turning the switch back on does not send missed posts.
    await switchScheduling(true);
    expect(await publishDuePosts(db, log, { cfg, signUrl: null })).toBe(0);
    expect((await postRow(a.postId)).status).toBe("missed");
    expect((await postRow(b.postId)).status).toBe("missed");
    expect(graphCalls).toHaveLength(0);
  });

  it("publishDuePosts: fingerprint mismatch fails the post and calls nothing", async () => {
    await switchScheduling(true);
    const p = await makePost({ scheduledAt: minutesAgo(1), approvedHash: "0".repeat(64) });
    expect(await publishDuePosts(db, log, { cfg, signUrl: null })).toBe(0);
    expect(await postRow(p.postId)).toMatchObject({
      status: "failed",
      statusNote: "The post changed after it was approved, so it was not sent.",
    });
    expect((await targetRow(p.targetId)).status).toBe("pending");
    expect(graphCalls).toHaveLength(0);

    // A "post now" post (never scheduled) gets the same check before its first call.
    const q = await makePost({ status: "publishing", approvedHash: "1".repeat(64) });
    expect(await publishDuePosts(db, log, { cfg, signUrl: null })).toBe(0);
    expect((await postRow(q.postId)).status).toBe("failed");
    expect(graphCalls).toHaveLength(0);
  });

  it("publishDuePosts: drafts, and anything without Meta configured, are never sent", async () => {
    const d = await makePost({ status: "draft" });
    expect(await publishDuePosts(db, log, { cfg, signUrl: null })).toBe(0);
    expect((await postRow(d.postId)).status).toBe("draft");
    const p = await makePost({ status: "publishing" });
    expect(await publishDuePosts(db, log, { cfg: null, signUrl: null })).toBe(0);
    expect((await targetRow(p.targetId)).status).toBe("pending");
    expect(graphCalls).toHaveLength(0);
  });

  it("publishDuePosts: a timeout on the publish call is never followed by a second call", async () => {
    const p = await makePost({ status: "publishing" });
    feedPostMode = "timeout";
    expect(await publishDuePosts(db, log, { cfg, signUrl: null })).toBe(0);
    expect(await targetRow(p.targetId)).toMatchObject({ status: "unknown", attempts: 1, externalId: null });
    expect((await postRow(p.postId)).status).toBe("needs_check");
    expect(feedPosts()).toHaveLength(1);

    // Facebook is healthy again, and the worker comes round several times: nothing is sent.
    feedPostMode = "ok";
    for (let i = 0; i < 3; i++) {
      expect(await publishDuePosts(db, log, { cfg, signUrl: null, now: new Date(Date.now() + (i + 1) * 3_600_000) })).toBe(0);
    }
    expect(feedPosts()).toHaveLength(1);
    expect((await targetRow(p.targetId)).status).toBe("unknown");
  });

  it("reconcileUnknownTargets: after 3 checks the post is needs_check", async () => {
    const p = await makePost({ status: "publishing" }, { status: "unknown", step: "publish", attempts: 1, lockedAt: new Date() });
    for (let i = 1; i <= 3; i++) {
      expect(await reconcileUnknownTargets(db, log, { cfg })).toBe(0);
      expect(await targetRow(p.targetId)).toMatchObject({ status: "unknown", reconcileChecks: i });
    }
    expect((await postRow(p.postId)).status).toBe("needs_check");
    const looks = graphCalls.filter((c) => c.method === "GET" && c.path === `${PAGE_ID}/feed`).length;
    expect(looks).toBe(3);

    // After three looks only a person moves it on.
    expect(await reconcileUnknownTargets(db, log, { cfg })).toBe(0);
    expect(graphCalls.filter((c) => c.method === "GET" && c.path === `${PAGE_ID}/feed`)).toHaveLength(3);
    expect(await targetRow(p.targetId)).toMatchObject({ status: "unknown", reconcileChecks: 3 });
    expect(feedPosts()).toHaveLength(0);
  });

  it("reconcileUnknownTargets: a target stuck in publishing becomes unknown, then is linked when the Page shows the post", async () => {
    const lockedAt = minutesAgo(6);
    const p = await makePost({ status: "publishing" }, { status: "publishing", step: "publish", attempts: 1, lockedAt });
    feedRows = [
      { id: `${PAGE_ID}_7001`, message: "Fresh juice today", created_time: new Date(lockedAt.getTime() + 2000).toISOString(), permalink_url: "https://www.facebook.com/100200300400/posts/7001" },
    ];
    expect(await reconcileUnknownTargets(db, log, { cfg })).toBe(1);
    expect(await targetRow(p.targetId)).toMatchObject({
      status: "published",
      externalId: `${PAGE_ID}_7001`,
      externalKind: "post",
      permalink: "https://www.facebook.com/100200300400/posts/7001",
    });
    expect((await postRow(p.postId)).status).toBe("published");
    expect(feedPosts()).toHaveLength(0);

    // One claimed a moment ago is left alone: its worker may still be waiting for the answer.
    const q = await makePost({ status: "publishing" }, { status: "publishing", step: "publish", attempts: 1, lockedAt: new Date() });
    expect(await reconcileUnknownTargets(db, log, { cfg })).toBe(0);
    expect((await targetRow(q.targetId)).status).toBe("publishing");
  });
});

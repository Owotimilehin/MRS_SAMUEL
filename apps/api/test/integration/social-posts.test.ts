import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { and, eq, like } from "drizzle-orm";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { appSetting, auditLog, inboxPhoneNumber, outboxEvent, socialPost, socialPostTarget, SOCIAL_PUBLISHING_KEY } from "@ms/db";
import { clearPageTokenCache } from "@ms/domain";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";

/**
 * Suite spec 09: /v1/social. The Graph API is stubbed and nothing reaches Meta. These
 * routes never publish (the worker does); the stub still answers the publishing
 * endpoints so the tests can prove the API did not call them. The tokens below are fake.
 */

const PAGE_TOKEN = "itest-token-page-must-never-leak";
const SYSTEM_TOKEN = "itest-token-system-user";
const PAGE_ID = "100200300";
const IG_ID = "17841400000000001";
const OFF_PAGE_ID = "100200400";
const KEY_A = "social/posts/2026/11/0b0e5f1c-1a2b-4c3d-8e9f-001122334455.jpg";
const KEY_B = "social/posts/2026/11/0b0e5f1c-1a2b-4c3d-8e9f-001122334466.jpg";

type Obj = Record<string, unknown>;
interface GraphCall {
  method: string;
  path: string;
  body: Obj | null;
  auth: string;
}

let calls: GraphCall[] = [];
/** Refuse the next call whose method and path-ending match. */
let refuse: { method: string; pathEnds: string; code: number; message: string } | null = null;
let feed: Obj[] = [];
let quota: { used: number; total: number } | "error" = { used: 3, total: 50 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function resetStub(): void {
  calls = [];
  refuse = null;
  feed = [];
  quota = { used: 3, total: 50 };
}

function installGraphStub(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith("https://graph.facebook.com/") && !href.startsWith("https://graph-video.facebook.com/")) return real(input, init);
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Obj) : null;
    const path = url.pathname.replace(/^\/v[\d.]+/, "");

    // The Page-token look-up is not part of what we assert on.
    if (url.searchParams.get("fields") === "access_token") return json({ id: PAGE_ID, access_token: PAGE_TOKEN });
    calls.push({ method, path, body, auth });
    if (auth !== `Bearer ${PAGE_TOKEN}`) return json({ error: { message: "A Page token is needed", code: 100 } }, 400);

    if (refuse && refuse.method === method && path.endsWith(refuse.pathEnds)) {
      const r = refuse;
      refuse = null;
      return json({ error: { message: r.message, code: r.code } }, 400);
    }
    if (path.endsWith("/content_publishing_limit")) {
      if (quota === "error") return json({ error: { message: "Unsupported get request", code: 100 } }, 400);
      return json({ data: [{ quota_usage: quota.used, config: { quota_total: quota.total, quota_duration: 86400 } }] });
    }
    if (url.searchParams.get("fields") === "status_code") return json({ status_code: "FINISHED" });
    if (path.endsWith("/feed") && method === "GET") return json({ data: feed });
    // Publishing endpoints: answered, but these routes must never call them.
    if (path.endsWith("/feed") || path.endsWith("/photos") || path.endsWith("/videos")) return json({ id: `${PAGE_ID}_70001`, post_id: `${PAGE_ID}_70001` });
    if (path.endsWith("/media") && method === "POST") return json({ id: "17990000000000001" });
    if (path.endsWith("/media_publish")) return json({ id: "17990000000000002" });
    if (path.endsWith("/media") && method === "GET") return json({ data: [] });
    // Editing or removing one object by its ID.
    if (method === "POST" || method === "DELETE") return json({ success: true });
    return json({});
  }) as typeof fetch;
}

const PUBLISH_PATHS = ["/feed", "/photos", "/videos", "/media", "/media_publish"];
const publishCalls = () => calls.filter((c) => c.method === "POST" && PUBLISH_PATHS.some((p) => c.path.endsWith(p)));

describe("suite spec 09 — /v1/social", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let owner: string;
  let admin: string;
  let manager: string;
  let ownerId: string;
  let adminId: string;
  let fb: string;
  let ig: string;
  let off: string;
  let phone: string;
  /** Every response body this file has seen, to prove no token leaves the server. */
  const bodies: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads many response shapes
  async function call(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}/v1/social${path}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  /** The token POST /uploads would have given this user for this key. */
  const tokenFor = (userId: string, key: string): string =>
    crypto.createHmac("sha256", process.env.JWT_SIGNING_KEY!).update(`social-upload:${userId}:${key}`).digest("base64url");
  const picture = (key: string, userId: string, over: Obj = {}): Obj => ({
    key,
    upload_token: tokenFor(userId, key),
    mime: "image/jpeg",
    bytes: 500_000,
    width: 1080,
    height: 1080,
    duration_s: null,
    alt_text: null,
    ...over,
  });
  const textBody = (over: Obj = {}): Obj => ({ kind: "text", caption: "Suite test 1", media: [], targets: [{ account_id: fb }], ...over });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostJson
  async function draft(cookie: string, over: Obj = {}): Promise<any> {
    const res = await call(cookie, "POST", "/posts", textBody(over));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.data;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostJson
  async function approvedNow(cookie: string, over: Obj = {}): Promise<any> {
    const d = await draft(cookie, over);
    const res = await call(cookie, "POST", `/posts/${d.id}/approve`, { when: "now", content_hash: d.content_hash });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.data;
  }
  /** A post whose every target is out (as the worker would leave it), with made-up external IDs. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostJson
  async function published(cookie: string, externalNo: number, over: Obj = {}): Promise<any> {
    const p = await approvedNow(cookie, over);
    for (const t of p.targets as { id: string; network: string }[]) {
      await db
        .update(socialPostTarget)
        .set({
          status: "published",
          step: "done",
          externalId: t.network === "facebook" ? `${PAGE_ID}_${externalNo}` : `1790000000000${externalNo}`,
          externalKind: t.network === "facebook" ? "post" : "media",
          publishedAt: new Date(),
          lockedAt: new Date(),
          attempts: 1,
        })
        .where(eq(socialPostTarget.id, t.id));
    }
    await db.update(socialPost).set({ status: "published" }).where(eq(socialPost.id, p.id));
    return (await call(cookie, "GET", `/posts/${p.id}`)).json.data;
  }
  const audits = (action: string, postId: string) =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.entityId, postId)));
  const switchScheduling = async (on: boolean) => {
    await db
      .insert(appSetting)
      .values({ key: SOCIAL_PUBLISHING_KEY, value: { scheduled_enabled: on } })
      .onConflictDoUpdate({ target: appSetting.key, set: { value: { scheduled_enabled: on } } });
  };
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    process.env.META_APP_SECRET = "itest-meta-app-key";
    process.env.META_SYSTEM_USER_TOKEN = SYSTEM_TOKEN;
    process.env.META_GRAPH_VERSION = "v23.0";
    installGraphStub();
    ownerId = (await seedOwner(db)).id;
    adminId = (await seedUser(db, { email: "admin@example.com", role: "admin" })).id;
    await seedUser(db, { email: "manager@example.com", role: "manager" });

    const [p] = await db
      .insert(inboxPhoneNumber)
      .values({ e164: "+2348000000000", label: "Main line", channels: "both", wabaId: "WABA1", waPhoneNumberId: "1098765432" })
      .returning();
    phone = p!.id;
    const inserted = await db
      .insert(inboxPhoneNumber)
      .values([
        { kind: "messenger", e164: null, externalId: PAGE_ID, pageExternalId: PAGE_ID, externalName: "Mrs Samuel fruit juice", label: "Facebook Page", channels: "whatsapp" },
        { kind: "instagram", e164: null, externalId: IG_ID, pageExternalId: PAGE_ID, externalName: "mrs_samuelfruitjuice", label: "Instagram", channels: "whatsapp" },
        { kind: "messenger", e164: null, externalId: OFF_PAGE_ID, pageExternalId: OFF_PAGE_ID, externalName: "Old Page", label: "Old Page", channels: "whatsapp", isActive: false },
      ])
      .returning({ id: inboxPhoneNumber.id, externalId: inboxPhoneNumber.externalId });
    fb = inserted.find((r) => r.externalId === PAGE_ID)!.id;
    ig = inserted.find((r) => r.externalId === IG_ID)!.id;
    off = inserted.find((r) => r.externalId === OFF_PAGE_ID)!.id;

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    owner = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    admin = await loginAs(baseUrl, "admin@example.com", "userpassword123");
    manager = await loginAs(baseUrl, "manager@example.com", "userpassword123");
  }, 120_000);

  beforeEach(async () => {
    resetStub();
    clearPageTokenCache();
    await db.delete(appSetting).where(eq(appSetting.key, SOCIAL_PUBLISHING_KEY));
  });

  afterAll(async () => {
    server.close();
    await container?.stop();
  });

  it("403 without social.publish on every route", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const tid = "00000000-0000-4000-8000-000000000002";
    const attempts: [string, string, unknown?][] = [
      ["GET", "/accounts"],
      ["POST", "/uploads", { filename: "a.jpg", content_type: "image/jpeg", size_bytes: 1000 }],
      ["GET", "/posts"],
      ["GET", `/posts/${id}`],
      ["POST", "/posts", textBody()],
      ["PATCH", `/posts/${id}`, { ...textBody(), base_updated_at: new Date().toISOString() }],
      ["DELETE", `/posts/${id}`],
      ["POST", `/posts/${id}/approve`, { when: "now", content_hash: "0".repeat(64) }],
      ["POST", `/posts/${id}/cancel`],
      ["POST", `/posts/${id}/targets/${tid}/retry`, { content_hash: "0".repeat(64) }],
      ["POST", `/posts/${id}/targets/${tid}/check`],
      ["POST", `/posts/${id}/targets/${tid}/resolve`, { outcome: "posted" }],
      ["PATCH", `/posts/${id}/targets/${tid}/published`, { message: "x" }],
      ["DELETE", `/posts/${id}/targets/${tid}/published`],
      ["GET", "/settings"],
      ["PUT", "/settings", { scheduled_enabled: true }],
    ];
    for (const [method, path, body] of attempts) {
      expect((await call(manager, method, path, body)).status, `${method} ${path}`).toBe(403);
      expect((await call("", method, path, body)).status, `${method} ${path} signed out`).toBe(401);
    }
    expect(calls).toHaveLength(0);
    expect(await db.select().from(socialPost)).toHaveLength(0);
  });

  it("GET /accounts lists the active Page and Instagram account, with the Instagram quota when it can be read", async () => {
    const res = await call(admin, "GET", "/accounts");
    expect(res.status).toBe(200);
    expect(res.json.scheduling_enabled).toBe(false);
    expect(res.json.data).toEqual([
      { id: ig, label: "Instagram", network: "instagram", quota: { used: 3, total: 50 } },
      { id: fb, label: "Facebook Page", network: "facebook", quota: null },
    ]);
    // Neither the phone line nor the switched-off Page is offered.
    expect(JSON.stringify(res.json)).not.toContain(phone);
    expect(JSON.stringify(res.json)).not.toContain(off);

    quota = "error";
    const again = await call(admin, "GET", "/accounts");
    expect(again.status).toBe(200);
    expect(again.json.data.find((a: { id: string }) => a.id === ig).quota).toBeNull();
  });

  it("create draft, list it under Drafts, edit it, delete it", async () => {
    const d = await draft(admin);
    expect(d).toMatchObject({ kind: "text", caption: "Suite test 1", status: "draft", scheduled_at: null, approved_by: null, approved_at: null });
    expect(d.created_by.id).toBe(adminId);
    expect(d.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.targets).toHaveLength(1);
    expect(d.targets[0]).toMatchObject({ account_id: fb, account_label: "Facebook Page", network: "facebook", status: "pending", problems: [] });

    const ids = async (status: string) => ((await call(admin, "GET", `/posts?status=${status}`)).json.data as { id: string }[]).map((p) => p.id);
    expect(await ids("draft")).toContain(d.id);
    expect(await ids("all")).toContain(d.id);
    expect(await ids("scheduled")).not.toContain(d.id);
    expect(await ids("posted")).not.toContain(d.id);
    expect(await ids("problems")).not.toContain(d.id);

    // Edit: the text changes, Instagram is added, the Facebook target keeps its row.
    const edited = await call(admin, "PATCH", `/posts/${d.id}`, {
      ...textBody({ caption: "Edited text", targets: [{ account_id: fb }, { account_id: ig, caption_override: "For Instagram" }] }),
      base_updated_at: d.updated_at,
    });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect(edited.json.data).toMatchObject({ caption: "Edited text", status: "draft" });
    expect(edited.json.data.content_hash).not.toBe(d.content_hash);
    const fbTarget = edited.json.data.targets.find((t: { network: string }) => t.network === "facebook");
    const igTarget = edited.json.data.targets.find((t: { network: string }) => t.network === "instagram");
    expect(fbTarget.id).toBe(d.targets[0].id);
    expect(igTarget).toMatchObject({ account_id: ig, caption_override: "For Instagram" });
    // A text post cannot go to Instagram: saved as a draft all the same, with the problem listed.
    expect(igTarget.problems.map((p: { code: string }) => p.code)).toEqual(["ig_needs_media"]);

    // Rule 14: someone working from the old version is told so.
    const stale = await call(admin, "PATCH", `/posts/${d.id}`, { ...textBody({ caption: "Late edit" }), base_updated_at: d.updated_at });
    expect(stale.status).toBe(409);
    expect(stale.json.error.message).toBe("Someone else changed this post. Reload to see their version.");

    // An account that is a phone line, switched off, or named twice is refused.
    for (const targets of [[{ account_id: phone }], [{ account_id: off }], [{ account_id: fb }, { account_id: fb }]]) {
      const bad = await call(admin, "POST", "/posts", textBody({ targets }));
      expect(bad.status).toBe(400);
      expect(bad.json.error.message).toBe("Pick a connected Facebook Page or Instagram account");
    }

    expect((await audits("social.post_create", d.id))).toHaveLength(1);
    const [updateRow] = await audits("social.post_update", d.id);
    expect(updateRow!.beforeJson).toMatchObject({ caption: "Suite test 1" });
    expect(updateRow!.afterJson).toMatchObject({ caption: "Edited text" });

    const del = await call(admin, "DELETE", `/posts/${d.id}`);
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true });
    expect((await call(admin, "GET", `/posts/${d.id}`)).status).toBe(404);
    expect(await db.select().from(socialPostTarget).where(eq(socialPostTarget.postId, d.id))).toHaveLength(0);
    expect((await audits("social.post_delete", d.id))).toHaveLength(1);

    for (const bad of ["not-a-uuid", "00000000-0000-4000-8000-000000000009"]) {
      expect((await call(admin, "GET", `/posts/${bad}`)).status, bad).toBe(404);
      expect((await call(admin, "DELETE", `/posts/${bad}`)).status, bad).toBe(404);
    }
  });

  it("upload token from another user is rejected", async () => {
    const photo = (media: Obj[]) => textBody({ kind: "photo", caption: "A picture", media });

    // The admin's token, used by the owner.
    const stolen = await call(owner, "POST", "/posts", photo([picture(KEY_A, adminId)]));
    expect(stolen.status).toBe(400);
    expect(stolen.json.error.message).toBe("That upload isn't yours to use");
    // No token at all, and a token for a different file.
    const bare = picture(KEY_A, adminId);
    delete bare.upload_token;
    expect((await call(admin, "POST", "/posts", photo([bare]))).status).toBe(400);
    expect((await call(admin, "POST", "/posts", photo([{ ...picture(KEY_A, adminId), key: KEY_B }]))).status).toBe(400);
    // A key outside social/posts/ never passes the shape check.
    expect((await call(admin, "POST", "/posts", photo([{ ...picture(KEY_A, adminId), key: "inbox/outgoing/2026/11/0b0e5f1c-1a2b-4c3d-8e9f-001122334455.jpg" }]))).status).toBe(400);

    // Their own upload is accepted.
    const mine = await call(admin, "POST", "/posts", photo([picture(KEY_A, adminId, { alt_text: "A glass of juice" })]));
    expect(mine.status, JSON.stringify(mine.json)).toBe(201);
    expect(mine.json.data.media).toHaveLength(1);
    expect(mine.json.data.media[0]).toMatchObject({ key: KEY_A, mime: "image/jpeg", alt_text: "A glass of juice" });
    expect(mine.json.data.media[0].upload_token).toBeUndefined();

    // On an edit, the file already on the post needs no token; a new file does.
    const id = mine.json.data.id;
    const kept = picture(KEY_A, adminId);
    delete kept.upload_token;
    const keep = await call(owner, "PATCH", `/posts/${id}`, { ...photo([kept]), base_updated_at: mine.json.data.updated_at });
    expect(keep.status, JSON.stringify(keep.json)).toBe(200);
    const add = await call(owner, "PATCH", `/posts/${id}`, {
      ...textBody({ kind: "album", caption: "Two", media: [kept, picture(KEY_B, adminId)] }),
      base_updated_at: keep.json.data.updated_at,
    });
    expect(add.status).toBe(400);
    expect(add.json.error.message).toBe("That upload isn't yours to use");

    // POST /uploads checks the type and size before anything else.
    const wrongType = await call(admin, "POST", "/uploads", { filename: "a.png", content_type: "image/png", size_bytes: 1000 });
    expect(wrongType.status).toBe(400);
    expect(wrongType.json.error.message).toBe("This file type can't be used in a post. Use a JPEG picture or an MP4 or MOV video.");
    const tooBig = await call(admin, "POST", "/uploads", { filename: "a.jpg", content_type: "image/jpeg", size_bytes: 9 * 1024 * 1024 });
    expect(tooBig.status).toBe(400);
    expect(tooBig.json.error.message).toBe("File is too large (max 8 MB)");
    // Allowed: 201 with a token, or 503 when this test run has no storage configured.
    const ok = await call(admin, "POST", "/uploads", { filename: "a.jpg", content_type: "image/jpeg", size_bytes: 1000 });
    expect([201, 503]).toContain(ok.status);
    if (ok.status === 201) {
      expect(ok.json.data.object_key).toMatch(/^social\/posts\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
      expect(ok.json.data.upload_token).toBe(tokenFor(adminId, ok.json.data.object_key));
    }
  });

  it("approve with a stale content_hash returns 409", async () => {
    const d = await draft(admin);
    const wrong = await call(admin, "POST", `/posts/${d.id}/approve`, { when: "now", content_hash: "0".repeat(64) });
    expect(wrong.status).toBe(409);
    expect(wrong.json.error.message).toBe("This post changed while you were looking at it. Check it again.");

    // Someone edits the post while the confirm dialog is open: the hash the dialog holds is now stale.
    const edit = await call(owner, "PATCH", `/posts/${d.id}`, { ...textBody({ caption: "Changed underneath" }), base_updated_at: d.updated_at });
    expect(edit.status).toBe(200);
    const stale = await call(admin, "POST", `/posts/${d.id}/approve`, { when: "now", content_hash: d.content_hash });
    expect(stale.status).toBe(409);
    expect(stale.json.error.message).toBe("This post changed while you were looking at it. Check it again.");

    const [row] = await db.select().from(socialPost).where(eq(socialPost.id, d.id));
    expect(row).toMatchObject({ status: "draft", approvedBy: null, approvedHash: null });
    expect(await audits("social.post_approve", d.id)).toHaveLength(0);
  });

  it("approve with a blocking problem returns 422 and lists it", async () => {
    const d = await draft(admin, { targets: [{ account_id: ig }] });
    expect(d.targets[0].problems).toEqual([{ code: "ig_needs_media", message: "Instagram posts need a picture or a video.", blocking: true }]);

    const res = await call(admin, "POST", `/posts/${d.id}/approve`, { when: "now", content_hash: d.content_hash });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("validation_failed");
    expect(res.json.error.message).toBe("Instagram posts need a picture or a video.");
    expect(res.json.error.details.problems).toEqual([
      { code: "ig_needs_media", message: "Instagram posts need a picture or a video.", blocking: true, target_id: d.targets[0].id, network: "instagram" },
    ]);
    const [row] = await db.select().from(socialPost).where(eq(socialPost.id, d.id));
    expect(row!.status).toBe("draft");

    // An account switched off after the draft was written also stops it.
    const d2 = await draft(admin);
    await db.update(inboxPhoneNumber).set({ isActive: false }).where(eq(inboxPhoneNumber.id, fb));
    try {
      const offRes = await call(admin, "POST", `/posts/${d2.id}/approve`, { when: "now", content_hash: d2.content_hash });
      expect(offRes.status).toBe(422);
      expect(offRes.json.error.message).toBe("This account is switched off in Channels.");
    } finally {
      await db.update(inboxPhoneNumber).set({ isActive: true }).where(eq(inboxPhoneNumber.id, fb));
    }
  });

  it("schedule is refused while the owner switch is off", async () => {
    const d = await draft(admin);
    const res = await call(admin, "POST", `/posts/${d.id}/approve`, { when: "schedule", scheduled_at: inAnHour(), content_hash: d.content_hash });
    expect(res.status).toBe(409);
    expect(res.json.error.message).toBe("Scheduling is switched off. Ask the owner to turn it on in Posts settings.");
    const [row] = await db.select().from(socialPost).where(eq(socialPost.id, d.id));
    expect(row).toMatchObject({ status: "draft", scheduledAt: null, approvedHash: null });

    // The owner is refused too: the switch is the rule, not the role.
    const asOwner = await call(owner, "POST", `/posts/${d.id}/approve`, { when: "schedule", scheduled_at: inAnHour(), content_hash: d.content_hash });
    expect(asOwner.status).toBe(409);

    // With the switch on, the time must be 10 minutes to 90 days ahead, and a time must be given.
    await switchScheduling(true);
    const soon = await call(admin, "POST", `/posts/${d.id}/approve`, {
      when: "schedule",
      scheduled_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      content_hash: d.content_hash,
    });
    expect(soon.status).toBe(422);
    expect(soon.json.error.message).toBe("Pick a time at least 10 minutes from now.");
    const far = await call(admin, "POST", `/posts/${d.id}/approve`, {
      when: "schedule",
      scheduled_at: new Date(Date.now() + 91 * 86_400_000).toISOString(),
      content_hash: d.content_hash,
    });
    expect(far.status).toBe(422);
    expect(far.json.error.message).toBe("Pick a time within the next 90 days.");
    expect((await call(admin, "POST", `/posts/${d.id}/approve`, { when: "schedule", content_hash: d.content_hash })).status).toBe(400);
  });

  it("PUT /settings is refused for an admin, allowed for the owner", async () => {
    expect((await call(admin, "GET", "/settings")).json).toEqual({ data: { scheduled_enabled: false } });

    const refused = await call(admin, "PUT", "/settings", { scheduled_enabled: true });
    expect(refused.status).toBe(403);
    expect(refused.json.error.message).toBe("Only the owner can change this");
    expect((await call(admin, "GET", "/settings")).json.data.scheduled_enabled).toBe(false);

    const ok = await call(owner, "PUT", "/settings", { scheduled_enabled: true });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ data: { scheduled_enabled: true } });
    expect((await call(admin, "GET", "/settings")).json.data.scheduled_enabled).toBe(true);
    expect((await call(admin, "GET", "/accounts")).json.scheduling_enabled).toBe(true);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "social.settings_update"), eq(auditLog.entityId, SOCIAL_PUBLISHING_KEY)));
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow.actorUserId).toBe(ownerId);
    expect(lastRow.entityType).toBe("app_settings");
    expect(lastRow.afterJson).toEqual({ scheduled_enabled: true });

    expect((await call(owner, "PUT", "/settings", { scheduled_enabled: "yes" })).status).toBe(400);
  });

  it("approve now sets targets pending and writes social.post_approve to the audit log", async () => {
    const d = await draft(admin);
    const res = await call(admin, "POST", `/posts/${d.id}/approve`, { when: "now", content_hash: d.content_hash });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.data).toMatchObject({ status: "publishing", scheduled_at: null, content_hash: d.content_hash });
    expect(res.json.data.approved_by.id).toBe(adminId);
    expect(res.json.data.approved_at).not.toBeNull();
    expect(res.json.data.targets[0]).toMatchObject({ status: "pending", attempts: 0, error_message: null });

    const [row] = await db.select().from(socialPost).where(eq(socialPost.id, d.id));
    expect(row).toMatchObject({ status: "publishing", approvedBy: adminId, approvedHash: d.content_hash });
    const [target] = await db.select().from(socialPostTarget).where(eq(socialPostTarget.postId, d.id));
    expect(target).toMatchObject({ status: "pending", step: "start", attempts: 0, containerId: null, childIds: [] });

    const rows = await audits("social.post_approve", d.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(adminId);
    expect(rows[0]!.afterJson).toEqual({
      hash: d.content_hash,
      when: "now",
      scheduled_at: null,
      targets: [{ network: "facebook", account_id: fb, caption: "Suite test 1" }],
    });

    // Rule 17: a second click finds nothing to approve.
    const again = await call(admin, "POST", `/posts/${d.id}/approve`, { when: "now", content_hash: d.content_hash });
    expect(again.status).toBe(409);
    expect(again.json.error.message).toBe("This post is not waiting to be approved");
    expect(await audits("social.post_approve", d.id)).toHaveLength(1);

    // Approving records a decision. It is the worker that posts: this API made no publishing call.
    expect(publishCalls()).toHaveLength(0);
  });

  it("editing a scheduled post returns it to draft and clears approval", async () => {
    await switchScheduling(true);
    const d = await draft(admin);
    const at = inAnHour();
    const res = await call(admin, "POST", `/posts/${d.id}/approve`, { when: "schedule", scheduled_at: at, content_hash: d.content_hash });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.data).toMatchObject({ status: "scheduled", scheduled_at: at });
    expect(res.json.data.approved_by.id).toBe(adminId);
    const scheduledIds = ((await call(admin, "GET", "/posts?status=scheduled")).json.data as { id: string }[]).map((p) => p.id);
    expect(scheduledIds).toContain(d.id);

    const edit = await call(admin, "PATCH", `/posts/${d.id}`, { ...textBody({ caption: "Second thoughts" }), base_updated_at: res.json.data.updated_at });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    expect(edit.json.data).toMatchObject({ status: "draft", caption: "Second thoughts", scheduled_at: null, approved_by: null, approved_at: null });
    const [row] = await db.select().from(socialPost).where(eq(socialPost.id, d.id));
    expect(row).toMatchObject({ status: "draft", approvedBy: null, approvedAt: null, approvedHash: null, scheduledAt: null });
  });

  it("cancel after publishing started returns 409", async () => {
    // A scheduled post can be cancelled: it goes back to the drafts.
    await switchScheduling(true);
    const d = await draft(admin);
    await call(admin, "POST", `/posts/${d.id}/approve`, { when: "schedule", scheduled_at: inAnHour(), content_hash: d.content_hash });
    const cancelled = await call(admin, "POST", `/posts/${d.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.data).toMatchObject({ status: "draft", scheduled_at: null, approved_by: null });
    expect(await audits("social.post_cancel", d.id)).toHaveLength(1);

    // Once it has started going out it is too late, and it can no longer be edited or deleted.
    const p = await approvedNow(admin);
    const late = await call(admin, "POST", `/posts/${p.id}/cancel`);
    expect(late.status).toBe(409);
    expect(late.json.error.message).toBe("Too late: this post has already started going out.");
    const edit = await call(admin, "PATCH", `/posts/${p.id}`, { ...textBody({ caption: "Too late" }), base_updated_at: p.updated_at });
    expect(edit.status).toBe(409);
    expect(edit.json.error.message).toBe("This post has already gone out. Edit it on the post's page.");
    const del = await call(admin, "DELETE", `/posts/${p.id}`);
    expect(del.status).toBe(409);
    expect(del.json.error.message).toBe("This post has gone out, so it is kept for the record.");
    const [row] = await db.select().from(socialPost).where(eq(socialPost.id, p.id));
    expect(row).toMatchObject({ status: "publishing", caption: "Suite test 1" });

    expect((await call(admin, "POST", "/posts/00000000-0000-4000-8000-000000000009/cancel")).status).toBe(404);
  });

  it("retry needs the approved content; check and resolve settle a target we could not be sure about", async () => {
    // A target that failed: "Try again" re-arms it only with the hash that was approved.
    const failed = await approvedNow(admin);
    const ft = failed.targets[0].id;
    await db.update(socialPostTarget).set({ status: "failed", attempts: 4, errorMessage: "Facebook is busy." }).where(eq(socialPostTarget.id, ft));
    await db.update(socialPost).set({ status: "failed" }).where(eq(socialPost.id, failed.id));
    const wrong = await call(admin, "POST", `/posts/${failed.id}/targets/${ft}/retry`, { content_hash: "0".repeat(64) });
    expect(wrong.status).toBe(409);
    expect(wrong.json.error.message).toBe("This post changed while you were looking at it. Check it again.");
    const retried = await call(admin, "POST", `/posts/${failed.id}/targets/${ft}/retry`, { content_hash: failed.content_hash });
    expect(retried.status, JSON.stringify(retried.json)).toBe(200);
    expect(retried.json.data.status).toBe("publishing");
    expect(retried.json.data.targets[0]).toMatchObject({ status: "pending", attempts: 0, error_message: null });
    expect(await audits("social.post_retry", failed.id)).toHaveLength(1);
    // Not failed any more: a second "Try again" is refused.
    expect((await call(admin, "POST", `/posts/${failed.id}/targets/${ft}/retry`, { content_hash: failed.content_hash })).status).toBe(409);

    // A target we could not be sure about.
    const unknown = async () => {
      const p = await approvedNow(admin);
      await db
        .update(socialPostTarget)
        .set({ status: "unknown", step: "publish", attempts: 1, lockedAt: new Date() })
        .where(eq(socialPostTarget.id, p.targets[0].id));
      await db.update(socialPost).set({ status: "needs_check" }).where(eq(socialPost.id, p.id));
      return { id: p.id as string, tid: p.targets[0].id as string };
    };

    // "Check again": exactly one post with the same text is on the Page, so it is linked.
    const a = await unknown();
    feed = [{ id: `${PAGE_ID}_81001`, message: "Suite test 1", created_time: new Date().toISOString(), permalink_url: "https://www.facebook.com/100200300/posts/81001" }];
    const checked = await call(admin, "POST", `/posts/${a.id}/targets/${a.tid}/check`);
    expect(checked.status, JSON.stringify(checked.json)).toBe(200);
    expect(checked.json.data.status).toBe("published");
    expect(checked.json.data.targets[0]).toMatchObject({
      status: "published",
      external_id: `${PAGE_ID}_81001`,
      permalink: "https://www.facebook.com/100200300/posts/81001",
    });
    // Settled: the three buttons no longer apply.
    expect((await call(admin, "POST", `/posts/${a.id}/targets/${a.tid}/check`)).status).toBe(409);
    expect((await call(admin, "POST", `/posts/${a.id}/targets/${a.tid}/resolve`, { outcome: "posted" })).status).toBe(409);

    // "Check again" with nothing on the Page: still unknown.
    const b = await unknown();
    feed = [];
    const still = await call(admin, "POST", `/posts/${b.id}/targets/${b.tid}/check`);
    expect(still.status).toBe(200);
    expect(still.json.data.targets[0].status).toBe("unknown");
    expect(still.json.data.status).toBe("needs_check");

    // "It is there".
    const posted = await call(admin, "POST", `/posts/${b.id}/targets/${b.tid}/resolve`, { outcome: "posted" });
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    expect(posted.json.data).toMatchObject({ status: "published", status_note: "Marked as posted by a person; not linked to statistics." });
    expect(posted.json.data.targets[0]).toMatchObject({ status: "published", external_id: null });

    // "It is not there — post it again" needs the explicit confirm.
    const d = await unknown();
    const noConfirm = await call(admin, "POST", `/posts/${d.id}/targets/${d.tid}/resolve`, { outcome: "not_posted" });
    expect(noConfirm.status).toBe(400);
    const [untouched] = await db.select().from(socialPostTarget).where(eq(socialPostTarget.id, d.tid));
    expect(untouched!.status).toBe("unknown");
    const again = await call(admin, "POST", `/posts/${d.id}/targets/${d.tid}/resolve`, { outcome: "not_posted", confirm: true });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.data.status).toBe("publishing");
    expect(again.json.data.targets[0]).toMatchObject({ status: "pending", attempts: 0 });
    const [resolveRow] = await audits("social.post_resolve", d.id);
    expect(resolveRow!.actorUserId).toBe(adminId);
    expect(resolveRow!.afterJson).toMatchObject({ target_id: d.tid, outcome: "not_posted" });

    expect(publishCalls()).toHaveLength(0);
  });

  it("edit published facebook text calls POST /{post-id} and audits before/after", async () => {
    const p = await published(admin, 9001);
    const tid = p.targets[0].id;
    const res = await call(admin, "PATCH", `/posts/${p.id}/targets/${tid}/published`, { message: "  New text for Facebook " });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.data.targets[0]).toMatchObject({ status: "published", caption_override: "New text for Facebook" });

    const edits = calls.filter((c) => c.method === "POST");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({ method: "POST", path: `/${PAGE_ID}_9001`, body: { message: "New text for Facebook" }, auth: `Bearer ${PAGE_TOKEN}` });

    const rows = await audits("social.published_edit", p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(adminId);
    expect(rows[0]!.beforeJson).toEqual({ target_id: tid, text: "Suite test 1" });
    expect(rows[0]!.afterJson).toMatchObject({ target_id: tid, text: "New text for Facebook", result: "saved" });
    // The approved fingerprint follows the text a person just sent.
    const [row] = await db.select().from(socialPost).where(eq(socialPost.id, p.id));
    expect(row!.approvedHash).toBe(res.json.data.content_hash);

    // Facebook refuses: a 502 with plain words and Meta's code, nothing changed here, and the attempt is audited.
    refuse = { method: "POST", pathEnds: `/${PAGE_ID}_9001`, code: 100, message: "(#100) Invalid parameter" };
    const refused = await call(admin, "PATCH", `/posts/${p.id}/targets/${tid}/published`, { message: "Another try" });
    expect(refused.status).toBe(502);
    expect(refused.json.error.message).toBe("Facebook refused this: (#100) Invalid parameter");
    expect(refused.json.error.details).toMatchObject({ reason: "meta_refused", meta_code: "100" });
    const [target] = await db.select().from(socialPostTarget).where(eq(socialPostTarget.id, tid));
    expect(target!.captionOverride).toBe("New text for Facebook");
    expect((await audits("social.published_edit", p.id)).map((r) => (r.afterJson as Obj).result).sort()).toEqual(["refused", "saved"]);

    // Instagram captions cannot be changed, and a post that is not out has nothing to change.
    const both = await published(admin, 9002, { kind: "photo", caption: "A picture", media: [picture(KEY_A, adminId)], targets: [{ account_id: fb }, { account_id: ig }] });
    const igTarget = both.targets.find((t: { network: string }) => t.network === "instagram");
    const before = calls.length;
    const onIg = await call(admin, "PATCH", `/posts/${both.id}/targets/${igTarget.id}/published`, { message: "x" });
    expect(onIg.status).toBe(409);
    expect(onIg.json.error.message).toBe("Instagram does not let apps change a caption. Take the post down and post it again.");
    const pending = await approvedNow(admin);
    expect((await call(admin, "PATCH", `/posts/${pending.id}/targets/${pending.targets[0].id}/published`, { message: "x" })).status).toBe(409);
    expect((await call(admin, "PATCH", `/posts/${p.id}/targets/${tid}/published`, { message: "" })).status).toBe(400);
    expect(calls.length).toBe(before);
  });

  it("take down marks removed; a Meta permission refusal returns 409 with the manual wording", async () => {
    // Facebook lets us: the target is marked removed.
    const p = await published(admin, 9101);
    const tid = p.targets[0].id;
    const res = await call(admin, "DELETE", `/posts/${p.id}/targets/${tid}/published`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.data.targets[0]).toMatchObject({ status: "removed" });
    expect(res.json.data.targets[0].removed_at).not.toBeNull();
    expect(res.json.data.targets[0].removed_by.id).toBe(adminId);
    // Rule 15: the post is kept for the record.
    expect(res.json.data.status).toBe("published");
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ path: `/${PAGE_ID}_9101`, auth: `Bearer ${PAGE_TOKEN}` });
    const rows = await audits("social.published_delete", p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.afterJson).toMatchObject({ target_id: tid, network: "facebook", status: "removed", manual: false });
    // Already removed: nothing more to take down.
    expect((await call(admin, "DELETE", `/posts/${p.id}/targets/${tid}/published`)).status).toBe(409);

    // Facebook does not let us: the manual wording, and nothing is marked.
    const q = await published(admin, 9102);
    const qt = q.targets[0].id;
    refuse = { method: "DELETE", pathEnds: `/${PAGE_ID}_9102`, code: 200, message: "(#200) Permissions error" };
    const refused = await call(admin, "DELETE", `/posts/${q.id}/targets/${qt}/published`);
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toBe(
      "Facebook did not let the suite take this down. Delete it on the Page itself, then press 'I removed it myself'.",
    );
    const [still] = await db.select().from(socialPostTarget).where(eq(socialPostTarget.id, qt));
    expect(still!.status).toBe("published");

    // "I removed it myself": marked removed with no call to Meta.
    const before = calls.length;
    const manual = await call(admin, "DELETE", `/posts/${q.id}/targets/${qt}/published`, { manual: true });
    expect(manual.status, JSON.stringify(manual.json)).toBe(200);
    expect(manual.json.data.targets[0].status).toBe("removed");
    expect(calls.length).toBe(before);
    expect((await audits("social.published_delete", q.id))[0]!.afterJson).toMatchObject({ manual: true });

    // Instagram refuses for lack of permission (code 10): its own wording.
    const both = await published(admin, 9103, { kind: "photo", caption: "A picture", media: [picture(KEY_B, adminId)], targets: [{ account_id: fb }, { account_id: ig }] });
    const igTarget = both.targets.find((t: { network: string }) => t.network === "instagram");
    refuse = { method: "DELETE", pathEnds: "/17900000000009103", code: 10, message: "(#10) Application does not have permission for this action" };
    const igRefused = await call(admin, "DELETE", `/posts/${both.id}/targets/${igTarget.id}/published`);
    expect(igRefused.status).toBe(409);
    expect(igRefused.json.error.message).toBe(
      "Instagram did not let the suite take this down. Delete it in the Instagram app, then press 'I removed it myself'.",
    );
    // The Facebook half is untouched, and the post is still out.
    const after = (await call(admin, "GET", `/posts/${both.id}`)).json.data;
    expect(after.status).toBe("published");
    expect(after.targets.map((t: { status: string }) => t.status)).toEqual(["published", "published"]);
  });

  it('responses and audit rows never contain the string "itest-token"', async () => {
    // Make sure both Page-token paths ran in this test too.
    await call(admin, "GET", "/accounts");
    const p = await published(admin, 9201);
    await call(admin, "PATCH", `/posts/${p.id}/targets/${p.targets[0].id}/published`, { message: "Token check" });
    await call(admin, "GET", "/posts?status=all&limit=100");

    expect(bodies.length).toBeGreaterThan(20);
    for (const b of bodies) expect(b).not.toContain("itest-token");
    const auditRows = await db.select().from(auditLog).where(like(auditLog.action, "social.%"));
    expect(auditRows.length).toBeGreaterThan(5);
    expect(JSON.stringify(auditRows)).not.toContain("itest-token");
    expect(JSON.stringify(await db.select().from(outboxEvent))).not.toContain("itest-token");
    expect(JSON.stringify(await db.select().from(socialPost))).not.toContain("itest-token");
    expect(JSON.stringify(await db.select().from(socialPostTarget))).not.toContain("itest-token");
  });
});

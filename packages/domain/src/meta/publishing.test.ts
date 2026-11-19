import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SocialPostMedia } from "@ms/db";
import {
  IG_QUOTA_TEXT,
  POST_CHANGED_NOTE,
  advanceTargetIn,
  classifyPublishError,
  fbPublishVideo,
  postFingerprint,
  postStatusFromTargets,
  reconcileTargetIn,
  type LoadedTarget,
  type PublishStore,
  type SocialPostRow,
  type SocialTargetRow,
} from "./publishing.js";
import { clearPageTokenCache, type ChannelAccount } from "./accounts.js";
import { MetaApiError } from "../inbox/meta.js";

// Never the real Graph API: every test stubs fetch. Tokens here are obviously fake.
const cfg = { token: "SYSTEM-USER-TEST", graphVersion: "v23.0" };
const PAGE_ID = "100200300";
const IG_ID = "17841400000000001";
const FB_ACCOUNT = "11111111-1111-4111-8111-111111111111";
const IG_ACCOUNT = "22222222-2222-4222-8222-222222222222";
const POST_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-20T09:00:00.000Z");
const key = (n: number, ext = "jpg") => `social/posts/2026/11/0b0e5f1c-1a2b-4c3d-8e9f-00112233445${n}.${ext}`;
const jpeg = (n: number, alt: string | null = null): SocialPostMedia => ({
  key: key(n),
  mime: "image/jpeg",
  bytes: 400_000,
  width: 1080,
  height: 1080,
  duration_s: null,
  alt_text: alt,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function metaError(code: number, subcode?: number, message = "Meta says no", status = 400): Response {
  return json({ error: { message, code, ...(subcode ? { error_subcode: subcode } : {}) } }, status);
}

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  auth: string;
  host: string;
}
let calls: Call[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

/** Answer the Page-token look-up, record everything else and hand it to `rest`. */
function route(rest: (c: Call) => Response | Promise<Response>) {
  fetchMock.mockImplementation(async (href: string, init: RequestInit) => {
    const url = new URL(href);
    if (url.searchParams.get("fields") === "access_token") return json({ access_token: "PAGE-TOKEN-TEST" });
    const c: Call = {
      method: init.method ?? "GET",
      path: url.pathname.replace(/^\/v[\d.]+\//, ""),
      query: url.searchParams,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      auth: (init.headers as Record<string, string>).authorization ?? "",
      host: url.host,
    };
    calls.push(c);
    return rest(c);
  });
}
const posts = () => calls.filter((c) => c.method === "POST");

beforeEach(() => {
  clearPageTokenCache();
  calls = [];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── An in-memory store with the same rules as dbPublishStore ─────────────────

interface World {
  post: SocialPostRow;
  targets: SocialTargetRow[];
  accounts: ChannelAccount[];
  alerts: Record<string, unknown>[];
}

function makePost(over: Partial<SocialPostRow> = {}): SocialPostRow {
  return {
    id: POST_ID,
    kind: "photo",
    caption: "Fresh juice today",
    linkUrl: null,
    media: [jpeg(1)],
    status: "publishing",
    scheduledAt: null,
    statusNote: null,
    approvedBy: null,
    approvedAt: NOW,
    approvedHash: null,
    captionSource: "person",
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

let targetNo = 0;
function makeTarget(network: "facebook" | "instagram", over: Partial<SocialTargetRow> = {}): SocialTargetRow {
  targetNo += 1;
  return {
    id: `44444444-4444-4444-8444-44444444444${targetNo}`,
    postId: POST_ID,
    accountId: network === "facebook" ? FB_ACCOUNT : IG_ACCOUNT,
    network,
    captionOverride: null,
    status: "pending",
    step: "start",
    containerId: null,
    childIds: [],
    externalId: null,
    externalKind: null,
    permalink: null,
    attempts: 0,
    reconcileChecks: 0,
    nextAttemptAt: NOW,
    waitStartedAt: null,
    lockedAt: null,
    errorCode: null,
    errorSubcode: null,
    errorMessage: null,
    publishedAt: null,
    removedAt: null,
    removedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** A world whose post carries the right approved fingerprint for its targets. */
function world(post: SocialPostRow, targets: SocialTargetRow[]): World {
  const w: World = {
    post,
    targets,
    accounts: [
      { id: FB_ACCOUNT, kind: "messenger", label: "Facebook Page", externalId: PAGE_ID, pageId: PAGE_ID, isActive: true },
      { id: IG_ACCOUNT, kind: "instagram", label: "Instagram", externalId: IG_ID, pageId: PAGE_ID, isActive: true },
    ],
    alerts: [],
  };
  w.post.approvedHash = postFingerprint(post, targets);
  return w;
}

function memoryStore(w: World): PublishStore {
  const find = (id: string) => w.targets.find((t) => t.id === id);
  const recompute = () => {
    const next = postStatusFromTargets(w.targets.map((t) => t.status));
    if (next && ["publishing", "published", "partly_published", "failed", "needs_check"].includes(w.post.status)) w.post.status = next;
  };
  return {
    async load(id): Promise<LoadedTarget | null> {
      const t = find(id);
      if (!t) return null;
      // Copies, as a database read would give.
      return {
        target: { ...t, childIds: [...t.childIds] },
        post: { ...w.post },
        account: w.accounts.find((a) => a.id === t.accountId) ?? null,
        siblings: w.targets.map((s) => ({ accountId: s.accountId, network: s.network, captionOverride: s.captionOverride })),
      };
    },
    async patchTarget(id, patch, now, whenStatus) {
      const t = find(id);
      if (!t || (whenStatus && t.status !== whenStatus)) return false;
      Object.assign(t, patch, { updatedAt: now });
      return true;
    },
    async claim(id, now) {
      const t = find(id);
      if (!t || t.status !== "pending" || w.post.status !== "publishing") return false;
      Object.assign(t, { status: "publishing", step: "publish", lockedAt: now, attempts: t.attempts + 1, updatedAt: now });
      return true;
    },
    async publishResult(id, r, now, whenStatus) {
      const t = find(id);
      if (!t || t.status !== whenStatus) return false;
      Object.assign(t, {
        status: "published",
        step: "done",
        externalId: r.externalId,
        externalKind: r.externalKind,
        ...(r.permalink !== undefined ? { permalink: r.permalink } : {}),
        publishedAt: now,
        errorCode: null,
        errorSubcode: null,
        errorMessage: null,
      });
      recompute();
      return true;
    },
    async recompute() {
      recompute();
    },
    async failPost(_id, note) {
      if (w.post.status === "publishing") Object.assign(w.post, { status: "failed", statusNote: note });
    },
    async notePost(_id, note) {
      w.post.statusNote = note;
    },
    async externalIdTaken(network, externalId) {
      return w.targets.some((t) => t.network === network && t.externalId === externalId);
    },
    async alertConfig(payload) {
      w.alerts.push(payload);
    },
  };
}

const sign = async (k: string) => `https://files.example.test/${k}?sig=TEST`;

describe("postFingerprint", () => {
  it("postFingerprint: same input gives same hash; changing caption, media order, a target, or the time changes it", () => {
    const post = { kind: "album", caption: "Hello", linkUrl: null, media: [jpeg(1), jpeg(2)], scheduledAt: new Date("2026-11-24T08:00:00.000Z") };
    const targets = [
      { accountId: IG_ACCOUNT, network: "instagram", captionOverride: null },
      { accountId: FB_ACCOUNT, network: "facebook", captionOverride: "For Facebook" },
    ];
    const base = postFingerprint(post, targets);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(postFingerprint({ ...post, media: [jpeg(1), jpeg(2)] }, [...targets])).toBe(base);
    // The order targets are given in does not matter; they are sorted by account.
    expect(postFingerprint(post, [targets[1]!, targets[0]!])).toBe(base);

    expect(postFingerprint({ ...post, caption: "Hello!" }, targets)).not.toBe(base);
    expect(postFingerprint({ ...post, media: [jpeg(2), jpeg(1)] }, targets)).not.toBe(base);
    expect(postFingerprint({ ...post, media: [jpeg(1, "A glass of juice"), jpeg(2)] }, targets)).not.toBe(base);
    expect(postFingerprint(post, [targets[0]!])).not.toBe(base);
    expect(postFingerprint(post, [targets[0]!, { ...targets[1]!, captionOverride: "Other" }])).not.toBe(base);
    expect(postFingerprint({ ...post, scheduledAt: new Date("2026-11-24T09:00:00.000Z") }, targets)).not.toBe(base);
    expect(postFingerprint({ ...post, scheduledAt: null }, targets)).not.toBe(base);
    expect(postFingerprint({ ...post, linkUrl: "https://www.mrssamuel.com" }, targets)).not.toBe(base);
  });
});

describe("classifyPublishError", () => {
  const err = (code: string | null, subcode: string | null = null, status = 400, message = "Meta says no") =>
    new MetaApiError(message, status, code, false, "not_sent", subcode);

  it("classifyPublishError: 2207042 is temporary with a one-hour wait", () => {
    expect(classifyPublishError(err("9", "2207042"), "2207042")).toEqual({ kind: "temporary", staffMessage: IG_QUOTA_TEXT, retryAfterMs: 3_600_000 });
  });

  it("classifyPublishError: 190 is configuration; 36003 is a refusal with the crop wording", () => {
    for (const code of ["190", "10", "200", "299", "283"]) expect(classifyPublishError(err(code), null).kind, code).toBe("configuration");
    const crop = "Instagram refused this: the picture is too tall or too wide. Crop it to between 4:5 and 1.91:1.";
    expect(classifyPublishError(err("36003", "2207009"), "2207009")).toEqual({ kind: "refusal", staffMessage: crop, retryAfterMs: null });
    expect(classifyPublishError(err("36003"), null).staffMessage).toBe(crop);
  });

  it("classifyPublishError: rate limits and server trouble are temporary; the rest is a refusal with Meta's words", () => {
    for (const code of ["4", "17", "32", "613", "80001", "80007", "80014"]) expect(classifyPublishError(err(code), null).kind, code).toBe("temporary");
    expect(classifyPublishError(err(null, null, 429), null).kind).toBe("temporary");
    expect(classifyPublishError(err(null, null, 503), null).kind).toBe("temporary");
    expect(classifyPublishError(new MetaApiError("Could not reach Facebook", 0, "ECONNREFUSED", true), null, "facebook").kind).toBe("temporary");
    // Code 4 with the spam subcode is a refusal, and the restricted account is a configuration problem.
    expect(classifyPublishError(err("4", "2207051"), "2207051").kind).toBe("refusal");
    expect(classifyPublishError(err("25", "2207050"), "2207050").kind).toBe("configuration");
    expect(classifyPublishError(err("100", null, 400, "Invalid parameter"), null, "facebook")).toEqual({
      kind: "refusal",
      staffMessage: "Facebook refused this: Invalid parameter",
      retryAfterMs: null,
    });
  });
});

describe("postStatusFromTargets", () => {
  it("follows rule 9", () => {
    expect(postStatusFromTargets([])).toBeNull();
    expect(postStatusFromTargets(["pending", "published"])).toBe("publishing");
    expect(postStatusFromTargets(["publishing", "unknown"])).toBe("publishing");
    expect(postStatusFromTargets(["unknown", "published"])).toBe("needs_check");
    expect(postStatusFromTargets(["published", "published"])).toBe("published");
    expect(postStatusFromTargets(["published", "removed"])).toBe("published");
    expect(postStatusFromTargets(["removed", "removed"])).toBe("published");
    expect(postStatusFromTargets(["failed", "failed"])).toBe("failed");
    expect(postStatusFromTargets(["failed", "removed"])).toBe("failed");
    expect(postStatusFromTargets(["failed", "published"])).toBe("partly_published");
  });
});

describe("advanceTarget", () => {
  it("advanceTarget: instagram photo creates container, waits, publishes, stores media id", async () => {
    const t = makeTarget("instagram");
    const w = world(makePost({ media: [jpeg(1, "A glass of orange juice")] }), [t]);
    const store = memoryStore(w);
    route((c) => {
      if (c.path === `${IG_ID}/content_publishing_limit`) return json({ data: [{ quota_usage: 2, config: { quota_total: 50, quota_duration: 86400 } }] });
      if (c.path === `${IG_ID}/media` && c.method === "POST") return json({ id: "CONTAINER1" });
      if (c.path === "CONTAINER1") return json({ status_code: "FINISHED" });
      if (c.path === `${IG_ID}/media_publish`) return json({ id: "17900000000000001" });
      if (c.path === "17900000000000001") return json({ permalink: "https://www.instagram.com/p/TEST1/" });
      return metaError(100);
    });

    expect(await advanceTargetIn(store, cfg, t.id, sign, NOW)).toBe("published");

    const [container, publish] = posts();
    expect(container!.path).toBe(`${IG_ID}/media`);
    expect(container!.body).toEqual({
      image_url: `https://files.example.test/${key(1)}?sig=TEST`,
      caption: "Fresh juice today",
      alt_text: "A glass of orange juice",
    });
    expect(publish!.body).toEqual({ creation_id: "CONTAINER1" });
    expect(posts()).toHaveLength(2);
    // Every call carried the Page token, never the system-user token.
    expect(calls.every((c) => c.auth === "Bearer PAGE-TOKEN-TEST")).toBe(true);

    expect(w.targets[0]).toMatchObject({
      status: "published",
      step: "done",
      containerId: "CONTAINER1",
      externalId: "17900000000000001",
      externalKind: "media",
      permalink: "https://www.instagram.com/p/TEST1/",
      attempts: 1,
      errorMessage: null,
    });
    expect(w.targets[0]!.publishedAt).toEqual(NOW);
    expect(w.post.status).toBe("published");
  });

  it("advanceTarget: instagram IN_PROGRESS returns waiting and schedules 30 s later", async () => {
    const t = makeTarget("instagram");
    const w = world(makePost(), [t]);
    route((c) => {
      if (c.path === `${IG_ID}/content_publishing_limit`) return json({ data: [{ quota_usage: 0, config: { quota_total: 50 } }] });
      if (c.path === `${IG_ID}/media`) return json({ id: "CONTAINER2" });
      if (c.path === "CONTAINER2") return json({ status_code: "IN_PROGRESS" });
      return metaError(100);
    });

    expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, NOW)).toBe("waiting");
    expect(w.targets[0]).toMatchObject({ status: "pending", step: "wait", containerId: "CONTAINER2", attempts: 0 });
    expect(w.targets[0]!.nextAttemptAt).toEqual(new Date(NOW.getTime() + 30_000));
    expect(w.targets[0]!.waitStartedAt).toEqual(NOW);
    expect(calls.some((c) => c.path === `${IG_ID}/media_publish`)).toBe(false);
    expect(w.post.status).toBe("publishing");

    // Called before its time, it does nothing at all.
    calls = [];
    expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, new Date(NOW.getTime() + 10_000))).toBe("waiting");
    expect(calls).toHaveLength(0);

    // Still not ready after 10 minutes: a picture is given up on, in plain words.
    const later = new Date(NOW.getTime() + 11 * 60_000);
    expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, later)).toBe("failed");
    expect(w.targets[0]).toMatchObject({ status: "failed", errorMessage: "Instagram took too long to get this ready. Try again." });
    expect(w.post.status).toBe("failed");
  });

  it("advanceTarget: a full instagram quota waits an hour without counting an attempt, and fails after a day", async () => {
    const t = makeTarget("instagram");
    const w = world(makePost(), [t]);
    route((c) => (c.path === `${IG_ID}/content_publishing_limit` ? json({ data: [{ quota_usage: 50, config: { quota_total: 50 } }] }) : metaError(100)));

    expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, NOW)).toBe("waiting");
    expect(w.targets[0]).toMatchObject({ status: "pending", attempts: 0, errorMessage: IG_QUOTA_TEXT });
    expect(w.targets[0]!.nextAttemptAt).toEqual(new Date(NOW.getTime() + 3_600_000));
    expect(posts()).toHaveLength(0);

    const nextDay = new Date(NOW.getTime() + 25 * 3_600_000);
    expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, nextDay)).toBe("failed");
    expect(w.targets[0]!.errorMessage).toBe("Instagram's daily posting limit stayed full for a day.");
  });

  it("advanceTarget: facebook album uploads each photo unpublished then posts once with attached_media", async () => {
    const t = makeTarget("facebook");
    const w = world(makePost({ kind: "album", media: [jpeg(1), jpeg(2), jpeg(3)] }), [t]);
    let photoNo = 0;
    route((c) => {
      if (c.path === `${PAGE_ID}/photos`) return json({ id: `PHOTO${++photoNo}` });
      if (c.path === `${PAGE_ID}/feed` && c.method === "POST") return json({ id: `${PAGE_ID}_9001` });
      if (c.path === `${PAGE_ID}_9001`) return json({ permalink_url: "https://www.facebook.com/100200300/posts/9001" });
      return metaError(100);
    });

    expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, NOW)).toBe("published");

    const photos = posts().filter((c) => c.path === `${PAGE_ID}/photos`);
    expect(photos.map((c) => c.body)).toEqual([1, 2, 3].map((n) => ({ url: `https://files.example.test/${key(n)}?sig=TEST`, published: false })));
    const feeds = posts().filter((c) => c.path === `${PAGE_ID}/feed`);
    expect(feeds).toHaveLength(1);
    expect(feeds[0]!.body).toEqual({
      message: "Fresh juice today",
      attached_media: [{ media_fbid: "PHOTO1" }, { media_fbid: "PHOTO2" }, { media_fbid: "PHOTO3" }],
    });
    expect(w.targets[0]).toMatchObject({
      status: "published",
      childIds: ["PHOTO1", "PHOTO2", "PHOTO3"],
      externalId: `${PAGE_ID}_9001`,
      externalKind: "post",
      permalink: "https://www.facebook.com/100200300/posts/9001",
    });
  });

  it("advanceTarget: album resumes after a crash without re-uploading photos already in child_ids", async () => {
    const t = makeTarget("facebook", { step: "media", childIds: ["PHOTO1", "PHOTO2"] });
    const w = world(makePost({ kind: "album", media: [jpeg(1), jpeg(2), jpeg(3)] }), [t]);
    route((c) => {
      if (c.path === `${PAGE_ID}/photos`) return json({ id: "PHOTO3" });
      if (c.path === `${PAGE_ID}/feed` && c.method === "POST") return json({ id: `${PAGE_ID}_9002` });
      return json({});
    });

    expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, NOW)).toBe("published");
    const photos = posts().filter((c) => c.path === `${PAGE_ID}/photos`);
    expect(photos).toHaveLength(1);
    expect(photos[0]!.body).toEqual({ url: `https://files.example.test/${key(3)}?sig=TEST`, published: false });
    expect(posts().filter((c) => c.path === `${PAGE_ID}/feed`)[0]!.body!.attached_media).toEqual([
      { media_fbid: "PHOTO1" },
      { media_fbid: "PHOTO2" },
      { media_fbid: "PHOTO3" },
    ]);
  });

  it("advanceTarget: timeout on the risky call leaves status unknown and makes no second call", async () => {
    const t = makeTarget("facebook");
    const w = world(makePost({ kind: "text", media: [] }), [t]);
    route((c) => {
      if (c.path === `${PAGE_ID}/feed` && c.method === "POST") throw new TypeError("fetch failed");
      return json({});
    });

    expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, NOW)).toBe("unknown");
    expect(w.targets[0]).toMatchObject({ status: "unknown", step: "publish", attempts: 1, externalId: null });
    expect(w.targets[0]!.errorMessage).toContain("We could not tell whether this posted.");
    expect(w.targets[0]!.lockedAt).toEqual(NOW);
    expect(w.post.status).toBe("needs_check");
    expect(posts()).toHaveLength(1);

    // The worker comes round again, many times: an unknown target is never sent again (rules 4 and 5).
    for (let i = 1; i <= 5; i++) {
      expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, new Date(NOW.getTime() + i * 3_600_000))).toBe("waiting");
    }
    expect(posts()).toHaveLength(1);
    expect(w.targets[0]!.status).toBe("unknown");
  });

  it("advanceTarget: a bare 5xx on the risky call is unknown too, never failed or retried", async () => {
    const t = makeTarget("instagram", { step: "wait", containerId: "CONTAINER5", waitStartedAt: NOW });
    const w = world(makePost(), [t]);
    route((c) => {
      if (c.path === "CONTAINER5") return json({ status_code: "FINISHED" });
      if (c.path === `${IG_ID}/media_publish`) return new Response("Bad Gateway", { status: 502 });
      return json({});
    });
    expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, NOW)).toBe("unknown");
    expect(w.targets[0]!.status).toBe("unknown");
    expect(posts().filter((c) => c.path === `${IG_ID}/media_publish`)).toHaveLength(1);
  });

  it("advanceTarget: second caller finds the target claimed and makes no Graph call", async () => {
    const t = makeTarget("facebook");
    const w = world(makePost({ kind: "text", media: [] }), [t]);
    const store = memoryStore(w);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    route(async (c) => {
      if (c.path === `${PAGE_ID}/feed` && c.method === "POST") {
        await held;
        return json({ id: `${PAGE_ID}_9003` });
      }
      return json({});
    });

    // The first worker has claimed the target and is waiting for Facebook's answer…
    const first = advanceTargetIn(store, cfg, t.id, sign, NOW);
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(w.targets[0]!.status).toBe("publishing");
    // …when a second one arrives.
    expect(await advanceTargetIn(store, cfg, t.id, sign, NOW)).toBe("waiting");
    expect(posts()).toHaveLength(1);

    release();
    expect(await first).toBe("published");
    expect(posts().filter((c) => c.path === `${PAGE_ID}/feed`)).toHaveLength(1);

    // And a caller that loses the race at the claim itself (it read "pending", then the claim says no) calls nothing.
    const t2 = makeTarget("facebook");
    const w2 = world(makePost({ kind: "text", media: [] }), [t2]);
    const losing = { ...memoryStore(w2), claim: async () => false };
    calls = [];
    expect(await advanceTargetIn(losing, cfg, t2.id, sign, NOW)).toBe("waiting");
    expect(posts()).toHaveLength(0);
  });

  it("advanceTarget: temporary error four times ends failed", async () => {
    const t = makeTarget("facebook");
    const w = world(makePost({ kind: "text", media: [] }), [t]);
    route((c) => (c.path === `${PAGE_ID}/feed` ? metaError(4, undefined, "Application request limit reached") : json({})));

    let at = NOW;
    const waits: number[] = [];
    for (let i = 1; i <= 3; i++) {
      expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, at)).toBe("retry");
      expect(w.targets[0]).toMatchObject({ status: "pending", attempts: i, errorCode: "4" });
      waits.push(w.targets[0]!.nextAttemptAt.getTime() - at.getTime());
      at = w.targets[0]!.nextAttemptAt;
      expect(w.post.status).toBe("publishing");
    }
    expect(waits).toEqual([60_000, 5 * 60_000, 15 * 60_000]);

    expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, at)).toBe("failed");
    expect(w.targets[0]).toMatchObject({ status: "failed", attempts: 4 });
    expect(w.targets[0]!.errorMessage).toBe(
      "Facebook is busy. We are trying again. (tried 4 times) — Meta said: Application request limit reached",
    );
    expect(w.post.status).toBe("failed");
    expect(posts()).toHaveLength(4);
  });

  it("advanceTarget: a refusal fails with plain words and keeps Meta's code; a token problem alerts the owner once", async () => {
    const t = makeTarget("instagram", { step: "wait", containerId: "CONTAINER6", waitStartedAt: NOW });
    const w = world(makePost(), [t]);
    route((c) => {
      if (c.path === "CONTAINER6") return json({ status_code: "FINISHED" });
      if (c.path === `${IG_ID}/media_publish`) return metaError(36003, 2207009, "The aspect ratio is not supported");
      return json({});
    });
    expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, NOW)).toBe("failed");
    expect(w.targets[0]).toMatchObject({
      status: "failed",
      errorCode: "36003",
      errorSubcode: "2207009",
      errorMessage:
        "Instagram refused this: the picture is too tall or too wide. Crop it to between 4:5 and 1.91:1. — Meta said: The aspect ratio is not supported",
    });
    expect(w.alerts).toHaveLength(0);

    const t2 = makeTarget("facebook");
    const w2 = world(makePost({ kind: "text", media: [] }), [t2]);
    route((c) => (c.path === `${PAGE_ID}/feed` ? metaError(200, undefined, "Permissions error") : json({})));
    expect(await advanceTargetIn(memoryStore(w2), cfg, t2.id, sign, NOW)).toBe("failed");
    expect(w2.targets[0]!.status).toBe("failed");
    expect(w2.alerts).toEqual([{ network: "facebook", account_id: FB_ACCOUNT, label: "Facebook Page", code: "200", message: "Permissions error" }]);
  });

  it("advanceTarget: one network failing never blocks the other (rule 8)", async () => {
    const fb = makeTarget("facebook");
    const ig = makeTarget("instagram");
    const w = world(makePost(), [fb, ig]);
    route((c) => {
      if (c.path === `${PAGE_ID}/photos`) return metaError(100, undefined, "Invalid image");
      if (c.path === `${IG_ID}/content_publishing_limit`) return json({ data: [{ quota_usage: 0, config: { quota_total: 50 } }] });
      if (c.path === `${IG_ID}/media`) return json({ id: "CONTAINER7" });
      if (c.path === "CONTAINER7") return json({ status_code: "FINISHED" });
      if (c.path === `${IG_ID}/media_publish`) return json({ id: "17900000000000007" });
      return json({});
    });
    expect(await advanceTargetIn(memoryStore(w), cfg, fb.id, sign, NOW)).toBe("failed");
    expect(w.post.status).toBe("publishing");
    expect(await advanceTargetIn(memoryStore(w), cfg, ig.id, sign, NOW)).toBe("published");
    expect(w.post.status).toBe("partly_published");
    // The single photo post to Facebook was the risky call itself: one attempt, with the caption.
    expect(posts().find((c) => c.path === `${PAGE_ID}/photos`)!.body).toEqual({
      url: `https://files.example.test/${key(1)}?sig=TEST`,
      caption: "Fresh juice today",
      published: true,
    });
  });

  it("advanceTarget: a post that changed after approval, a draft, a switched-off account and missing storage send nothing", async () => {
    // Changed after approval: the fingerprint no longer matches.
    const t = makeTarget("facebook");
    const w = world(makePost({ kind: "text", media: [] }), [t]);
    w.post.caption = "Something nobody approved";
    route(() => json({ id: "SHOULD-NOT-HAPPEN" }));
    expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, NOW)).toBe("failed");
    expect(w.post).toMatchObject({ status: "failed", statusNote: POST_CHANGED_NOTE });

    // Not approved for sending: a draft or scheduled post's targets are "pending" by default and must never move.
    for (const status of ["draft", "scheduled", "missed", "failed"]) {
      const t2 = makeTarget("facebook");
      const w2 = world(makePost({ kind: "text", media: [], status }), [t2]);
      expect(await advanceTargetIn(memoryStore(w2), cfg, t2.id, sign, NOW), status).toBe("waiting");
    }

    // Rule 16.
    const t3 = makeTarget("facebook");
    const w3 = world(makePost({ kind: "text", media: [] }), [t3]);
    w3.accounts[0]!.isActive = false;
    expect(await advanceTargetIn(memoryStore(w3), cfg, t3.id, sign, NOW)).toBe("failed");
    expect(w3.targets[0]!.errorMessage).toBe("This account is switched off in Channels.");

    // No file storage: media posts fail, text posts still go.
    const t4 = makeTarget("facebook");
    const w4 = world(makePost(), [t4]);
    expect(await advanceTargetIn(memoryStore(w4), cfg, t4.id, null, NOW)).toBe("failed");
    expect(w4.targets[0]!.errorMessage).toBe("File storage is not set up on the server.");

    // A kind the network cannot take is stopped by the same rules the composer uses.
    const t5 = makeTarget("instagram");
    const w5 = world(makePost({ kind: "text", media: [] }), [t5]);
    expect(await advanceTargetIn(memoryStore(w5), cfg, t5.id, sign, NOW)).toBe("failed");
    expect(w5.targets[0]!.errorMessage).toBe("Instagram posts need a picture or a video.");

    expect(calls).toHaveLength(0);
  });

  it("advanceTarget: instagram album, reel and story send the right containers", async () => {
    const run = async (post: SocialPostRow) => {
      const t = makeTarget("instagram");
      const w = world(post, [t]);
      let n = 0;
      calls = [];
      route((c) => {
        if (c.path === `${IG_ID}/content_publishing_limit`) return json({ data: [{ quota_usage: 0, config: { quota_total: 50 } }] });
        if (c.path === `${IG_ID}/media`) return json({ id: `C${++n}` });
        if (c.path === `${IG_ID}/media_publish`) return json({ id: "17900000000000009" });
        if (/^C\d+$/.test(c.path)) return json({ status_code: "FINISHED" });
        return json({});
      });
      expect(await advanceTargetIn(memoryStore(w), cfg, t.id, sign, NOW)).toBe("published");
      return { bodies: posts().filter((c) => c.path === `${IG_ID}/media`).map((c) => c.body), w };
    };
    const u = (n: number, ext = "jpg") => `https://files.example.test/${key(n, ext)}?sig=TEST`;

    const album = await run(makePost({ kind: "album", media: [jpeg(1), jpeg(2, "Second")] }));
    expect(album.bodies).toEqual([
      { image_url: u(1), is_carousel_item: true },
      { image_url: u(2), is_carousel_item: true, alt_text: "Second" },
      { media_type: "CAROUSEL", children: "C1,C2", caption: "Fresh juice today" },
    ]);
    expect(album.w.targets[0]).toMatchObject({ childIds: ["C1", "C2"], containerId: "C3" });

    const video: SocialPostMedia = { key: key(4, "mp4"), mime: "video/mp4", bytes: 9_000_000, width: 1080, height: 1920, duration_s: 12, alt_text: null };
    const reel = await run(makePost({ kind: "video", media: [video] }));
    expect(reel.bodies).toEqual([{ media_type: "REELS", video_url: u(4, "mp4"), caption: "Fresh juice today", share_to_feed: true }]);

    const story = await run(makePost({ kind: "story", media: [jpeg(5)] }));
    expect(story.bodies).toEqual([{ media_type: "STORIES", image_url: u(5) }]);
  });

  it("fbPublishVideo posts to graph-video with the file link", async () => {
    route((c) => (c.path === `${PAGE_ID}/videos` ? json({ id: "777000111" }) : json({})));
    expect(await fbPublishVideo(cfg, "PAGE-TOKEN-TEST", PAGE_ID, { file_url: "https://files.example.test/v.mp4", description: "Hi" })).toEqual({
      id: "777000111",
    });
    expect(calls[0]).toMatchObject({ host: "graph-video.facebook.com", method: "POST", auth: "Bearer PAGE-TOKEN-TEST" });
    expect(calls[0]!.body).toEqual({ file_url: "https://files.example.test/v.mp4", description: "Hi" });
  });
});

describe("reconcileTarget", () => {
  const LOCKED = new Date("2026-11-20T08:59:00.000Z");

  it("reconcileTarget: instagram PUBLISHED container marks published; FINISHED re-arms the publish step", async () => {
    const t = makeTarget("instagram", { status: "unknown", step: "publish", containerId: "CONTAINER8", lockedAt: LOCKED, attempts: 1 });
    const w = world(makePost({ status: "needs_check" }), [t]);
    route((c) => {
      if (c.path === "CONTAINER8") return json({ status_code: "PUBLISHED" });
      if (c.path === `${IG_ID}/media`)
        return json({
          data: [
            { id: "17900000000000010", caption: "Fresh juice today", timestamp: "2026-11-20T08:59:05+0000", permalink: "https://www.instagram.com/p/TEST10/" },
            { id: "17900000000000002", caption: "Yesterday's post", timestamp: "2026-11-19T10:00:00+0000" },
          ],
        });
      return json({});
    });
    expect(await reconcileTargetIn(memoryStore(w), cfg, t.id, NOW)).toBe("published");
    expect(w.targets[0]).toMatchObject({
      status: "published",
      externalId: "17900000000000010",
      externalKind: "media",
      permalink: "https://www.instagram.com/p/TEST10/",
      reconcileChecks: 1,
    });
    expect(w.post.status).toBe("published");
    expect(posts()).toHaveLength(0);

    // FINISHED: proof it was never published, so the publish step may run.
    const t2 = makeTarget("instagram", { status: "unknown", step: "publish", containerId: "CONTAINER9", lockedAt: LOCKED, attempts: 1 });
    const w2 = world(makePost({ status: "needs_check" }), [t2]);
    route((c) => (c.path === "CONTAINER9" ? json({ status_code: "FINISHED" }) : json({})));
    expect(await reconcileTargetIn(memoryStore(w2), cfg, t2.id, NOW)).toBe("pending");
    expect(w2.targets[0]).toMatchObject({ status: "pending", step: "wait", containerId: "CONTAINER9", errorMessage: null });
    expect(w2.post.status).toBe("publishing");

    // EXPIRED: not published either, and the container is no use: start again.
    const t3 = makeTarget("instagram", { status: "unknown", step: "publish", containerId: "CONTAINER10", childIds: ["C1"], lockedAt: LOCKED });
    const w3 = world(makePost({ status: "needs_check" }), [t3]);
    route((c) => (c.path === "CONTAINER10" ? json({ status_code: "EXPIRED" }) : json({})));
    expect(await reconcileTargetIn(memoryStore(w3), cfg, t3.id, NOW)).toBe("pending");
    expect(w3.targets[0]).toMatchObject({ status: "pending", step: "start", containerId: null, childIds: [] });

    // PUBLISHED but nothing can be picked: posted, not linked.
    const t4 = makeTarget("instagram", { status: "unknown", step: "publish", containerId: "CONTAINER11", lockedAt: LOCKED });
    const w4 = world(makePost({ status: "needs_check" }), [t4]);
    route((c) => (c.path === "CONTAINER11" ? json({ status_code: "PUBLISHED" }) : json({ data: [] })));
    expect(await reconcileTargetIn(memoryStore(w4), cfg, t4.id, NOW)).toBe("published");
    expect(w4.targets[0]).toMatchObject({ status: "published", externalId: null });
    expect(w4.post.statusNote).toBe("Posted, but we could not link it to statistics.");
  });

  it("reconcileTarget: facebook feed with exactly one matching post marks published; two matches stays unknown", async () => {
    const feed = (rows: unknown[]) =>
      route((c) => (c.path === `${PAGE_ID}/feed` && c.method === "GET" ? json({ data: rows }) : json({})));
    const mk = () => {
      const t = makeTarget("facebook", { status: "unknown", step: "publish", lockedAt: LOCKED, attempts: 1 });
      return { t, w: world(makePost({ kind: "text", media: [], status: "needs_check" }), [t]) };
    };
    const match = { id: `${PAGE_ID}_9100`, message: "Fresh juice today ", created_time: "2026-11-20T08:59:10+0000", permalink_url: "https://www.facebook.com/100200300/posts/9100" };
    const old = { id: `${PAGE_ID}_8000`, message: "Fresh juice today", created_time: "2026-11-19T08:00:00+0000" };
    const other = { id: `${PAGE_ID}_9101`, message: "Something else", created_time: "2026-11-20T08:59:20+0000" };

    const one = mk();
    feed([other, match, old]);
    expect(await reconcileTargetIn(memoryStore(one.w), cfg, one.t.id, NOW)).toBe("published");
    expect(one.w.targets[0]).toMatchObject({
      status: "published",
      externalId: `${PAGE_ID}_9100`,
      externalKind: "post",
      permalink: "https://www.facebook.com/100200300/posts/9100",
    });
    expect(one.w.post.status).toBe("published");

    const two = mk();
    feed([match, { ...match, id: `${PAGE_ID}_9102` }]);
    expect(await reconcileTargetIn(memoryStore(two.w), cfg, two.t.id, NOW)).toBe("unknown");
    expect(two.w.targets[0]).toMatchObject({ status: "unknown", externalId: null, reconcileChecks: 1 });

    const none = mk();
    feed([other, old]);
    expect(await reconcileTargetIn(memoryStore(none.w), cfg, none.t.id, NOW)).toBe("unknown");
    expect(none.w.targets[0]!.status).toBe("unknown");
    expect(none.w.post.status).toBe("needs_check");

    // Nothing was ever posted by reconciliation.
    expect(posts()).toHaveLength(0);

    // A Facebook video cannot be looked up: it stays unknown without a call.
    const video: SocialPostMedia = { key: key(4, "mp4"), mime: "video/mp4", bytes: 9_000_000, width: 1080, height: 1920, duration_s: 12, alt_text: null };
    const tv = makeTarget("facebook", { status: "unknown", step: "publish", lockedAt: LOCKED });
    const wv = world(makePost({ kind: "video", media: [video], status: "needs_check" }), [tv]);
    calls = [];
    expect(await reconcileTargetIn(memoryStore(wv), cfg, tv.id, NOW)).toBe("unknown");
    expect(calls).toHaveLength(0);
  });
});

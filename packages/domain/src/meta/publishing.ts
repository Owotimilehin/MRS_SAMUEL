/**
 * Publishing posts to Facebook and Instagram (suite spec 09): the Graph calls, the
 * fingerprint of what a person approved, and the step engine that sends one target
 * (one post on one network) without ever sending it twice.
 *
 * The never-twice rule (foundation rule 9, spec 09 rule 4): the one call after which a
 * post is public is made only after an atomic claim (pending -> publishing). A timeout
 * or a crash after the claim leaves the target "unknown", and nothing here ever retries
 * an unknown target; only proof that it was not published, or a person, re-arms it.
 *
 * Every call uses a Page access token from pageAccessToken() (never stored, never logged).
 */
import crypto from "node:crypto";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import {
  inboxPhoneNumber,
  outboxEvent,
  socialPost,
  socialPostTarget,
  type DbClient,
  type DbExecutor,
  type SocialPostMedia,
} from "@ms/db";
import {
  SOCIAL_MEDIA_KEY_RE,
  effectiveCaption,
  networkName,
  validatePostForNetwork,
  type ChannelKind,
  type PostDraftShape,
  type SocialNetwork,
  type SocialPostKind,
  type SocialPostStatus,
} from "@ms/shared";
import { graph, graphRaw, MetaApiError, type MetaConfig } from "../inbox/meta.js";
import { pageAccessToken, type ChannelAccount } from "./accounts.js";
import { withPageTokenRetry } from "./messaging.js";

export type SocialPostRow = typeof socialPost.$inferSelect;
export type SocialTargetRow = typeof socialPostTarget.$inferSelect;

const enc = encodeURIComponent;

// ── The fingerprint ──────────────────────────────────────────────────────────

/**
 * Lower-case hex SHA-256 of exactly what a person confirmed (spec 09, 5.3). The key
 * order below is part of the contract: do not reorder.
 */
export function postFingerprint(
  post: { kind: string; caption: string; linkUrl: string | null; media: SocialPostMedia[]; scheduledAt: Date | null },
  targets: { accountId: string | null; network: string; captionOverride: string | null }[],
): string {
  const sorted = targets.slice().sort((a, b) => (a.accountId ?? "").localeCompare(b.accountId ?? ""));
  const value = {
    kind: post.kind,
    caption: post.caption,
    link_url: post.linkUrl,
    media: post.media.map((m) => [m.key, m.alt_text ?? ""]),
    targets: sorted.map((t) => [t.accountId ?? "", t.network, t.captionOverride ?? ""]),
    scheduled_at: post.scheduledAt ? post.scheduledAt.toISOString() : null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** The validator's view of a stored post. */
export function postDraftShape(post: { kind: string; caption: string; linkUrl: string | null; media: SocialPostMedia[] }): PostDraftShape {
  return {
    kind: post.kind as SocialPostKind,
    caption: post.caption,
    linkUrl: post.linkUrl,
    media: post.media.map((m) => ({ mime: m.mime, bytes: m.bytes, width: m.width, height: m.height, durationS: m.duration_s })),
  };
}

/** The text actually sent for one target. A story carries no caption. */
export function sentCaption(post: { kind: string; caption: string }, target: { captionOverride: string | null }): string {
  return post.kind === "story" ? "" : effectiveCaption(post.caption, target.captionOverride);
}

// ── Graph calls (5.5) ────────────────────────────────────────────────────────

export async function fbPublishFeed(
  cfg: MetaConfig,
  pageToken: string,
  pageId: string,
  body: { message?: string; link?: string; attached_media?: { media_fbid: string }[] },
): Promise<{ id: string }> {
  const res = await graph<{ id?: string }>(cfg, "POST", `${enc(pageId)}/feed`, body, { token: pageToken, service: "Facebook" });
  return { id: needId(res?.id, "Facebook") };
}

export async function fbPublishPhoto(
  cfg: MetaConfig,
  pageToken: string,
  pageId: string,
  body: { url: string; caption?: string; published: boolean },
): Promise<{ id: string; post_id?: string }> {
  const res = await graph<{ id?: string; post_id?: string }>(cfg, "POST", `${enc(pageId)}/photos`, body, {
    token: pageToken,
    service: "Facebook",
  });
  return { id: needId(res?.id, "Facebook"), ...(res?.post_id ? { post_id: String(res.post_id) } : {}) };
}

/** POST https://graph-video.facebook.com/{version}/{pageId}/videos with a 120 second limit (F6, [unverified] host). */
export async function fbPublishVideo(
  cfg: MetaConfig,
  pageToken: string,
  pageId: string,
  body: { file_url: string; description?: string },
): Promise<{ id: string }> {
  // A test or local base URL replaces both Graph hosts.
  const path = cfg.baseUrl ? `${enc(pageId)}/videos` : `https://graph-video.facebook.com/${cfg.graphVersion}/${enc(pageId)}/videos`;
  const res = await graphRaw<{ id?: string }>(
    cfg,
    "POST",
    path,
    { headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeoutMs: 120_000 },
    { token: pageToken, service: "Facebook" },
  );
  return { id: needId(res?.id, "Facebook") };
}

export async function fbUpdatePostMessage(cfg: MetaConfig, pageToken: string, postId: string, message: string): Promise<void> {
  const res = await graph<{ success?: boolean }>(cfg, "POST", enc(postId), { message }, { token: pageToken, service: "Facebook" });
  if (res && res.success === false) throw new MetaApiError("Facebook did not confirm the change", 502, null, false);
}

export async function fbDeleteObject(cfg: MetaConfig, pageToken: string, id: string): Promise<void> {
  const res = await graph<{ success?: boolean }>(cfg, "DELETE", enc(id), undefined, { token: pageToken, service: "Facebook" });
  if (res && res.success === false) throw new MetaApiError("Facebook did not confirm the removal", 502, null, false);
}

export async function fbRecentPosts(
  cfg: MetaConfig,
  pageToken: string,
  pageId: string,
): Promise<{ id: string; message?: string; created_time: string; permalink_url?: string }[]> {
  const res = await graph<{ data?: { id?: string; message?: string; created_time?: string; permalink_url?: string }[] }>(
    cfg,
    "GET",
    `${enc(pageId)}/feed?fields=id,message,created_time,permalink_url&limit=25`,
    undefined,
    { token: pageToken, service: "Facebook" },
  );
  return (res?.data ?? []).flatMap((p) =>
    p.id && p.created_time
      ? [
          {
            id: String(p.id),
            created_time: p.created_time,
            ...(p.message !== undefined ? { message: p.message } : {}),
            ...(p.permalink_url ? { permalink_url: p.permalink_url } : {}),
          },
        ]
      : [],
  );
}

/** GET /{id}?fields=permalink_url ; null on any error. */
export async function fbPostPermalink(cfg: MetaConfig, pageToken: string, id: string): Promise<string | null> {
  try {
    const res = await graph<{ permalink_url?: string }>(cfg, "GET", `${enc(id)}?fields=permalink_url`, undefined, {
      token: pageToken,
      service: "Facebook",
    });
    const link = res?.permalink_url;
    if (!link) return null;
    return link.startsWith("/") ? `https://www.facebook.com${link}` : link;
  } catch {
    return null;
  }
}

export async function igCreateContainer(cfg: MetaConfig, pageToken: string, igId: string, body: Record<string, unknown>): Promise<string> {
  const res = await graph<{ id?: string }>(cfg, "POST", `${enc(igId)}/media`, body, { token: pageToken, service: "Instagram" });
  return needId(res?.id, "Instagram");
}

export type IgContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";
const IG_STATUSES: readonly string[] = ["EXPIRED", "ERROR", "FINISHED", "IN_PROGRESS", "PUBLISHED"];

export async function igContainerStatus(cfg: MetaConfig, pageToken: string, containerId: string): Promise<IgContainerStatus> {
  const res = await graph<{ status_code?: string }>(cfg, "GET", `${enc(containerId)}?fields=status_code`, undefined, {
    token: pageToken,
    service: "Instagram",
  });
  const s = res?.status_code ?? "";
  // An answer we do not know is treated as "not ready yet": the safe reading.
  return IG_STATUSES.includes(s) ? (s as IgContainerStatus) : "IN_PROGRESS";
}

export async function igPublishContainer(cfg: MetaConfig, pageToken: string, igId: string, containerId: string): Promise<string> {
  const res = await graph<{ id?: string }>(cfg, "POST", `${enc(igId)}/media_publish`, { creation_id: containerId }, {
    token: pageToken,
    service: "Instagram",
  });
  return needId(res?.id, "Instagram");
}

export async function igMediaInfo(cfg: MetaConfig, pageToken: string, mediaId: string): Promise<{ permalink: string | null }> {
  const res = await graph<{ permalink?: string }>(cfg, "GET", `${enc(mediaId)}?fields=permalink`, undefined, {
    token: pageToken,
    service: "Instagram",
  });
  return { permalink: res?.permalink ?? null };
}

export async function igRecentMedia(
  cfg: MetaConfig,
  pageToken: string,
  igId: string,
): Promise<{ id: string; caption?: string; timestamp: string; permalink?: string }[]> {
  const res = await graph<{ data?: { id?: string; caption?: string; timestamp?: string; permalink?: string }[] }>(
    cfg,
    "GET",
    `${enc(igId)}/media?fields=id,caption,timestamp,permalink&limit=10`,
    undefined,
    { token: pageToken, service: "Instagram" },
  );
  return (res?.data ?? []).flatMap((m) =>
    m.id && m.timestamp
      ? [
          {
            id: String(m.id),
            timestamp: m.timestamp,
            ...(m.caption !== undefined ? { caption: m.caption } : {}),
            ...(m.permalink ? { permalink: m.permalink } : {}),
          },
        ]
      : [],
  );
}

export async function igPublishingQuota(cfg: MetaConfig, pageToken: string, igId: string): Promise<{ used: number; total: number }> {
  const res = await graph<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>(
    cfg,
    "GET",
    `${enc(igId)}/content_publishing_limit?fields=quota_usage,config`,
    undefined,
    { token: pageToken, service: "Instagram" },
  );
  const row = res?.data?.[0];
  const used = Number(row?.quota_usage);
  const total = Number(row?.config?.quota_total);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    throw new MetaApiError("Instagram did not say how many posts are left today", 502, null, false);
  }
  return { used, total };
}

export async function igDeleteMedia(cfg: MetaConfig, pageToken: string, mediaId: string): Promise<void> {
  const res = await graph<{ success?: boolean }>(cfg, "DELETE", enc(mediaId), undefined, { token: pageToken, service: "Instagram" });
  if (res && res.success === false) throw new MetaApiError("Instagram did not confirm the removal", 502, null, false);
}

/** Meta said yes but sent no ID: we cannot tell what happened, so it is "unknown", never "failed". */
function needId(id: unknown, service: string): string {
  if (id === undefined || id === null || id === "") throw new MetaApiError(`${service} returned no ID`, 502, null, false, "unknown");
  return String(id);
}

// ── Error sorting (3.3, D10, C2, C3) ─────────────────────────────────────────

export interface PublishErrorClass {
  kind: "temporary" | "configuration" | "refusal";
  staffMessage: string;
  retryAfterMs: number | null;
}

export const IG_QUOTA_TEXT = "Instagram's daily posting limit has been reached. We will try again in an hour.";
export const IG_QUOTA_DAY_TEXT = "Instagram's daily posting limit stayed full for a day.";
const IG_RECEIVING_TEXT = "Instagram had a problem receiving the file. We are trying again.";
const CONFIG_TEXT = "The suite has lost its connection or permission for this account. Ask the owner to check Channels.";

const BY_SUBCODE: Record<string, PublishErrorClass> = {
  "2207042": { kind: "temporary", staffMessage: IG_QUOTA_TEXT, retryAfterMs: 3_600_000 },
  "2207027": { kind: "temporary", staffMessage: "Instagram is still getting the file ready.", retryAfterMs: 30_000 },
  "2207008": { kind: "temporary", staffMessage: "Instagram lost the prepared post. We are preparing it again.", retryAfterMs: null },
  "2207003": { kind: "temporary", staffMessage: IG_RECEIVING_TEXT, retryAfterMs: null },
  "2207001": { kind: "temporary", staffMessage: IG_RECEIVING_TEXT, retryAfterMs: null },
  "2207032": { kind: "temporary", staffMessage: IG_RECEIVING_TEXT, retryAfterMs: null },
  "2207053": { kind: "temporary", staffMessage: IG_RECEIVING_TEXT, retryAfterMs: null },
  "2207052": {
    kind: "refusal",
    staffMessage: "Instagram could not download the file from our storage. Try again; if it keeps failing tell the technical team.",
    retryAfterMs: null,
  },
  "2207004": { kind: "refusal", staffMessage: "Instagram refused this: the picture is larger than 8 MB.", retryAfterMs: null },
  "2207005": { kind: "refusal", staffMessage: "Instagram refused this: the picture must be a JPEG.", retryAfterMs: null },
  "2207009": {
    kind: "refusal",
    staffMessage: "Instagram refused this: the picture is too tall or too wide. Crop it to between 4:5 and 1.91:1.",
    retryAfterMs: null,
  },
  "2207010": {
    kind: "refusal",
    staffMessage: "Instagram refused this: the caption is too long (2,200 characters, 30 hashtags, 20 mentions at most).",
    retryAfterMs: null,
  },
  "2207026": { kind: "refusal", staffMessage: "Instagram refused this: the video must be MP4 or MOV.", retryAfterMs: null },
  "2207028": { kind: "refusal", staffMessage: "Instagram refused this: an album needs 2 to 10 items.", retryAfterMs: null },
  "2207050": {
    kind: "configuration",
    staffMessage: "Instagram has restricted the account. Open the Instagram app and follow its instructions.",
    retryAfterMs: null,
  },
  "2207051": { kind: "refusal", staffMessage: "Instagram blocked this as suspected spam. Wait a while before posting again.", retryAfterMs: null },
};
// Table 3.3 also names the top-level code for each row; Meta sometimes sends only that.
const SUBCODE_FOR_CODE: Record<string, string> = {
  "9007": "2207027",
  "9004": "2207052",
  "36000": "2207004",
  "36001": "2207005",
  "36003": "2207009",
  "36004": "2207010",
  "352": "2207026",
};

const CONFIG_CODES = new Set(["190", "10", "200", "299", "283", "no_page_token"]);
const TEMPORARY_CODES = new Set(["1", "2", "4", "17", "32", "613", "80014"]);
for (let c = 80000; c <= 80009; c++) TEMPORARY_CODES.add(String(c));

/** D10 sorting, plus section 3.3. `subcode` comes from Meta's error_subcode. */
export function classifyPublishError(err: MetaApiError, subcode: string | null, network?: SocialNetwork): PublishErrorClass {
  const name = network ? networkName(network) : "Meta";
  const known = (subcode && BY_SUBCODE[subcode]) || (err.code && !subcode && BY_SUBCODE[SUBCODE_FOR_CODE[err.code] ?? ""]) || null;
  if (known) return known;
  if (err.code && CONFIG_CODES.has(err.code)) return { kind: "configuration", staffMessage: CONFIG_TEXT, retryAfterMs: null };
  if (err.status === 0) {
    return { kind: "temporary", staffMessage: `We could not reach ${name}. We are trying again.`, retryAfterMs: null };
  }
  if ((err.code && TEMPORARY_CODES.has(err.code)) || err.status === 429 || err.status >= 500) {
    return { kind: "temporary", staffMessage: `${name} is busy. We are trying again.`, retryAfterMs: null };
  }
  return { kind: "refusal", staffMessage: `${name} refused this: ${err.message}`, retryAfterMs: null };
}

// ── Post status from its targets (rule 9) ────────────────────────────────────

/** Rule 9. Null when the post has no targets. `removed` rows are ignored unless all are removed. */
export function postStatusFromTargets(statuses: readonly string[]): SocialPostStatus | null {
  if (statuses.length === 0) return null;
  const live = statuses.filter((s) => s !== "removed");
  if (live.length === 0) return "published";
  if (live.some((s) => s === "pending" || s === "publishing")) return "publishing";
  if (live.some((s) => s === "unknown")) return "needs_check";
  if (live.every((s) => s === "published")) return "published";
  if (live.every((s) => s === "failed")) return "failed";
  return "partly_published";
}

/** The post statuses in which the targets decide the post's status. A draft or a scheduled post is never touched. */
const LIVE_POST_STATUSES = ["publishing", "published", "partly_published", "failed", "needs_check"];

/** Recompute a post's status from its targets (rule 9). Returns the new status, or null when nothing applies. */
export async function recomputePostStatus(db: DbExecutor, postId: string, now: Date = new Date()): Promise<SocialPostStatus | null> {
  const rows = await db.select({ status: socialPostTarget.status }).from(socialPostTarget).where(eq(socialPostTarget.postId, postId));
  const next = postStatusFromTargets(rows.map((r) => r.status));
  if (!next) return null;
  await db
    .update(socialPost)
    .set({ status: next, updatedAt: now })
    .where(and(eq(socialPost.id, postId), inArray(socialPost.status, LIVE_POST_STATUSES), ne(socialPost.status, next)));
  return next;
}

// ── The store the engine works through ───────────────────────────────────────

export interface LoadedTarget {
  target: SocialTargetRow;
  post: SocialPostRow;
  /** Null when the channel account row no longer exists. */
  account: ChannelAccount | null;
  /** Every target of the post (this one included), for the fingerprint. */
  siblings: { accountId: string | null; network: string; captionOverride: string | null }[];
}

export type TargetPatch = Partial<
  Pick<
    SocialTargetRow,
    | "status"
    | "step"
    | "containerId"
    | "childIds"
    | "permalink"
    | "attempts"
    | "reconcileChecks"
    | "nextAttemptAt"
    | "waitStartedAt"
    | "lockedAt"
    | "errorCode"
    | "errorSubcode"
    | "errorMessage"
  >
>;

export interface PublishedResult {
  externalId: string | null;
  externalKind: "post" | "video" | "media" | null;
  permalink?: string | null;
}

/**
 * Everything the engine reads and writes. The real one is dbPublishStore(db); unit
 * tests use an in-memory one, so the rules are tested without a database.
 */
export interface PublishStore {
  load(targetId: string): Promise<LoadedTarget | null>;
  /** Update a target; with `whenStatus`, only if it still has that status. True when a row changed. */
  patchTarget(targetId: string, patch: TargetPatch, now: Date, whenStatus?: string): Promise<boolean>;
  /** The atomic claim: pending -> publishing, attempts + 1, only while the post is "publishing". */
  claim(targetId: string, now: Date): Promise<boolean>;
  /** Section 5.7 in one transaction: mark published, then recompute the post. False if the status had moved on. */
  publishResult(targetId: string, result: PublishedResult, now: Date, whenStatus: string): Promise<boolean>;
  recompute(postId: string, now: Date): Promise<void>;
  /** publishing -> failed with a note (the fingerprint backstop). */
  failPost(postId: string, note: string, now: Date): Promise<void>;
  notePost(postId: string, note: string, now: Date): Promise<void>;
  /** Is this network's external ID already linked to a target? */
  externalIdTaken(network: string, externalId: string): Promise<boolean>;
  /** One owner alert per account per 24 hours. */
  alertConfig(payload: { network: string; account_id: string; label: string; code: string | null; message: string }): Promise<void>;
}

export const SOCIAL_CONFIG_ALERT = "social.publish_config_error";

export function dbPublishStore(db: DbClient): PublishStore {
  return {
    async load(targetId) {
      const [target] = await db.select().from(socialPostTarget).where(eq(socialPostTarget.id, targetId));
      if (!target) return null;
      const [post] = await db.select().from(socialPost).where(eq(socialPost.id, target.postId));
      if (!post) return null;
      const siblings = await db
        .select({ accountId: socialPostTarget.accountId, network: socialPostTarget.network, captionOverride: socialPostTarget.captionOverride })
        .from(socialPostTarget)
        .where(eq(socialPostTarget.postId, post.id));
      let account: ChannelAccount | null = null;
      if (target.accountId) {
        const [a] = await db
          .select({
            id: inboxPhoneNumber.id,
            kind: inboxPhoneNumber.kind,
            label: inboxPhoneNumber.label,
            externalId: inboxPhoneNumber.externalId,
            pageId: inboxPhoneNumber.pageExternalId,
            isActive: inboxPhoneNumber.isActive,
          })
          .from(inboxPhoneNumber)
          .where(eq(inboxPhoneNumber.id, target.accountId));
        if (a) account = { ...a, kind: a.kind as ChannelKind };
      }
      return { target, post, account, siblings };
    },
    async patchTarget(targetId, patch, now, whenStatus) {
      const rows = await db
        .update(socialPostTarget)
        .set({ ...patch, updatedAt: now })
        .where(and(eq(socialPostTarget.id, targetId), whenStatus ? eq(socialPostTarget.status, whenStatus) : undefined))
        .returning({ id: socialPostTarget.id });
      return rows.length > 0;
    },
    async claim(targetId, now) {
      const rows = await db
        .update(socialPostTarget)
        .set({ status: "publishing", step: "publish", lockedAt: now, attempts: sql`${socialPostTarget.attempts} + 1`, updatedAt: now })
        .where(
          and(
            eq(socialPostTarget.id, targetId),
            eq(socialPostTarget.status, "pending"),
            sql`exists (select 1 from ${socialPost} where ${socialPost.id} = ${socialPostTarget.postId} and ${socialPost.status} = 'publishing')`,
          ),
        )
        .returning({ id: socialPostTarget.id });
      return rows.length > 0;
    },
    async publishResult(targetId, result, now, whenStatus) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(socialPostTarget)
          .set({
            status: "published",
            step: "done",
            externalId: result.externalId,
            externalKind: result.externalKind,
            ...(result.permalink !== undefined ? { permalink: result.permalink } : {}),
            publishedAt: now,
            errorCode: null,
            errorSubcode: null,
            errorMessage: null,
            updatedAt: now,
          })
          .where(and(eq(socialPostTarget.id, targetId), eq(socialPostTarget.status, whenStatus)))
          .returning({ postId: socialPostTarget.postId });
        if (!row) return false;
        await recomputePostStatus(tx, row.postId, now);
        return true;
      });
    },
    async recompute(postId, now) {
      await recomputePostStatus(db, postId, now);
    },
    async failPost(postId, note, now) {
      await db
        .update(socialPost)
        .set({ status: "failed", statusNote: note, updatedAt: now })
        .where(and(eq(socialPost.id, postId), eq(socialPost.status, "publishing")));
    },
    async notePost(postId, note, now) {
      await db.update(socialPost).set({ statusNote: note, updatedAt: now }).where(eq(socialPost.id, postId));
    },
    async externalIdTaken(network, externalId) {
      const [row] = await db
        .select({ id: socialPostTarget.id })
        .from(socialPostTarget)
        .where(and(eq(socialPostTarget.network, network), eq(socialPostTarget.externalId, externalId)))
        .limit(1);
      return !!row;
    },
    async alertConfig(payload) {
      const [recent] = await db
        .select({ id: outboxEvent.id })
        .from(outboxEvent)
        .where(
          and(
            eq(outboxEvent.eventType, SOCIAL_CONFIG_ALERT),
            gt(outboxEvent.createdAt, new Date(Date.now() - 24 * 3600_000)),
            sql`${outboxEvent.payload}->>'account_id' = ${payload.account_id}`,
          ),
        )
        .limit(1);
      if (recent) return;
      // `account` as well as `account_id`, so the API's alertOnce (which keys on payload.account) sees the same alert.
      await db.insert(outboxEvent).values({ eventType: SOCIAL_CONFIG_ALERT, payload: { ...payload, account: payload.account_id } });
    },
  };
}

// ── The step engine (6.2) ────────────────────────────────────────────────────

export type AdvanceResult = "published" | "waiting" | "retry" | "failed" | "unknown";
export type SignUrl = (key: string) => Promise<string>;

export const PUBLISH_MAX_ATTEMPTS = 4;
export const PUBLISH_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const IG_WAIT_POLL_MS = 30_000;
const IG_WAIT_PICTURE_MS = 10 * 60_000;
const IG_WAIT_VIDEO_MS = 30 * 60_000;
const IG_CONTAINER_MAX_AGE_MS = 23 * 3_600_000;
const QUOTA_WAIT_MS = 3_600_000;
const QUOTA_GIVE_UP_MS = 24 * 3_600_000;

export const POST_CHANGED_NOTE = "The post changed after it was approved, so it was not sent.";
export const ACCOUNT_OFF_TEXT = "This account is switched off in Channels.";
export const NO_STORAGE_TEXT = "File storage is not set up on the server.";
export const UNKNOWN_TEXT = "We could not tell whether this posted.";
export const NOT_LINKED_NOTE = "Posted, but we could not link it to statistics.";
const IG_SLOW_TEXT = "Instagram took too long to get this ready. Try again.";
const ACCOUNT_BROKEN_TEXT = "This account is not connected properly. Check it in Channels.";

const metaSaid = (staff: string, err: MetaApiError): string => `${staff} — Meta said: ${err.message}`;
const isVideoMime = (mime: string): boolean => mime.startsWith("video/");

type Risky = (token: string) => Promise<PublishedResult>;

/**
 * Move one target as far as it can go now. See the file header for the never-twice rule.
 * `signUrl` makes a fresh short-lived link for a media key (rule 12); null when file
 * storage is not set up, in which case posts with media fail and text posts still go.
 */
export async function advanceTarget(
  db: DbClient,
  cfg: MetaConfig,
  targetId: string,
  signUrl: SignUrl | null,
  now: Date = new Date(),
): Promise<AdvanceResult> {
  return advanceTargetIn(dbPublishStore(db), cfg, targetId, signUrl, now);
}

export async function advanceTargetIn(
  store: PublishStore,
  cfg: MetaConfig,
  targetId: string,
  signUrl: SignUrl | null,
  now: Date = new Date(),
): Promise<AdvanceResult> {
  const loaded = await store.load(targetId);
  if (!loaded) return "failed";
  const { target, post, account, siblings } = loaded;
  // Only a pending target of a post that is going out is ever touched (rule 1).
  if (target.status !== "pending" || post.status !== "publishing") return "waiting";
  if (target.nextAttemptAt.getTime() > now.getTime()) return "waiting";

  // Rule 2: what was confirmed is what is sent. A mismatch never publishes.
  if (!post.approvedHash || postFingerprint(post, siblings) !== post.approvedHash) {
    await store.failPost(post.id, POST_CHANGED_NOTE, now);
    return "failed";
  }

  const network = target.network as SocialNetwork;
  const fail = async (text: string, err?: MetaApiError): Promise<AdvanceResult> => {
    await store.patchTarget(
      target.id,
      {
        status: "failed",
        errorCode: err?.code ?? null,
        errorSubcode: err?.subcode ?? null,
        errorMessage: err ? metaSaid(text, err) : text,
      },
      now,
    );
    await store.recompute(post.id, now);
    return "failed";
  };

  // Rule 16, and an account that cannot serve this network.
  if (!account || !account.isActive) return fail(ACCOUNT_OFF_TEXT);
  const pageId = network === "facebook" ? account.externalId : account.pageId;
  const wantKind = network === "facebook" ? "messenger" : "instagram";
  if (account.kind !== wantKind || !account.externalId || !pageId) return fail(ACCOUNT_BROKEN_TEXT);
  const igId = account.externalId;

  // The same rules the composer and the approve route applied, as a backstop.
  const blocking = validatePostForNetwork(postDraftShape(post), network, effectiveCaption(post.caption, target.captionOverride)).find(
    (p) => p.blocking,
  );
  if (blocking) return fail(blocking.message);
  if (post.media.length > 0 && !signUrl) return fail(NO_STORAGE_TEXT);
  if (post.media.some((m) => !SOCIAL_MEDIA_KEY_RE.test(m.key))) return fail("A file on this post is not one of ours, so it was not sent.");

  const caption = sentCaption(post, target);
  const text = caption === "" ? {} : null;
  const url = (i: number): Promise<string> => signUrl!(post.media[i]!.key);
  const call = <T>(fn: (token: string) => Promise<T>): Promise<T> => withPageTokenRetry(cfg, pageId, fn);
  const patch = (p: TargetPatch): Promise<boolean> => store.patchTarget(target.id, p, now);

  /** A temporary, configuration or refusal error, in a safe step or after the claim (attempts already counted there). */
  const onError = async (err: MetaApiError, attempts: number): Promise<AdvanceResult> => {
    const c = classifyPublishError(err, err.subcode, network);
    if (c.kind === "configuration") {
      await store.alertConfig({ network, account_id: account.id, label: account.label, code: err.code, message: err.message });
      return fail(c.staffMessage, err);
    }
    if (c.kind === "refusal") return fail(c.staffMessage, err);
    if (attempts >= PUBLISH_MAX_ATTEMPTS) {
      await patch({ attempts });
      return fail(`${c.staffMessage} (tried ${PUBLISH_MAX_ATTEMPTS} times)`, err);
    }
    await patch({
      status: "pending",
      attempts,
      nextAttemptAt: new Date(now.getTime() + (c.retryAfterMs ?? PUBLISH_RETRY_DELAYS_MS[attempts - 1] ?? 15 * 60_000)),
      errorCode: err.code,
      errorSubcode: err.subcode,
      errorMessage: metaSaid(c.staffMessage, err),
      // The prepared post is gone at Instagram: build it again. "Not ready": go back to waiting.
      ...(err.subcode === "2207008" ? { containerId: null, childIds: [], step: "start", waitStartedAt: null } : {}),
      ...(err.subcode === "2207027" ? { step: "wait" } : {}),
    });
    await store.recompute(post.id, now);
    return "retry";
  };

  // ── Safe steps: may be repeated without harm. Each result is saved before the next call. ──
  let risky: Risky;
  try {
    if (network === "facebook") {
      if (post.kind === "text") {
        risky = async (t) => ({ externalId: (await fbPublishFeed(cfg, t, pageId, { message: caption })).id, externalKind: "post" });
      } else if (post.kind === "link") {
        const body = { ...(text ?? { message: caption }), link: post.linkUrl ?? "" };
        risky = async (t) => ({ externalId: (await fbPublishFeed(cfg, t, pageId, body)).id, externalKind: "post" });
      } else if (post.kind === "photo") {
        const body = { url: await url(0), ...(text ?? { caption }), published: true };
        risky = async (t) => {
          const r = await fbPublishPhoto(cfg, t, pageId, body);
          return { externalId: r.post_id ?? r.id, externalKind: "post" };
        };
      } else if (post.kind === "album") {
        const children = [...target.childIds];
        for (let i = children.length; i < post.media.length; i++) {
          const link = await url(i);
          const r = await call((t) => fbPublishPhoto(cfg, t, pageId, { url: link, published: false }));
          children.push(r.id);
          await patch({ childIds: [...children], step: "media" });
        }
        const body = { ...(text ?? { message: caption }), attached_media: children.map((id) => ({ media_fbid: id })) };
        risky = async (t) => ({ externalId: (await fbPublishFeed(cfg, t, pageId, body)).id, externalKind: "post" });
      } else {
        const body = { file_url: await url(0), ...(text ?? { description: caption }) };
        risky = async (t) => ({ externalId: (await fbPublishVideo(cfg, t, pageId, body)).id, externalKind: "video" });
      }
    } else {
      // Before the first Instagram step: is there room in today's limit? (5.6, rule 10)
      if (target.step === "start") {
        let quota: { used: number; total: number } | null = null;
        try {
          quota = await call((t) => igPublishingQuota(cfg, t, igId));
        } catch (err) {
          // Not being able to read the limit never blocks a post, unless the account itself is the problem.
          if (err instanceof MetaApiError && classifyPublishError(err, err.subcode, network).kind === "configuration") throw err;
        }
        if (quota && quota.used >= quota.total) {
          const since = post.approvedAt ?? post.updatedAt;
          if (now.getTime() - since.getTime() > QUOTA_GIVE_UP_MS) return fail(IG_QUOTA_DAY_TEXT);
          await patch({ nextAttemptAt: new Date(now.getTime() + QUOTA_WAIT_MS), errorMessage: IG_QUOTA_TEXT });
          return "waiting";
        }
      }

      let containerId = target.containerId;
      let waitStartedAt = target.waitStartedAt;
      if (!containerId) {
        const first = post.media[0]!;
        let body: Record<string, unknown>;
        if (post.kind === "album") {
          const children = [...target.childIds];
          for (let i = children.length; i < post.media.length; i++) {
            const m = post.media[i]!;
            const link = await url(i);
            const id = await call((t) =>
              igCreateContainer(cfg, t, igId, { image_url: link, is_carousel_item: true, ...(m.alt_text ? { alt_text: m.alt_text } : {}) }),
            );
            children.push(id);
            await patch({ childIds: [...children], step: "media" });
          }
          body = { media_type: "CAROUSEL", children: children.join(","), ...(text ?? { caption }) };
        } else if (post.kind === "video") {
          body = { media_type: "REELS", video_url: await url(0), ...(text ?? { caption }), share_to_feed: true };
        } else if (post.kind === "story") {
          body = { media_type: "STORIES", ...(isVideoMime(first.mime) ? { video_url: await url(0) } : { image_url: await url(0) }) };
        } else {
          body = { image_url: await url(0), ...(text ?? { caption }), ...(first.alt_text ? { alt_text: first.alt_text } : {}) };
        }
        await patch({ step: "container" });
        containerId = await call((t) => igCreateContainer(cfg, t, igId, body));
        waitStartedAt = now;
        await patch({ containerId, step: "wait", waitStartedAt });
      }

      // Rule 11: a container older than 23 hours is thrown away and built again.
      const waited = now.getTime() - (waitStartedAt ?? now).getTime();
      if (waited > IG_CONTAINER_MAX_AGE_MS) {
        await patch({ containerId: null, childIds: [], step: "start", waitStartedAt: null, nextAttemptAt: now });
        return "retry";
      }
      const readyId = containerId;
      const status = await call((t) => igContainerStatus(cfg, t, readyId));
      if (status === "IN_PROGRESS") {
        const limit = post.media.some((m) => isVideoMime(m.mime)) ? IG_WAIT_VIDEO_MS : IG_WAIT_PICTURE_MS;
        if (waited > limit) return fail(IG_SLOW_TEXT);
        await patch({ step: "wait", nextAttemptAt: new Date(now.getTime() + IG_WAIT_POLL_MS) });
        return "waiting";
      }
      if (status === "ERROR" || status === "EXPIRED") {
        await patch({ containerId: null, childIds: [], step: "start", waitStartedAt: null });
        return await onError(
          new MetaApiError(`Instagram could not prepare the file (${status})`, 400, null, true, "not_sent", "2207001"),
          target.attempts + 1,
        );
      }
      if (status === "PUBLISHED") {
        // Already public, and we hold no record of doing it: a person or reconciliation settles it. Never publish again.
        await patch({ status: "unknown", lockedAt: target.lockedAt ?? now, errorMessage: UNKNOWN_TEXT });
        await store.recompute(post.id, now);
        return "unknown";
      }
      risky = async (t) => ({ externalId: await igPublishContainer(cfg, t, igId, readyId), externalKind: "media" });
    }
    // Have the Page token in hand before the claim, so nothing but the one call sits between claim and result.
    await pageAccessToken(cfg, pageId);
  } catch (err) {
    if (err instanceof MetaApiError) return onError(err, target.attempts + 1);
    // Our own trouble in a safe step (signing a link, the database): try again later, like a temporary error.
    return onError(new MetaApiError("The suite had a problem preparing this post", 0, null, true), target.attempts + 1);
  }

  // ── The risky call (foundation rule 9): claim, call once, record. ──
  if (!(await store.claim(target.id, now))) return "waiting";
  const attempts = target.attempts + 1;
  let result: PublishedResult;
  try {
    result = await call(risky);
  } catch (err) {
    if (err instanceof MetaApiError && err.delivery === "not_sent") return onError(err, attempts);
    // A timeout, a dropped connection, a bare 5xx, or anything we did not expect: it may be public. Never retried.
    const meta = err instanceof MetaApiError ? err : null;
    await patch({
      status: "unknown",
      errorCode: meta?.code ?? null,
      errorSubcode: meta?.subcode ?? null,
      errorMessage: meta ? metaSaid(UNKNOWN_TEXT, meta) : UNKNOWN_TEXT,
    });
    await store.recompute(post.id, now);
    return "unknown";
  }

  // Section 5.7. If this write fails the target stays "publishing" and reconciliation picks it up; it is never sent again.
  await store.publishResult(target.id, result, now, "publishing");

  // Outside the transaction, and never failing the publish: the link to the post.
  let permalink: string | null = null;
  try {
    if (result.externalId) {
      const id = result.externalId;
      permalink = network === "facebook" ? await call((t) => fbPostPermalink(cfg, t, id)) : (await call((t) => igMediaInfo(cfg, t, id))).permalink;
      if (permalink) await patch({ permalink });
    }
  } catch {
    /* the link is a convenience; the post is out */
  }
  // spec 03: register social_post_ref here — network, account.externalId, result.externalId, permalink, caption and
  // `now` (the publish time) are all in scope. packages/domain/src/meta/comments.ts did not exist when this was built.
  void permalink;
  return "published";
}

// ── Reconciliation (6.3) ─────────────────────────────────────────────────────

export const MAX_RECONCILE_CHECKS = 3;
const RECONCILE_SLACK_MS = 60_000;

/**
 * Look once at Meta to settle an "unknown" target. Marks it published when Meta proves
 * it is out, re-arms it only when Meta proves it is not (an Instagram container that
 * was never published), and otherwise leaves it unknown for a person.
 */
export async function reconcileTarget(db: DbClient, cfg: MetaConfig, targetId: string, now: Date = new Date()): Promise<"published" | "pending" | "unknown"> {
  return reconcileTargetIn(dbPublishStore(db), cfg, targetId, now);
}

export async function reconcileTargetIn(
  store: PublishStore,
  cfg: MetaConfig,
  targetId: string,
  now: Date = new Date(),
): Promise<"published" | "pending" | "unknown"> {
  const loaded = await store.load(targetId);
  if (!loaded || loaded.target.status !== "unknown") return "unknown";
  const { target, post, account } = loaded;
  await store.patchTarget(target.id, { reconcileChecks: target.reconcileChecks + 1 }, now, "unknown");

  const network = target.network as SocialNetwork;
  const pageId = account ? (network === "facebook" ? account.externalId : account.pageId) : null;
  const since = (target.lockedAt ?? target.updatedAt).getTime() - RECONCILE_SLACK_MS;
  const sent = sentCaption(post, target);
  const rearm = async (p: TargetPatch): Promise<"pending" | "unknown"> => {
    const moved = await store.patchTarget(
      target.id,
      { status: "pending", nextAttemptAt: now, errorCode: null, errorSubcode: null, errorMessage: null, ...p },
      now,
      "unknown",
    );
    return moved ? "pending" : "unknown";
  };

  let outcome: "published" | "pending" | "unknown" = "unknown";
  try {
    if (account && account.externalId && pageId) {
      const call = <T>(fn: (token: string) => Promise<T>): Promise<T> => withPageTokenRetry(cfg, pageId, fn);
      if (network === "instagram" && target.containerId) {
        const igId = account.externalId;
        const containerId = target.containerId;
        const status = await call((t) => igContainerStatus(cfg, t, containerId));
        if (status === "PUBLISHED") {
          const recent = await call((t) => igRecentMedia(cfg, t, igId));
          const fresh: typeof recent = [];
          for (const m of recent) {
            if (new Date(m.timestamp).getTime() >= since && !(await store.externalIdTaken("instagram", m.id))) fresh.push(m);
          }
          const sameText = fresh.filter((m) => (m.caption ?? "").trim() === sent);
          const pick = fresh.length === 1 ? fresh[0]! : sameText.length === 1 ? sameText[0]! : null;
          const done = await store.publishResult(
            target.id,
            { externalId: pick?.id ?? null, externalKind: pick ? "media" : null, permalink: pick?.permalink ?? null },
            now,
            "unknown",
          );
          if (done) {
            if (!pick) await store.notePost(post.id, NOT_LINKED_NOTE, now);
            outcome = "published";
          }
        } else if (status === "FINISHED" || status === "IN_PROGRESS") {
          // Proof it was not published: the publish call is safe to make.
          outcome = await rearm({ step: "wait" });
        } else {
          outcome = await rearm({ step: "start", containerId: null, childIds: [], waitStartedAt: null });
        }
      } else if (network === "facebook" && post.kind !== "video") {
        const recent = await call((t) => fbRecentPosts(cfg, t, pageId));
        const fresh: typeof recent = [];
        for (const p of recent) {
          if (new Date(p.created_time).getTime() < since) continue;
          if (sent !== "" && (p.message ?? "").trim() !== sent) continue;
          if (!(await store.externalIdTaken("facebook", p.id))) fresh.push(p);
        }
        if (fresh.length === 1) {
          const pick = fresh[0]!;
          const done = await store.publishResult(
            target.id,
            { externalId: pick.id, externalKind: "post", permalink: pick.permalink_url ?? null },
            now,
            "unknown",
          );
          if (done) outcome = "published";
        }
      }
      // A Facebook video has no verified way to be looked up (F12): it stays unknown for a person.
    }
  } catch (err) {
    if (!(err instanceof MetaApiError)) throw err;
    // Could not look: it stays unknown, and the check is counted.
  }
  await store.recompute(post.id, now);
  return outcome;
}

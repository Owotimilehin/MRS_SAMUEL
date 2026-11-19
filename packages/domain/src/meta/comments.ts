/**
 * Comments on Facebook Page posts and Instagram posts (suite spec 03).
 *
 * Four parts, in this order:
 *   1. Parsers: one webhook change → one ParsedCommentChange (pure).
 *   2. Ingestion: applyCommentChange writes a parsed change; it is used by the
 *      webhook (through META_CHANGE_HANDLERS in inbox/messenger-ingest.ts, the
 *      single dispatch point, foundation ruling 9.2.3), by the polling job and by
 *      the first load. Safe to run twice.
 *   3. Graph calls, each with the Page access token (never stored, never logged).
 *   4. Actions a person takes: public reply, hide, show, delete, like, private
 *      reply. A public reply and a private reply are written locally first and
 *      are never sent twice (foundation rule 9); nothing here runs unattended.
 *
 * No function holds a database transaction open across a call to Meta.
 */
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  inboxConversation,
  inboxMessage,
  inboxPhoneNumber,
  outboxEvent,
  socialComment,
  socialCommentAccount,
  socialPostRef,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import { PRIVATE_REPLY_DAYS, canPrivateReply, networkName, type CommentKind, type CommentSendStatus, type SocialNetwork } from "@ms/shared";
import { graph, MetaApiError, type MetaConfig } from "../inbox/meta.js";
import { findOrCreateCustomerByIdentity, findOrOpenConversation, publishInboxEvent, signalFor, touchConversation, ts } from "../inbox/core.js";
import {
  META_CHANGE_HANDLERS,
  metaEventTime,
  type MetaChangeHandler,
  type MetaEntry,
  type MetaWebhookPayload,
} from "../inbox/messenger-ingest.js";
import { channelAccountByExternalId, type ChannelAccount } from "./accounts.js";
import { withPageTokenRetry } from "./messaging.js";

export type SocialCommentRow = typeof socialComment.$inferSelect;
export type SocialPostRefRow = typeof socialPostRef.$inferSelect;

/** Page webhook fields this spec reads. */
export const COMMENT_PAGE_FIELDS = ["feed", "mention"] as const;
/** Instagram webhook fields this spec reads (set in the Meta app dashboard, not from code). */
export const COMMENT_IG_FIELDS = ["comments", "live_comments", "mentions"] as const;

const PREVIEW_MAX = 140;
/** A suite reply and its own webhook are matched within this long (rule R9, R10). */
const ADOPT_WINDOW_MS = 15 * 60_000;
/** Comments loaded on connect that are older than this start as done (rule R21). */
const BACKFILL_OLD_MS = 48 * 3600_000;

export function networkOfAccount(account: Pick<ChannelAccount, "kind">): SocialNetwork {
  return account.kind === "instagram" ? "instagram" : "facebook";
}

// ── 1. Parsers ───────────────────────────────────────────────────────────────

export type ParsedCommentChange =
  | {
      type: "upsert";
      network: SocialNetwork;
      accountExternalId: string;
      kind: CommentKind;
      externalId: string;
      postExternalId: string;
      parentExternalId: string | null;
      authorExternalId: string | null;
      authorName: string | null;
      authorUsername: string | null;
      message: string | null;
      attachmentUrl: string | null;
      commentedAt: Date;
      edited: boolean;
      postPermalink: string | null;
      isAd: boolean;
      raw: Record<string, unknown>;
    }
  | { type: "status"; network: SocialNetwork; accountExternalId: string; externalId: string; status: "hidden" | "visible" | "deleted"; at: Date }
  | { type: "mention_ref"; network: "instagram"; accountExternalId: string; mediaExternalId: string; commentExternalId: string | null; at: Date }
  | { type: "ignored"; reason: string };

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const ignored = (reason: string): ParsedCommentChange => ({ type: "ignored", reason });

/** A time Meta sent: a number (seconds, or milliseconds above 10^12) or an ISO string. Null when unusable. */
function metaTime(v: unknown): Date | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return metaEventTime(v);
  if (typeof v === "string" && v.trim()) {
    // Meta writes "+0000"; Date wants "+00:00".
    const d = new Date(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

const UPSERT_VERBS = new Set(["add", "edited", "edit", "update"]);

/** One Page `feed` or `mention` change → zero or one parsed change. Pure. */
export function parsePageChange(pageId: string, field: string, value: Record<string, unknown>, entryTime: number): ParsedCommentChange {
  const v = obj(value);
  const at = metaTime(entryTime) ?? new Date();
  if (field !== "feed" && field !== "mention") return ignored("not a comment field");
  if (v.item !== "comment") return ignored("not a comment");
  const commentId = str(v.comment_id);
  if (!commentId) return ignored("no comment id");
  const postId = str(v.post_id);
  const verb = str(v.verb) ?? "";

  if (field === "feed") {
    if (verb === "remove" || verb === "delete") {
      return { type: "status", network: "facebook", accountExternalId: pageId, externalId: commentId, status: "deleted", at };
    }
    if (verb === "hide") return { type: "status", network: "facebook", accountExternalId: pageId, externalId: commentId, status: "hidden", at };
    if (verb === "unhide") return { type: "status", network: "facebook", accountExternalId: pageId, externalId: commentId, status: "visible", at };
    if (!UPSERT_VERBS.has(verb)) return ignored(`verb ${verb || "missing"}`);
  }
  if (!postId) return ignored("no post id");

  const from = obj(v.from);
  const post = obj(v.post);
  const parentId = str(v.parent_id);
  return {
    type: "upsert",
    network: "facebook",
    accountExternalId: pageId,
    kind: field === "mention" ? "mention" : "comment",
    externalId: commentId,
    postExternalId: postId,
    parentExternalId: !parentId || parentId === postId ? null : parentId,
    authorExternalId: str(from.id),
    authorName: str(from.name),
    authorUsername: null,
    message: str(v.message),
    attachmentUrl: str(v.photo) ?? str(v.video),
    commentedAt: metaTime(v.created_time) ?? at,
    edited: field === "feed" && verb !== "add",
    postPermalink: str(post.permalink_url) ?? str(v.permalink_url),
    isAd: false,
    raw: v,
  };
}

/** One Instagram `comments` / `live_comments` / `mentions` change. Pure. */
export function parseInstagramChange(igId: string, field: string, value: Record<string, unknown>, entryTime: number): ParsedCommentChange {
  const v = obj(value);
  const at = metaTime(entryTime) ?? new Date();
  if (field === "mentions") {
    const mediaId = str(v.media_id);
    if (!mediaId) return ignored("no media id");
    return { type: "mention_ref", network: "instagram", accountExternalId: igId, mediaExternalId: mediaId, commentExternalId: str(v.comment_id), at };
  }
  if (field !== "comments" && field !== "live_comments") return ignored("not a comment field");
  const media = obj(v.media);
  const from = obj(v.from);
  // Meta's examples show the comment's ID under `id` in one variant and `comment_id` in another.
  const commentId = str(v.id) ?? str(v.comment_id);
  const mediaId = str(media.id);
  if (!commentId) return ignored("no comment id");
  if (!mediaId) return ignored("no media id");
  return {
    type: "upsert",
    network: "instagram",
    accountExternalId: igId,
    kind: field === "live_comments" ? "live" : "comment",
    externalId: commentId,
    postExternalId: mediaId,
    parentExternalId: str(v.parent_id),
    authorExternalId: str(from.id),
    authorName: null,
    authorUsername: str(from.username),
    message: str(v.text),
    attachmentUrl: null,
    commentedAt: at,
    edited: false,
    postPermalink: null,
    isAd: Boolean(media.ad_id),
    raw: v,
  };
}

function commentFields(object: unknown): readonly string[] {
  return object === "page" ? COMMENT_PAGE_FIELDS : object === "instagram" ? COMMENT_IG_FIELDS : [];
}

/** True when a stored /v1/webhooks/meta payload has at least one change this spec handles. */
export function isCommentEvent(payload: unknown): boolean {
  const p = obj(payload) as MetaWebhookPayload;
  const fields = commentFields(p.object);
  if (fields.length === 0 || !Array.isArray(p.entry)) return false;
  return p.entry.some((e) => Array.isArray(e?.changes) && e.changes.some((c) => typeof c?.field === "string" && fields.includes(c.field)));
}

function parseChange(object: string, accountExternalId: string, field: string, value: unknown, entryTime: number): ParsedCommentChange {
  return object === "instagram"
    ? parseInstagramChange(accountExternalId, field, obj(value), entryTime)
    : parsePageChange(accountExternalId, field, obj(value), entryTime);
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type MetaProblem = "config" | "temporary" | "gone" | "refused" | "unknown";

const CONFIG_CODES = new Set(["190", "10", "200", "299", "283", "no_page_token"]);
const TEMPORARY_CODES = new Set([
  "1", "2", "4", "17", "32", "613",
  // Foundation C3 and spec 03 L2: Pages, Instagram, Messenger and other Meta rate limits.
  "80000", "80001", "80002", "80003", "80004", "80005", "80006", "80007", "80008", "80009", "80014",
]);
/** Foundation C2: these code/subcode pairs are about one person (outside the window, unavailable), not our set-up. */
const PERSON_REFUSALS = new Set(["10/2018278", "10/2534022", "10/2018108", "10/2018065", "200/1545041"]);
const GONE_TEXT = /does not exist|cannot be loaded|unsupported get request/i;

/**
 * Classify an error from a comments call (named for this API, ruling 9.2.5):
 * "unknown" = no answer came back, so it may have worked; "config" = our token
 * or permissions; "temporary" = busy or rate-limited; "gone" = the comment or
 * post no longer exists; anything else is a refusal.
 */
export function classifyMetaError(err: unknown): MetaProblem {
  if (!(err instanceof MetaApiError)) return "refused";
  if (err.delivery === "unknown") return "unknown";
  const code = err.code ?? "";
  if (err.subcode && PERSON_REFUSALS.has(`${code}/${err.subcode}`)) return "refused";
  if (CONFIG_CODES.has(code)) return "config";
  if (TEMPORARY_CODES.has(code) || err.status === 429 || err.status >= 500) return "temporary";
  if (code === "100" && GONE_TEXT.test(err.message)) return "gone";
  // Never connected: certainly not sent, worth another go later.
  if (err.status === 0 && err.retryable) return "temporary";
  return "refused";
}

/** Meta's code for the record, "code/subcode" when there is a subcode. */
export function metaErrorCode(err: unknown): string | null {
  if (!(err instanceof MetaApiError) || !err.code) return null;
  return err.subcode ? `${err.code}/${err.subcode}` : err.code;
}

/** The plain sentence staff read for a failed comments call (spec 03, table in 5.7). */
export function explainCommentError(err: unknown, network: SocialNetwork): string {
  const name = networkName(network);
  switch (classifyMetaError(err)) {
    case "config":
      return "The suite has lost its permission for this account. Ask the owner to check Channels.";
    case "temporary":
      return `${name} is busy or is limiting how often we can ask. Try again in a few minutes.`;
    case "gone":
      return `This comment no longer exists on ${name}.`;
    case "unknown":
      return `No answer from ${name}, so we can't tell if it worked.`;
    default: {
      const message = err instanceof Error && err.message ? err.message : "no reason given";
      const code = metaErrorCode(err);
      return `${name} refused this: ${message}${code ? ` (code ${code})` : ""}.`;
    }
  }
}

// ── 2. Ingestion ─────────────────────────────────────────────────────────────

export interface CommentIngestResult {
  upserts: number;
  statusChanges: number;
  ignored: number;
  unknownAccounts: string[];
}

export interface ApplyCommentOptions {
  source: "webhook" | "poll" | "backfill";
  now?: Date;
}

export interface ApplyCommentResult {
  commentId: string | null;
  created: boolean;
  /** The thread (root comment) the change belongs to, when there is one. */
  rootId: string | null;
}

async function lockComment(db: DbExecutor, network: string, externalId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`social-comment:${network}:${externalId}`}))`);
}

function previewOf(message: string | null, fromBusiness: boolean): string {
  const text = message?.trim() ? message.trim() : "Photo or video";
  return fromBusiness ? `You: ${text.slice(0, PREVIEW_MAX - 5)}` : text.slice(0, PREVIEW_MAX);
}

async function commentByExternalId(db: DbExecutor, network: string, externalId: string): Promise<SocialCommentRow | null> {
  const [row] = await db
    .select()
    .from(socialComment)
    .where(and(eq(socialComment.network, network), eq(socialComment.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

/** Find or make the post a comment belongs to. A new row has fetched_at NULL; the worker fills it. */
export async function upsertPostRef(
  db: DbExecutor,
  account: Pick<ChannelAccount, "id">,
  network: SocialNetwork,
  externalId: string,
  facts: { permalink?: string | null; isAd?: boolean } = {},
): Promise<string> {
  const [row] = await db
    .insert(socialPostRef)
    .values({ accountId: account.id, network, externalId, permalinkUrl: facts.permalink ?? null, isAd: facts.isAd ?? false })
    .onConflictDoUpdate({
      target: [socialPostRef.network, socialPostRef.externalId],
      set: {
        permalinkUrl: sql`coalesce(${socialPostRef.permalinkUrl}, excluded.permalink_url)`,
        isAd: sql`${socialPostRef.isAd} or excluded.is_ad`,
      },
    })
    .returning({ id: socialPostRef.id });
  return row!.id;
}

async function signalThread(
  db: DbExecutor,
  event: "comment.created" | "comment.updated",
  accountId: string,
  rootId: string,
  direction?: "in" | "out",
): Promise<void> {
  const [root] = await db.select({ assigneeId: socialComment.assigneeId }).from(socialComment).where(eq(socialComment.id, rootId));
  await publishInboxEvent(db, {
    event,
    id: rootId,
    phoneNumberId: accountId,
    assigneeId: root?.assigneeId ?? null,
    ...(direction ? { direction } : {}),
  });
}

/** Tell open screens a thread changed. `commentId` may be the root or any reply. */
export async function publishCommentUpdated(db: DbExecutor, comment: Pick<SocialCommentRow, "id" | "rootId" | "accountId">): Promise<void> {
  await signalThread(db, "comment.updated", comment.accountId, comment.rootId ?? comment.id, undefined);
}

/** The thread was answered from the suite: done, nothing unread, the reply as its preview. */
async function markThreadAnswered(db: DbExecutor, rootId: string, userId: string | null, message: string | null, at: Date): Promise<void> {
  await db
    .update(socialComment)
    .set({
      workState: "done",
      doneByUserId: userId,
      doneAt: at,
      unreadCount: 0,
      lastActivityAt: sql`greatest(${socialComment.lastActivityAt}, ${ts(at)})`,
      lastPreview: previewOf(message, true),
    })
    .where(eq(socialComment.id, rootId));
}

/** Apply one parsed change. Used by the webhook path, the polling job and the back-fill. Runs in the caller's transaction. */
export async function applyCommentChange(
  db: DbExecutor,
  account: ChannelAccount,
  change: ParsedCommentChange,
  opts: ApplyCommentOptions = { source: "webhook" },
): Promise<ApplyCommentResult> {
  const now = opts.now ?? new Date();
  if (change.type === "ignored") return { commentId: null, created: false, rootId: null };
  if (change.type === "status") return applyStatusChange(db, account, change);
  if (change.type === "mention_ref") return applyMentionRef(db, account, change);

  await lockComment(db, change.network, change.externalId);
  const postId = await upsertPostRef(db, account, change.network, change.postExternalId, {
    permalink: change.postPermalink,
    isAd: change.isAd,
  });
  const fromBusiness =
    !!change.authorExternalId && (change.authorExternalId === account.externalId || change.authorExternalId === account.pageId);
  const existing = await commentByExternalId(db, change.network, change.externalId);

  // Rule R9: our own reply, coming back as a webhook (or seen by a poll) before or after the send result.
  if (!existing && fromBusiness && change.message?.trim()) {
    const [queued] = await db
      .select()
      .from(socialComment)
      .where(
        and(
          eq(socialComment.postId, postId),
          isNull(socialComment.externalId),
          inArray(socialComment.sendStatus, ["queued", "unknown"]),
          sql`btrim(${socialComment.message}) = ${change.message.trim()}`,
          gt(socialComment.createdAt, new Date(now.getTime() - ADOPT_WINDOW_MS)),
        ),
      )
      .orderBy(asc(socialComment.createdAt))
      .limit(1);
    if (queued) {
      await db
        .update(socialComment)
        .set({
          externalId: change.externalId,
          sendStatus: "sent",
          errorCode: null,
          errorMessage: null,
          commentedAt: change.commentedAt,
          payload: change.raw,
        })
        .where(eq(socialComment.id, queued.id));
      const rootId = queued.rootId ?? queued.id;
      await markThreadAnswered(db, rootId, queued.sentByUserId, queued.message, now);
      await signalThread(db, "comment.updated", account.id, rootId, "out");
      return { commentId: queued.id, created: false, rootId };
    }
  }

  if (existing) {
    const rootId = existing.rootId ?? existing.id;
    // A deleted comment is never brought back.
    if (existing.status === "deleted") return { commentId: existing.id, created: false, rootId };
    const textChanged = change.message !== null && change.message !== existing.message;
    await db
      .update(socialComment)
      .set({
        message: change.message ?? existing.message,
        attachmentUrl: change.attachmentUrl ?? existing.attachmentUrl,
        authorName: change.authorName ?? existing.authorName,
        authorUsername: change.authorUsername ?? existing.authorUsername,
        authorExternalId: change.authorExternalId ?? existing.authorExternalId,
        fromBusiness: existing.fromBusiness || fromBusiness,
        needsFetch: false,
        // A placeholder (made for a reply that arrived first) gets its real time now.
        ...(existing.needsFetch ? { commentedAt: change.commentedAt } : {}),
        ...(change.edited ? { editedAt: now } : {}),
        ...(opts.source === "webhook" || !existing.payload ? { payload: change.raw } : {}),
      })
      .where(eq(socialComment.id, existing.id));
    // Rule R12: an edit by the customer moves the thread up; it does not reopen it or count as unread.
    if (change.edited && textChanged && !existing.fromBusiness && !fromBusiness) {
      await db
        .update(socialComment)
        .set({ lastActivityAt: now, lastPreview: previewOf(change.message, false) })
        .where(eq(socialComment.id, rootId));
    }
    await signalThread(db, "comment.updated", account.id, rootId, fromBusiness ? "out" : "in");
    return { commentId: existing.id, created: false, rootId };
  }

  // Which thread? A top-level comment is its own root; a reply joins its parent's.
  let rootId: string | null = null;
  if (change.parentExternalId) {
    await lockComment(db, change.network, change.parentExternalId);
    const parent = await commentByExternalId(db, change.network, change.parentExternalId);
    if (parent) {
      rootId = parent.rootId ?? parent.id;
    } else {
      // Rule R11: the reply arrived before its parent. Hold its place; the worker fetches the rest.
      const [placeholder] = await db
        .insert(socialComment)
        .values({
          postId,
          accountId: account.id,
          network: change.network,
          externalId: change.parentExternalId,
          kind: change.kind,
          message: null,
          needsFetch: true,
          workState: "open",
          commentedAt: change.commentedAt,
          lastActivityAt: change.commentedAt,
        })
        .returning({ id: socialComment.id });
      rootId = placeholder!.id;
    }
  }

  const [row] = await db
    .insert(socialComment)
    .values({
      postId,
      accountId: account.id,
      network: change.network,
      externalId: change.externalId,
      parentExternalId: change.parentExternalId,
      rootId,
      kind: change.kind,
      authorExternalId: change.authorExternalId,
      authorName: change.authorName,
      authorUsername: change.authorUsername,
      fromBusiness,
      message: change.message,
      attachmentUrl: change.attachmentUrl,
      editedAt: change.edited ? now : null,
      commentedAt: change.commentedAt,
      lastActivityAt: change.commentedAt,
      payload: change.raw,
    })
    .returning({ id: socialComment.id });
  const commentId = row!.id;
  const isRoot = rootId === null;
  const threadId = rootId ?? commentId;

  // Thread state lives on the root row (spec 03, 5.3 step 7).
  const preview = previewOf(change.message, fromBusiness);
  const at = ts(change.commentedAt);
  const moveUp = {
    lastActivityAt: sql`greatest(${socialComment.lastActivityAt}, ${at})`,
    lastPreview: sql`case when ${at} >= ${socialComment.lastActivityAt} then ${preview} else ${socialComment.lastPreview} end`,
  };
  const old = opts.source === "backfill" && now.getTime() - change.commentedAt.getTime() > BACKFILL_OLD_MS;
  let state: PgUpdateSetSource<typeof socialComment>;
  if (change.kind === "live" || fromBusiness) {
    // Live-video comments start as done (R16). The business's own comment never raises unread or reopens (R4).
    state = { ...moveUp, ...(isRoot ? { workState: "done" } : {}) };
  } else if (old) {
    // Rule R21: loaded on connect and more than 48 hours old: no unread; a thread of its own starts as done.
    state = { ...moveUp, ...(isRoot ? { workState: "done" } : {}) };
  } else {
    state = {
      ...moveUp,
      workState: "open",
      doneAt: null,
      doneByUserId: null,
      unreadCount: sql`${socialComment.unreadCount} + 1`,
    };
  }
  await db.update(socialComment).set(state).where(eq(socialComment.id, threadId));
  await signalThread(db, "comment.created", account.id, threadId, fromBusiness ? "out" : "in");
  return { commentId, created: true, rootId: threadId };
}

async function applyStatusChange(
  db: DbExecutor,
  account: ChannelAccount,
  change: Extract<ParsedCommentChange, { type: "status" }>,
): Promise<ApplyCommentResult> {
  await lockComment(db, change.network, change.externalId);
  const row = await commentByExternalId(db, change.network, change.externalId);
  if (!row) return { commentId: null, created: false, rootId: null };
  const rootId = row.rootId ?? row.id;
  // Never change a row that is already deleted.
  if (row.status === "deleted") return { commentId: row.id, created: false, rootId };
  if (change.status === "deleted") {
    await db
      .update(socialComment)
      .set({
        status: "deleted",
        statusChangedAt: change.at,
        needsFetch: false,
        ...(row.rootId === null ? { workState: "done", unreadCount: 0 } : {}),
      })
      .where(eq(socialComment.id, row.id));
  } else if (change.status === "hidden") {
    const bySuite = row.status === "hidden" && row.hiddenSource === "suite";
    if (row.status !== "hidden") {
      await db
        .update(socialComment)
        .set({ status: "hidden", hiddenSource: "outside", statusChangedAt: change.at })
        .where(eq(socialComment.id, row.id));
    } else if (!bySuite && row.hiddenSource !== "outside") {
      await db.update(socialComment).set({ hiddenSource: "outside" }).where(eq(socialComment.id, row.id));
    }
  } else if (row.status !== "visible") {
    await db
      .update(socialComment)
      .set({ status: "visible", hiddenSource: null, statusChangedAt: change.at })
      .where(eq(socialComment.id, row.id));
  }
  await signalThread(db, "comment.updated", account.id, rootId);
  return { commentId: row.id, created: false, rootId };
}

async function applyMentionRef(
  db: DbExecutor,
  account: ChannelAccount,
  change: Extract<ParsedCommentChange, { type: "mention_ref" }>,
): Promise<ApplyCommentResult> {
  // A mention in a caption has no comment to show: not handled in Phase A.
  if (!change.commentExternalId) return { commentId: null, created: false, rootId: null };
  await lockComment(db, change.network, change.commentExternalId);
  const existing = await commentByExternalId(db, change.network, change.commentExternalId);
  if (existing) return { commentId: existing.id, created: false, rootId: existing.rootId ?? existing.id };
  const postId = await upsertPostRef(db, account, change.network, change.mediaExternalId);
  const [row] = await db
    .insert(socialComment)
    .values({
      postId,
      accountId: account.id,
      network: change.network,
      externalId: change.commentExternalId,
      kind: "mention",
      needsFetch: true,
      workState: "open",
      unreadCount: 1,
      lastPreview: "Mentioned you in a comment",
      commentedAt: change.at,
      lastActivityAt: change.at,
    })
    .returning({ id: socialComment.id });
  await signalThread(db, "comment.created", account.id, row!.id, "in");
  return { commentId: row!.id, created: true, rootId: row!.id };
}

function countInto(result: CommentIngestResult, change: ParsedCommentChange, applied: ApplyCommentResult): boolean {
  if (change.type === "ignored" || applied.commentId === null) {
    result.ignored++;
    return false;
  }
  if (change.type === "status") result.statusChanges++;
  else result.upserts++;
  return true;
}

/**
 * Walk every entry and change of a stored Meta webhook payload. Runs inside the
 * caller's transaction. Safe to run twice. The live webhook does not call this:
 * it goes through ingestMetaEntry, which hands each change to the handlers
 * registered below (one dispatch point, ruling 9.2.3); both end in applyCommentChange.
 */
export async function ingestCommentChanges(db: DbExecutor, payload: unknown): Promise<CommentIngestResult> {
  const result: CommentIngestResult = { upserts: 0, statusChanges: 0, ignored: 0, unknownAccounts: [] };
  const p = obj(payload) as MetaWebhookPayload;
  const object = p.object;
  if (object !== "page" && object !== "instagram") return result;
  const fields = commentFields(object);
  for (const entry of (Array.isArray(p.entry) ? p.entry : []) as MetaEntry[]) {
    const changes = (entry?.changes ?? []).filter((c) => typeof c?.field === "string" && fields.includes(c.field));
    if (changes.length === 0) continue; // messaging entries are spec 02's
    const entryId = entry.id ? String(entry.id) : "";
    const account = entryId ? await channelAccountByExternalId(db, object === "instagram" ? "instagram" : "messenger", entryId) : null;
    if (!account || !account.isActive) {
      result.unknownAccounts.push(entryId);
      continue;
    }
    for (const c of changes) {
      const change = parseChange(object, account.externalId ?? entryId, c.field!, c.value, entry.time ?? 0);
      countInto(result, change, await applyCommentChange(db, account, change, { source: "webhook" }));
    }
  }
  return result;
}

/** The handler ingestMetaEntry calls for each comment change of an entry. True when the change was applied. */
const handleCommentChange: MetaChangeHandler = async (ctx, change) => {
  const parsed = parseChange(ctx.object, ctx.account.externalId, change.field, change.value, ctx.entry.time ?? 0);
  if (parsed.type === "ignored") return false;
  const applied = await applyCommentChange(ctx.db, ctx.account, parsed, { source: "webhook", now: ctx.now });
  return applied.commentId !== null;
};

/** Register this spec's handlers at the shared webhook's one dispatch point. Safe to call twice. */
export function registerCommentChangeHandlers(): void {
  for (const f of COMMENT_PAGE_FIELDS) META_CHANGE_HANDLERS[`page.${f}`] = handleCommentChange;
  for (const f of COMMENT_IG_FIELDS) META_CHANGE_HANDLERS[`instagram.${f}`] = handleCommentChange;
}
registerCommentChangeHandlers();

// ── 3. Graph calls ───────────────────────────────────────────────────────────

export interface RemoteComment {
  externalId: string;
  parentExternalId: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  authorUsername: string | null;
  message: string | null;
  commentedAt: Date;
  hidden: boolean | null;
  likeCount: number | null;
  likedByBusiness: boolean | null;
  attachmentUrl: string | null;
}

export interface RemotePost {
  externalId: string;
  message: string | null;
  permalinkUrl: string | null;
  pictureUrl: string | null;
  mediaType: string | null;
  postedAt: Date | null;
  commentCount: number | null;
  updatedAt: Date | null;
}

function pageCall<T>(cfg: MetaConfig, account: ChannelAccount, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  if (!account.pageId) throw new MetaApiError("This account is not linked to a Facebook Page", 400, "no_page_token", false);
  return withPageTokenRetry(cfg, account.pageId, (token) => graph<T>(cfg, method, path, body, { token }));
}

const id = (v: string): string => encodeURIComponent(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

const FB_COMMENT_FIELDS = "id,message,created_time,from,parent,is_hidden,like_count,user_likes,attachment";
const FB_REPLY_FIELDS = "id,message,created_time,from,parent,is_hidden,like_count,user_likes";
const IG_COMMENT_FIELDS = "id,text,timestamp,username,from,hidden,like_count,parent_id";

/** Every field is optional (spec 03, F11): a comment with no usable ID is dropped. */
function fbComment(raw: unknown): RemoteComment | null {
  const c = obj(raw);
  const externalId = str(c.id);
  if (!externalId) return null;
  const from = obj(c.from);
  const attachment = obj(c.attachment);
  const image = obj(obj(attachment.media).image);
  return {
    externalId,
    parentExternalId: str(obj(c.parent).id),
    authorExternalId: str(from.id),
    authorName: str(from.name),
    authorUsername: null,
    message: str(c.message),
    commentedAt: metaTime(c.created_time) ?? new Date(),
    hidden: bool(c.is_hidden),
    likeCount: num(c.like_count),
    likedByBusiness: bool(c.user_likes),
    attachmentUrl: str(image.src) ?? str(attachment.url),
  };
}

function igComment(raw: unknown, parentFallback: string | null = null): RemoteComment | null {
  const c = obj(raw);
  const externalId = str(c.id);
  if (!externalId) return null;
  const from = obj(c.from);
  return {
    externalId,
    parentExternalId: str(c.parent_id) ?? parentFallback,
    authorExternalId: str(from.id),
    authorName: null,
    authorUsername: str(from.username) ?? str(c.username),
    message: str(c.text),
    commentedAt: metaTime(c.timestamp) ?? new Date(),
    hidden: bool(c.hidden),
    likeCount: num(c.like_count),
    likedByBusiness: null,
    attachmentUrl: null,
  };
}

function list(v: unknown): unknown[] {
  const data = obj(v).data;
  return Array.isArray(data) ? data : [];
}

/** The cursor for the next page, when Meta says there is one. Meta's own `next` link is never followed (it carries a token). */
function nextCursor(v: unknown): string | null {
  const paging = obj(obj(v).paging);
  if (!str(paging.next)) return null;
  return str(obj(paging.cursors).after);
}

function fbPost(raw: unknown): RemotePost | null {
  const p = obj(raw);
  const externalId = str(p.id);
  if (!externalId) return null;
  return {
    externalId,
    message: str(p.message) ?? str(p.story),
    permalinkUrl: str(p.permalink_url),
    pictureUrl: str(p.full_picture),
    mediaType: str(p.status_type),
    postedAt: metaTime(p.created_time),
    commentCount: null,
    updatedAt: metaTime(p.updated_time),
  };
}

function igPost(raw: unknown): RemotePost | null {
  const p = obj(raw);
  const externalId = str(p.id);
  if (!externalId) return null;
  const mediaType = str(p.media_type);
  return {
    externalId,
    message: str(p.caption),
    permalinkUrl: str(p.permalink),
    // media_url can be missing (copyright audio): fall back to the thumbnail, then to no picture.
    pictureUrl: mediaType === "VIDEO" ? str(p.thumbnail_url) : (str(p.media_url) ?? str(p.thumbnail_url)),
    mediaType: str(p.media_product_type) ?? mediaType,
    postedAt: metaTime(p.timestamp),
    commentCount: num(p.comments_count),
    updatedAt: null,
  };
}

export async function fetchPost(cfg: MetaConfig, account: ChannelAccount, postExternalId: string): Promise<RemotePost> {
  const ig = account.kind === "instagram";
  const fields = ig
    ? "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count"
    : "id,message,story,created_time,updated_time,permalink_url,full_picture,status_type";
  const raw = await pageCall<unknown>(cfg, account, "GET", `${id(postExternalId)}?fields=${fields}`);
  const post = ig ? igPost(raw) : fbPost(raw);
  if (!post) throw new MetaApiError("Meta returned no post", 502, null, false);
  return post;
}

export async function listRecentPosts(cfg: MetaConfig, account: ChannelAccount, opts: { since: Date; limit: number }): Promise<RemotePost[]> {
  const ig = account.kind === "instagram";
  const since = Math.floor(opts.since.getTime() / 1000);
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit)));
  const path = ig
    ? `${id(account.externalId ?? "")}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count&limit=${limit}&since=${since}`
    : `${id(account.pageId ?? "")}/feed?fields=id,message,created_time,updated_time,permalink_url,full_picture&limit=${limit}&since=${since}`;
  const raw = await pageCall<unknown>(cfg, account, "GET", path);
  return list(raw)
    .map((p) => (ig ? igPost(p) : fbPost(p)))
    .filter((p): p is RemotePost => p !== null);
}

/** Comments on a post, newest first, top-level and replies together, at most `maxPages` requests. */
export async function listPostComments(
  cfg: MetaConfig,
  account: ChannelAccount,
  postExternalId: string,
  opts: { maxPages: number },
): Promise<RemoteComment[]> {
  const ig = account.kind === "instagram";
  const base = ig
    ? `${id(postExternalId)}/comments?limit=50&fields=${IG_COMMENT_FIELDS},replies{${IG_COMMENT_FIELDS}}`
    : `${id(postExternalId)}/comments?filter=stream&order=reverse_chronological&limit=100&fields=${FB_COMMENT_FIELDS}`;
  const out: RemoteComment[] = [];
  let after: string | null = null;
  for (let page = 0; page < Math.max(1, opts.maxPages); page++) {
    const raw: unknown = await pageCall<unknown>(cfg, account, "GET", after ? `${base}&after=${encodeURIComponent(after)}` : base);
    for (const item of list(raw)) {
      const c = ig ? igComment(item) : fbComment(item);
      if (!c) continue;
      out.push(c);
      if (ig) {
        for (const r of list(obj(item).replies)) {
          const reply = igComment(r, c.externalId);
          if (reply) out.push(reply);
        }
      }
    }
    after = nextCursor(raw);
    if (!after) break;
  }
  return out;
}

export type RemoteThread = RemoteComment & {
  replies: RemoteComment[];
  /** False when Meta said there are more replies than it returned. */
  repliesComplete: boolean;
  /** Only for an Instagram mention: the media it was written on. */
  postExternalId?: string | null;
};

export async function fetchComment(
  cfg: MetaConfig,
  account: ChannelAccount,
  commentExternalId: string,
  kind: "comment" | "mention",
): Promise<RemoteThread> {
  const gone = () => new MetaApiError("Unsupported get request. This comment does not exist", 404, "100", false);
  if (account.kind === "instagram") {
    if (kind === "mention") {
      const raw = await pageCall<unknown>(
        cfg,
        account,
        "GET",
        `${id(account.externalId ?? "")}?fields=mentioned_comment.comment_id(${id(commentExternalId)}){id,text,timestamp,like_count,media{id,permalink}}`,
      );
      const mentioned = obj(obj(raw).mentioned_comment);
      const c = igComment(mentioned);
      if (!c) throw gone();
      return { ...c, replies: [], repliesComplete: true, postExternalId: str(obj(mentioned.media).id) };
    }
    const raw = await pageCall<unknown>(cfg, account, "GET", `${id(commentExternalId)}?fields=${IG_COMMENT_FIELDS},replies{${IG_COMMENT_FIELDS}}`);
    const c = igComment(raw);
    if (!c) throw gone();
    const replies = list(obj(raw).replies)
      .map((r) => igComment(r, c.externalId))
      .filter((r): r is RemoteComment => r !== null);
    return { ...c, replies, repliesComplete: !str(obj(obj(obj(raw).replies).paging).next) };
  }
  const raw = await pageCall<unknown>(
    cfg,
    account,
    "GET",
    `${id(commentExternalId)}?fields=${FB_COMMENT_FIELDS},comments.limit(100){${FB_REPLY_FIELDS}}`,
  );
  const c = fbComment(raw);
  if (!c) throw gone();
  const replies = list(obj(raw).comments)
    .map((r) => fbComment(r))
    .filter((r): r is RemoteComment => r !== null)
    .map((r) => ({ ...r, parentExternalId: r.parentExternalId ?? c.externalId }));
  return { ...c, replies, repliesComplete: !str(obj(obj(obj(raw).comments).paging).next) };
}

/** Post a public reply. Returns Meta's ID for the new comment. */
export async function publishReply(cfg: MetaConfig, account: ChannelAccount, toCommentExternalId: string, message: string): Promise<string> {
  const edge = account.kind === "instagram" ? "replies" : "comments";
  const res = await pageCall<{ id?: string }>(cfg, account, "POST", `${id(toCommentExternalId)}/${edge}`, { message });
  const newId = str(res?.id);
  // Meta said yes but gave no ID: we cannot tell which comment it is, so it is "not confirmed", never re-sent.
  if (!newId) throw new MetaApiError("Meta returned no comment id", 502, null, false, "unknown");
  return newId;
}

function confirm(res: { success?: boolean } | null | undefined): void {
  if (res && res.success === false) throw new MetaApiError("Meta did not confirm the change", 502, null, false);
}

export async function setCommentHidden(cfg: MetaConfig, account: ChannelAccount, commentExternalId: string, hidden: boolean): Promise<void> {
  if (account.kind === "instagram") {
    confirm(await pageCall<{ success?: boolean }>(cfg, account, "POST", `${id(commentExternalId)}?hide=${hidden ? "true" : "false"}`));
    return;
  }
  confirm(await pageCall<{ success?: boolean }>(cfg, account, "POST", id(commentExternalId), { is_hidden: hidden }));
}

export async function deleteRemoteComment(cfg: MetaConfig, account: ChannelAccount, commentExternalId: string): Promise<void> {
  confirm(await pageCall<{ success?: boolean }>(cfg, account, "DELETE", id(commentExternalId)));
}

/** Facebook only: Instagram has no endpoint to like a comment. */
export async function setCommentLiked(cfg: MetaConfig, account: ChannelAccount, commentExternalId: string, liked: boolean): Promise<void> {
  if (account.kind === "instagram") throw new Error("not supported");
  confirm(await pageCall<{ success?: boolean }>(cfg, account, liked ? "POST" : "DELETE", `${id(commentExternalId)}/likes`));
}

/** One private message about a comment. `recipientId` is the person's Page- or Instagram-scoped ID when Meta returns it. */
export async function sendPrivateReply(
  cfg: MetaConfig,
  account: ChannelAccount,
  commentExternalId: string,
  text: string,
): Promise<{ recipientId: string | null; messageId: string | null }> {
  const node = account.kind === "instagram" ? account.externalId : account.pageId;
  const res = await pageCall<{ recipient_id?: string; message_id?: string }>(cfg, account, "POST", `${id(node ?? "")}/messages`, {
    recipient: { comment_id: commentExternalId },
    message: { text },
  });
  return { recipientId: str(res?.recipient_id), messageId: str(res?.message_id) };
}

/**
 * Make sure the Page sends us `feed` and `mention`. Reads what our app is
 * subscribed to and adds the two fields to that list: never a shorter list than
 * the one read, so the messaging fields spec 02 subscribed stay. Instagram
 * fields are set in the Meta app dashboard, so an Instagram account needs no call.
 */
export async function ensurePageSubscribed(cfg: MetaConfig, account: ChannelAccount): Promise<{ changed: boolean }> {
  if (account.kind !== "messenger" || !account.pageId) return { changed: false };
  const page = id(account.pageId);
  const raw = await pageCall<unknown>(cfg, account, "GET", `${page}/subscribed_apps`);
  const apps = list(raw).map((a) => obj(a));
  const fieldsOf = (a: Record<string, unknown>): string[] =>
    (Array.isArray(a.subscribed_fields) ? a.subscribed_fields : [])
      .map((f) => (typeof f === "string" ? f : str(obj(f).name)))
      .filter((f): f is string => !!f);
  const ours = cfg.appId ? apps.find((a) => str(a.id) === cfg.appId) : (apps.find((a) => fieldsOf(a).includes("messages")) ?? apps[0]);
  const existing = ours ? fieldsOf(ours) : [];
  if (COMMENT_PAGE_FIELDS.every((f) => existing.includes(f))) return { changed: false };
  const post = (fields: string[]) =>
    pageCall<{ success?: boolean }>(cfg, account, "POST", `${page}/subscribed_apps?subscribed_fields=${[...new Set(fields)].join(",")}`);
  try {
    confirm(await post([...existing, ...COMMENT_PAGE_FIELDS]));
  } catch (err) {
    // `mention` is the less important of the two: if Meta refuses the pair, keep comments working with `feed` alone.
    if (classifyMetaError(err) !== "refused" || existing.includes("feed")) throw err;
    confirm(await post([...existing, "feed"]));
  }
  return { changed: true };
}

// ── Owner alert ──────────────────────────────────────────────────────────────

/** Remember a problem for the banner on the Comments page (and for support). */
export async function recordCommentsProblem(db: DbExecutor, accountId: string, err: { code: string | null; message: string }): Promise<void> {
  const now = new Date();
  await db
    .insert(socialCommentAccount)
    .values({ accountId, lastErrorCode: err.code, lastError: err.message, lastErrorAt: now })
    .onConflictDoUpdate({
      target: socialCommentAccount.accountId,
      set: { lastErrorCode: err.code, lastError: err.message, lastErrorAt: now },
    });
}

/** One alert per account per 24 hours, through outbox_event, like alertUnknownNumbers. */
export async function raiseCommentsConfigAlert(db: DbExecutor, account: ChannelAccount, err: { code: string | null; message: string }): Promise<void> {
  await recordCommentsProblem(db, account.id, err);
  const [recent] = await db
    .select({ id: outboxEvent.id })
    .from(outboxEvent)
    .where(
      and(
        eq(outboxEvent.eventType, "social.comments_config"),
        gt(outboxEvent.createdAt, new Date(Date.now() - 24 * 3600_000)),
        sql`${outboxEvent.payload}->>'account_id' = ${account.id}`,
      ),
    )
    .limit(1);
  if (recent) return;
  await db.insert(outboxEvent).values({
    eventType: "social.comments_config",
    // `account` as well, so it dedupes like the alerts raised through alertOnce.
    payload: { account: account.id, account_id: account.id, label: account.label, code: err.code, message: err.message },
  });
}

// ── 4. Actions ───────────────────────────────────────────────────────────────

export class CommentActionError extends Error {
  constructor(
    public readonly code: "not_found" | "not_allowed" | "already_sent" | "too_old" | "not_configured",
    message: string,
  ) {
    super(message);
    this.name = "CommentActionError";
  }
}

const NOT_CONFIGURED = "Facebook and Instagram are not set up on this server";
const WAIT_FOR_POST = "Wait until this reply has been posted";
const ACCOUNT_OFF = "This account is switched off in Channels.";

async function loadTarget(db: DbExecutor, commentId: string): Promise<{ comment: SocialCommentRow; account: ChannelAccount; network: SocialNetwork }> {
  const [row] = await db
    .select({
      comment: socialComment,
      accountId: inboxPhoneNumber.id,
      kind: inboxPhoneNumber.kind,
      label: inboxPhoneNumber.label,
      externalId: inboxPhoneNumber.externalId,
      pageId: inboxPhoneNumber.pageExternalId,
      isActive: inboxPhoneNumber.isActive,
    })
    .from(socialComment)
    .innerJoin(inboxPhoneNumber, eq(inboxPhoneNumber.id, socialComment.accountId))
    .where(eq(socialComment.id, commentId));
  if (!row) throw new CommentActionError("not_found", "comment not found");
  // Rule R25: stored comments stay readable, but nothing can be done on a switched-off account.
  if (!row.isActive) throw new CommentActionError("not_allowed", ACCOUNT_OFF);
  const account: ChannelAccount = {
    id: row.accountId,
    kind: row.kind as ChannelAccount["kind"],
    label: row.label,
    externalId: row.externalId,
    pageId: row.pageId,
    isActive: row.isActive,
  };
  return { comment: row.comment, account, network: row.comment.network as SocialNetwork };
}

async function reload(db: DbExecutor, commentId: string): Promise<SocialCommentRow> {
  const [row] = await db.select().from(socialComment).where(eq(socialComment.id, commentId));
  if (!row) throw new CommentActionError("not_found", "comment not found");
  return row;
}

/** Rule R14: Meta says the comment is gone. Show it as deleted. */
async function markGone(db: DbExecutor, comment: SocialCommentRow): Promise<void> {
  await db
    .update(socialComment)
    .set({
      status: "deleted",
      statusChangedAt: new Date(),
      needsFetch: false,
      ...(comment.rootId === null ? { workState: "done", unreadCount: 0 } : {}),
    })
    .where(and(eq(socialComment.id, comment.id), sql`${socialComment.status} <> 'deleted'`));
  await publishCommentUpdated(db, comment);
}

/**
 * Post a public reply (foundation rule 9): the reply is saved as "queued"
 * first, Meta is called once, and the result is recorded. A timeout leaves it
 * "unknown"; nothing ever sends it again. The returned row's send_status says
 * what happened ("sent", "failed" or "unknown").
 */
export async function replyToComment(
  db: DbClient,
  cfg: MetaConfig | null,
  input: { commentId: string; userId: string; message: string },
): Promise<SocialCommentRow> {
  if (!cfg) throw new CommentActionError("not_configured", NOT_CONFIGURED);
  const { comment: target, account, network } = await loadTarget(db, input.commentId);
  if (target.status === "deleted") throw new CommentActionError("not_allowed", "This comment was deleted, so it can't be answered.");
  if (target.status === "hidden") throw new CommentActionError("not_allowed", "Show this comment again before answering it.");
  if (target.kind === "live") {
    throw new CommentActionError("not_allowed", "Comments on a live video can't be answered publicly. Send a private message instead.");
  }
  if (target.kind !== "comment") throw new CommentActionError("not_allowed", "A mention can't be answered from here.");
  if (!target.externalId) throw new CommentActionError("not_allowed", WAIT_FOR_POST);
  const message = input.message.trim();
  if (!message) throw new CommentActionError("not_allowed", "Write a reply first.");
  const rootId = target.rootId ?? target.id;
  const now = new Date();

  // The same words to the same comment, still on their way: a double press, not a second reply.
  const [twin] = await db
    .select({ id: socialComment.id })
    .from(socialComment)
    .where(
      and(
        eq(socialComment.rootId, rootId),
        eq(socialComment.parentExternalId, target.externalId),
        eq(socialComment.sendStatus, "queued"),
        eq(socialComment.message, message),
        gt(socialComment.createdAt, new Date(now.getTime() - 2 * 60_000)),
      ),
    )
    .limit(1);
  if (twin) throw new CommentActionError("not_allowed", "This reply is already being posted.");

  const [ours] = await db
    .insert(socialComment)
    .values({
      postId: target.postId,
      accountId: target.accountId,
      network,
      externalId: null,
      parentExternalId: target.externalId,
      rootId,
      kind: "comment",
      authorExternalId: account.externalId,
      authorName: account.label,
      fromBusiness: true,
      sentByUserId: input.userId,
      message,
      sendStatus: "queued",
      commentedAt: now,
      lastActivityAt: now,
    })
    .returning();
  const oursId = ours!.id;

  let newId: string;
  try {
    newId = await publishReply(cfg, account, target.externalId, message);
  } catch (err) {
    if (!(err instanceof MetaApiError)) {
      await db
        .update(socialComment)
        .set({ sendStatus: "unknown", errorMessage: "The reply was interrupted before we heard back." })
        .where(and(eq(socialComment.id, oursId), eq(socialComment.sendStatus, "queued")));
      throw err;
    }
    const problem = classifyMetaError(err);
    const errorCode = metaErrorCode(err);
    await db.transaction(async (tx) => {
      // The webhook may already have confirmed it (adopted this row): then it went, whatever this error says.
      await tx
        .update(socialComment)
        .set({ sendStatus: problem === "unknown" ? "unknown" : "failed", errorCode, errorMessage: explainCommentError(err, network) })
        .where(and(eq(socialComment.id, oursId), eq(socialComment.sendStatus, "queued")));
      if (problem === "gone") await markGone(tx, target);
      if (problem === "config") await raiseCommentsConfigAlert(tx, account, { code: errorCode, message: err.message });
      await signalThread(tx, "comment.updated", account.id, rootId, "out");
    });
    return reload(db, oursId);
  }

  await db.transaction(async (tx) => {
    await lockComment(tx, network, newId);
    // A webhook copy that won the race (it could not be matched to our row): ours is the one that stays.
    await tx
      .delete(socialComment)
      .where(
        and(
          eq(socialComment.network, network),
          eq(socialComment.externalId, newId),
          sql`${socialComment.id} <> ${oursId}`,
          isNull(socialComment.sentByUserId),
        ),
      );
    await tx
      .update(socialComment)
      .set({ externalId: newId, sendStatus: "sent", errorCode: null, errorMessage: null })
      .where(eq(socialComment.id, oursId));
    await markThreadAnswered(tx, rootId, input.userId, message, new Date());
    await signalThread(tx, "comment.updated", account.id, rootId, "out");
  });
  return reload(db, oursId);
}

/** What hide, show, delete and like check before calling Meta (rules R6 to R8, R16, R17). */
function checkModerationTarget(target: SocialCommentRow): string {
  if (!target.externalId) throw new CommentActionError("not_allowed", WAIT_FOR_POST);
  if (target.kind !== "comment") {
    throw new CommentActionError(
      "not_allowed",
      target.kind === "live" ? "Comments on a live video can't be changed from here." : "A mention can't be changed from here.",
    );
  }
  return target.externalId;
}

/** Run a harmless-twice Meta call; when Meta says the comment is gone, mark it deleted and rethrow. */
async function callForComment(db: DbClient, account: ChannelAccount, target: SocialCommentRow, call: () => Promise<void>): Promise<void> {
  try {
    await call();
  } catch (err) {
    const problem = classifyMetaError(err);
    if (problem === "gone") await markGone(db, target);
    if (problem === "config" && err instanceof MetaApiError) {
      await raiseCommentsConfigAlert(db, account, { code: metaErrorCode(err), message: err.message });
    }
    throw err;
  }
}

/** Hide a comment, or show it again. Nothing changes locally unless Meta said yes. */
export async function hideComment(
  db: DbClient,
  cfg: MetaConfig | null,
  input: { commentId: string; userId: string; hidden: boolean },
): Promise<SocialCommentRow> {
  if (!cfg) throw new CommentActionError("not_configured", NOT_CONFIGURED);
  const { comment: target, account } = await loadTarget(db, input.commentId);
  const externalId = checkModerationTarget(target);
  if (target.status === "deleted") throw new CommentActionError("not_allowed", "This comment was deleted.");
  if (input.hidden && target.fromBusiness) throw new CommentActionError("not_allowed", "Your own comments can't be hidden.");
  await callForComment(db, account, target, () => setCommentHidden(cfg, account, externalId, input.hidden));
  await db.transaction(async (tx) => {
    await tx
      .update(socialComment)
      .set({ status: input.hidden ? "hidden" : "visible", hiddenSource: input.hidden ? "suite" : null, statusChangedAt: new Date() })
      .where(and(eq(socialComment.id, target.id), sql`${socialComment.status} <> 'deleted'`));
    await publishCommentUpdated(tx, target);
  });
  return reload(db, target.id);
}

/** Delete a comment at Meta. "Already gone" counts as done. */
export async function deleteComment(db: DbClient, cfg: MetaConfig | null, input: { commentId: string; userId: string }): Promise<SocialCommentRow> {
  if (!cfg) throw new CommentActionError("not_configured", NOT_CONFIGURED);
  const { comment: target, account } = await loadTarget(db, input.commentId);
  const externalId = checkModerationTarget(target);
  if (target.status === "deleted") return target;
  try {
    await deleteRemoteComment(cfg, account, externalId);
  } catch (err) {
    const problem = classifyMetaError(err);
    if (problem === "config" && err instanceof MetaApiError) {
      await raiseCommentsConfigAlert(db, account, { code: metaErrorCode(err), message: err.message });
    }
    if (problem !== "gone") throw err;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(socialComment)
      .set({
        status: "deleted",
        statusChangedAt: new Date(),
        ...(target.rootId === null ? { workState: "done", unreadCount: 0 } : {}),
      })
      .where(eq(socialComment.id, target.id));
    await publishCommentUpdated(tx, target);
  });
  return reload(db, target.id);
}

/** Like or unlike a customer's comment as the Page (Facebook only). */
export async function likeComment(
  db: DbClient,
  cfg: MetaConfig | null,
  input: { commentId: string; userId: string; liked: boolean },
): Promise<SocialCommentRow> {
  if (!cfg) throw new CommentActionError("not_configured", NOT_CONFIGURED);
  const { comment: target, account, network } = await loadTarget(db, input.commentId);
  if (network === "instagram") throw new CommentActionError("not_allowed", "Likes can't be given from here on Instagram");
  const externalId = checkModerationTarget(target);
  if (target.status !== "visible" || target.fromBusiness) {
    throw new CommentActionError("not_allowed", "Only a customer's comment that everyone can see can be liked.");
  }
  await callForComment(db, account, target, () => setCommentLiked(cfg, account, externalId, input.liked));
  await db.transaction(async (tx) => {
    await tx.update(socialComment).set({ likedByBusiness: input.liked }).where(eq(socialComment.id, target.id));
    await publishCommentUpdated(tx, target);
  });
  return reload(db, target.id);
}

/**
 * Send the one private message Meta allows about a comment. It opens (or
 * continues) an inbox conversation through spec 02's code and writes one
 * outbound message there. It does NOT open the 24-hour reply window: that
 * opens only when the customer answers. The returned row's
 * private_reply_status says what happened.
 */
export async function privateReplyToComment(
  db: DbClient,
  cfg: MetaConfig | null,
  input: { commentId: string; userId: string; text: string },
): Promise<SocialCommentRow> {
  if (!cfg) throw new CommentActionError("not_configured", NOT_CONFIGURED);
  const { comment: target, account, network } = await loadTarget(db, input.commentId);
  const text = input.text.trim();
  if (!text) throw new CommentActionError("not_allowed", "Write a message first.");
  if (target.fromBusiness) throw new CommentActionError("not_allowed", "A private message can only be sent about a customer's comment.");
  if (!target.externalId) throw new CommentActionError("not_allowed", WAIT_FOR_POST);
  if (target.status === "deleted") throw new CommentActionError("not_allowed", "This comment was deleted, so a private message can't be sent about it.");
  if (target.status === "hidden") throw new CommentActionError("not_allowed", "Show this comment again before sending a private message about it.");
  if (target.kind !== "comment" && target.kind !== "live") {
    throw new CommentActionError("not_allowed", "A private message can't be sent about a mention.");
  }
  if (target.privateReplyStatus === "sent" || target.privateReplyStatus === "queued") {
    throw new CommentActionError("already_sent", "A private message was already sent for this comment");
  }
  const facts = {
    kind: target.kind as CommentKind,
    status: "visible" as const,
    fromBusiness: false,
    externalId: target.externalId,
    likedByBusiness: target.likedByBusiness,
    commentedAt: target.commentedAt,
    privateReplyStatus: target.privateReplyStatus as CommentSendStatus | null,
  };
  if (!canPrivateReply(facts)) {
    throw new CommentActionError("too_old", `This comment is more than ${PRIVATE_REPLY_DAYS} days old, so a private message can't be sent`);
  }

  // Claim it: of two people pressing Send at once, only one reaches Meta (rule R18).
  const claimed = await db
    .update(socialComment)
    .set({
      privateReplyStatus: "queued",
      privateReplyBody: text,
      privateReplyByUserId: input.userId,
      privateReplyAt: new Date(),
      privateReplyError: null,
      privateReplyErrorCode: null,
    })
    .where(
      and(
        eq(socialComment.id, target.id),
        sql`(${socialComment.privateReplyStatus} is null or ${socialComment.privateReplyStatus} in ('failed','unknown'))`,
      ),
    )
    .returning({ id: socialComment.id });
  if (claimed.length === 0) throw new CommentActionError("already_sent", "A private message was already sent for this comment");

  let sent: { recipientId: string | null; messageId: string | null };
  try {
    sent = await sendPrivateReply(cfg, account, target.externalId, text);
  } catch (err) {
    if (!(err instanceof MetaApiError)) {
      await db
        .update(socialComment)
        .set({ privateReplyStatus: "unknown", privateReplyError: "The message was interrupted before we heard back." })
        .where(eq(socialComment.id, target.id));
      throw err;
    }
    const problem = classifyMetaError(err);
    const errorCode = metaErrorCode(err);
    await db.transaction(async (tx) => {
      await tx
        .update(socialComment)
        .set({
          privateReplyStatus: problem === "unknown" ? "unknown" : "failed",
          privateReplyErrorCode: errorCode,
          privateReplyError: explainCommentError(err, network),
        })
        .where(eq(socialComment.id, target.id));
      if (problem === "gone") await markGone(tx, target);
      if (problem === "config") await raiseCommentsConfigAlert(tx, account, { code: errorCode, message: err.message });
      await publishCommentUpdated(tx, target);
    });
    return reload(db, target.id);
  }

  const channel = account.kind === "instagram" ? "instagram" : "messenger";
  const rootId = target.rootId ?? target.id;
  await db.transaction(async (tx) => {
    const identityExternal = sent.recipientId ?? target.authorExternalId;
    let conversationId: string | null = null;
    // Rule R19: nobody to attach the chat to yet. Spec 02 creates it when the customer answers.
    if (identityExternal && account.externalId) {
      const who = await findOrCreateCustomerByIdentity(tx, {
        channel,
        accountExternalId: account.externalId,
        externalId: identityExternal,
        displayName: target.authorName,
        username: target.authorUsername,
      });
      const now = new Date();
      const opened = await findOrOpenConversation(tx, who.customerId, account.id, now, { identityId: who.identityId });
      conversationId = opened.conversation.id;
      if (opened.created && opened.conversation.channel !== channel) {
        await tx.update(inboxConversation).set({ channel }).where(eq(inboxConversation.id, conversationId));
      }
      const commentRef = {
        comment_ref: {
          thread_id: rootId,
          comment_id: target.id,
          network,
          excerpt: (target.message ?? "").slice(0, PREVIEW_MAX),
        },
      };
      const [message] = await tx
        .insert(inboxMessage)
        .values({
          conversationId,
          direction: "out",
          type: "text",
          body: text,
          waMessageId: sent.messageId,
          status: "sent",
          senderUserId: input.userId,
          channel,
          payload: commentRef,
          createdAt: now,
        })
        .onConflictDoNothing({ target: inboxMessage.waMessageId })
        .returning({ id: inboxMessage.id });
      let messageId = message?.id ?? null;
      if (!messageId && sent.messageId) {
        // Spec 02 stored the echo for the same message first: keep that one row and mark it as ours.
        const [echo] = await tx
          .update(inboxMessage)
          .set({ payload: sql`coalesce(${inboxMessage.payload}, '{}'::jsonb) || ${JSON.stringify(commentRef)}::jsonb`, senderUserId: input.userId })
          .where(eq(inboxMessage.waMessageId, sent.messageId))
          .returning({ id: inboxMessage.id, conversationId: inboxMessage.conversationId });
        messageId = echo?.id ?? null;
        if (echo) conversationId = echo.conversationId;
      }
      // No inboundWa: the reply window opens only when the customer answers (rule R20).
      const conv = await touchConversation(tx, conversationId, { preview: text.slice(0, PREVIEW_MAX), at: now });
      if (messageId) await publishInboxEvent(tx, { ...signalFor("message.created", conv, messageId), direction: "out" });
      await publishInboxEvent(tx, signalFor("conversation.updated", conv));
    }
    await tx
      .update(socialComment)
      .set({ privateReplyStatus: "sent", privateReplyMessageId: sent.messageId, conversationId })
      .where(eq(socialComment.id, target.id));
    await publishCommentUpdated(tx, target);
  });
  return reload(db, target.id);
}

// ── Keeping stored comments in step with Meta ────────────────────────────────

/** Store what Meta returned for a post. `fetched_at` is stamped, so the worker leaves it alone for a day. */
export async function savePostDetails(db: DbExecutor, account: Pick<ChannelAccount, "id">, network: SocialNetwork, post: RemotePost): Promise<string> {
  const now = new Date();
  const details = {
    message: post.message,
    permalinkUrl: post.permalinkUrl,
    pictureUrl: post.pictureUrl,
    mediaType: post.mediaType,
    postedAt: post.postedAt,
    fetchedAt: now,
    fetchError: null,
  };
  const [row] = await db
    .insert(socialPostRef)
    .values({ accountId: account.id, network, externalId: post.externalId, ...details })
    .onConflictDoUpdate({
      target: [socialPostRef.network, socialPostRef.externalId],
      set: { ...details, permalinkUrl: sql`coalesce(excluded.permalink_url, ${socialPostRef.permalinkUrl})` },
    })
    .returning({ id: socialPostRef.id });
  return row!.id;
}

/**
 * Write one comment read from Meta (polling, the first load, a refresh): the
 * comment itself through applyCommentChange, then what only a read can tell us
 * (likes, and whether it is hidden). Runs in the caller's transaction.
 */
export async function applyRemoteComment(
  db: DbExecutor,
  account: ChannelAccount,
  postExternalId: string,
  remote: RemoteComment,
  opts: ApplyCommentOptions & { kind?: CommentKind },
): Promise<ApplyCommentResult> {
  const network = networkOfAccount(account);
  const result = await applyCommentChange(
    db,
    account,
    {
      type: "upsert",
      network,
      accountExternalId: account.externalId ?? "",
      kind: opts.kind ?? "comment",
      externalId: remote.externalId,
      postExternalId,
      parentExternalId: remote.parentExternalId,
      authorExternalId: remote.authorExternalId,
      authorName: remote.authorName,
      authorUsername: remote.authorUsername,
      message: remote.message,
      attachmentUrl: remote.attachmentUrl,
      commentedAt: remote.commentedAt,
      edited: false,
      postPermalink: null,
      isAd: false,
      raw: { via: opts.source },
    },
    opts,
  );
  if (!result.commentId) return result;
  const row = await reload(db, result.commentId);
  if (row.status === "deleted") return result;
  const now = opts.now ?? new Date();
  const set: Partial<typeof socialComment.$inferInsert> = {};
  if (remote.likeCount !== null && remote.likeCount !== row.likeCount) set.likeCount = remote.likeCount;
  if (remote.likedByBusiness !== null && remote.likedByBusiness !== row.likedByBusiness) set.likedByBusiness = remote.likedByBusiness;
  // A change made here in the last two minutes is newer than this read.
  const settled = !row.statusChangedAt || now.getTime() - row.statusChangedAt.getTime() > 2 * 60_000;
  if (remote.hidden === true && row.status === "visible" && settled) {
    set.status = "hidden";
    set.hiddenSource = "outside";
    set.statusChangedAt = now;
  } else if (remote.hidden === false && row.status === "hidden" && settled) {
    set.status = "visible";
    set.hiddenSource = null;
    set.statusChangedAt = now;
  }
  if (Object.keys(set).length > 0) {
    await db.update(socialComment).set(set).where(eq(socialComment.id, row.id));
    if (!result.created) await publishCommentUpdated(db, row);
  }
  return result;
}

/** Oldest first, and a parent before its replies, so threads build in order. */
export function oldestFirst(comments: RemoteComment[]): RemoteComment[] {
  return [...comments].sort(
    (a, b) =>
      a.commentedAt.getTime() - b.commentedAt.getTime() || Number(a.parentExternalId !== null) - Number(b.parentExternalId !== null),
  );
}

/**
 * Rule R11: a placeholder turned out to be a reply to comment P. Make P the
 * thread's root (creating a placeholder for P when we have never seen it) and
 * move the thread's state there.
 */
export async function rerootPlaceholder(db: DbExecutor, placeholder: SocialCommentRow, parentExternalId: string): Promise<string> {
  await lockComment(db, placeholder.network, parentExternalId);
  const parent = await commentByExternalId(db, placeholder.network, parentExternalId);
  let rootId: string;
  if (parent) {
    rootId = parent.rootId ?? parent.id;
    await db
      .update(socialComment)
      .set({
        unreadCount: sql`${socialComment.unreadCount} + ${placeholder.unreadCount}`,
        lastActivityAt: sql`greatest(${socialComment.lastActivityAt}, ${ts(placeholder.lastActivityAt)})`,
        lastPreview: sql`case when ${ts(placeholder.lastActivityAt)} >= ${socialComment.lastActivityAt} then ${placeholder.lastPreview} else ${socialComment.lastPreview} end`,
        ...(placeholder.workState === "open" && placeholder.unreadCount > 0 ? { workState: "open", doneAt: null, doneByUserId: null } : {}),
      })
      .where(and(eq(socialComment.id, rootId), sql`${socialComment.status} <> 'deleted'`));
  } else {
    const [created] = await db
      .insert(socialComment)
      .values({
        postId: placeholder.postId,
        accountId: placeholder.accountId,
        network: placeholder.network,
        externalId: parentExternalId,
        kind: placeholder.kind,
        needsFetch: true,
        workState: placeholder.workState,
        unreadCount: placeholder.unreadCount,
        assigneeId: placeholder.assigneeId,
        lastActivityAt: placeholder.lastActivityAt,
        lastPreview: placeholder.lastPreview,
        doneAt: placeholder.doneAt,
        doneByUserId: placeholder.doneByUserId,
        commentedAt: placeholder.commentedAt,
      })
      .returning({ id: socialComment.id });
    rootId = created!.id;
  }
  await db.update(socialComment).set({ rootId }).where(eq(socialComment.rootId, placeholder.id));
  await db
    .update(socialComment)
    .set({
      rootId,
      parentExternalId,
      workState: "open",
      unreadCount: 0,
      assigneeId: null,
      lastPreview: null,
      doneAt: null,
      doneByUserId: null,
    })
    .where(eq(socialComment.id, placeholder.id));
  return rootId;
}

/**
 * Rule R13: bring one thread up to date with Meta (texts, hidden state, and on
 * Instagram the only way to learn a reply was deleted). Meta is asked first;
 * the database is written afterwards, in one transaction. Throws MetaApiError.
 */
export async function refreshThread(db: DbClient, cfg: MetaConfig, rootId: string, opts: { now?: Date } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const { comment: root, account, network } = await loadTarget(db, rootId).catch((err: unknown) => {
    // A switched-off account is simply not refreshed.
    if (err instanceof CommentActionError) return { comment: null, account: null, network: null };
    throw err;
  });
  if (!root || !account || !network || root.rootId !== null) return;
  const stamp = () => db.update(socialComment).set({ refreshedAt: now }).where(eq(socialComment.id, root.id));
  // Live-video comments can be read only during the broadcast; a row with no Meta ID has nothing to ask about.
  if (!root.externalId || root.kind === "live" || root.status === "deleted") {
    await stamp();
    return;
  }
  const [post] = await db.select({ externalId: socialPostRef.externalId }).from(socialPostRef).where(eq(socialPostRef.id, root.postId));
  if (!post) return;

  let remote: RemoteThread;
  try {
    remote = await fetchComment(cfg, account, root.externalId, root.kind === "mention" ? "mention" : "comment");
  } catch (err) {
    if (classifyMetaError(err) !== "gone") throw err;
    await db.transaction(async (tx) => {
      await markGone(tx, root);
      await tx.update(socialComment).set({ refreshedAt: now }).where(eq(socialComment.id, root.id));
    });
    return;
  }

  await db.transaction(async (tx) => {
    // The root keeps its place: a refresh never re-parents it.
    await applyRemoteComment(tx, account, post.externalId, { ...remote, parentExternalId: root.parentExternalId }, {
      source: "poll",
      now,
      kind: root.kind as CommentKind,
    });
    for (const reply of oldestFirst(remote.replies)) {
      await applyRemoteComment(tx, account, post.externalId, { ...reply, parentExternalId: reply.parentExternalId ?? root.externalId }, {
        source: "poll",
        now,
      });
    }
    // Instagram sends no webhook when a comment is deleted (spec 03, I6): a stored reply Meta no longer lists is gone.
    if (network === "instagram" && remote.repliesComplete) {
      const seen = new Set(remote.replies.map((r) => r.externalId));
      const stored = await tx
        .select({ id: socialComment.id, externalId: socialComment.externalId })
        .from(socialComment)
        .where(
          and(
            eq(socialComment.rootId, root.id),
            sql`${socialComment.externalId} is not null`,
            sql`${socialComment.status} <> 'deleted'`,
            sql`${socialComment.createdAt} < ${ts(new Date(now.getTime() - 2 * 60_000))}`,
          ),
        );
      const gone = stored.filter((r) => r.externalId && !seen.has(r.externalId)).map((r) => r.id);
      if (gone.length > 0) {
        await tx.update(socialComment).set({ status: "deleted", statusChangedAt: now }).where(inArray(socialComment.id, gone));
      }
    }
    await tx.update(socialComment).set({ refreshedAt: now }).where(eq(socialComment.id, root.id));
    await publishCommentUpdated(tx, root);
  });
}

// ── The hook for posts published from the suite (spec 09) ────────────────────

/**
 * Tell Comments about a post the suite just published, so its comments show
 * the post from the first one. Spec 09 calls this where it stores the
 * permalink (advanceTargetIn, and the two publishResult calls in
 * reconcileTargetIn). Safe to call twice. Returns the social_post_ref id, or
 * null when no Facebook Page or Instagram account with that ID is connected.
 * The worker fetches the picture afterwards (fetched_at stays NULL here).
 */
export async function registerSocialPostRef(
  db: DbExecutor,
  post: {
    network: SocialNetwork;
    /** The Page ID (facebook) or the Instagram account ID (instagram). */
    accountExternalId: string;
    /** Meta's post ID ({page}_{post}) or Instagram media ID. */
    externalId: string;
    permalink?: string | null;
    caption?: string | null;
    publishedAt?: Date | null;
  },
): Promise<{ id: string } | null> {
  const account = await channelAccountByExternalId(db, post.network === "instagram" ? "instagram" : "messenger", post.accountExternalId);
  if (!account || !post.externalId) return null;
  const [row] = await db
    .insert(socialPostRef)
    .values({
      accountId: account.id,
      network: post.network,
      externalId: post.externalId,
      message: post.caption ?? null,
      permalinkUrl: post.permalink ?? null,
      postedAt: post.publishedAt ?? null,
    })
    .onConflictDoUpdate({
      target: [socialPostRef.network, socialPostRef.externalId],
      set: {
        message: sql`coalesce(${socialPostRef.message}, excluded.message)`,
        permalinkUrl: sql`coalesce(${socialPostRef.permalinkUrl}, excluded.permalink_url)`,
        postedAt: sql`coalesce(${socialPostRef.postedAt}, excluded.posted_at)`,
      },
    })
    .returning({ id: socialPostRef.id });
  return row ? { id: row.id } : null;
}

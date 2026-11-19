import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { adminUser } from "./admin-user.js";
import { inboxConversation, inboxPhoneNumber } from "./inbox.js";

/**
 * Comments on Facebook Page posts and Instagram posts (suite spec 03,
 * migration 0073). Free-text status columns have a database CHECK; the allowed
 * values are written beside each column. No table here holds a token.
 */

/** Per channel account: where the first load and the polling stand. */
export const socialCommentAccount = pgTable("social_comment_account", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => inboxPhoneNumber.id, { onDelete: "cascade" }),
  backfillStartedAt: timestamp("backfill_started_at", { withTimezone: true }),
  backfilledAt: timestamp("backfilled_at", { withTimezone: true }),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A post (Facebook) or media (Instagram) that has comments, or that the suite published. */
export const socialPostRef = pgTable(
  "social_post_ref",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => inboxPhoneNumber.id),
    /** 'facebook' | 'instagram' */
    network: text("network").notNull(),
    /** Meta's post ID ({page}_{post}) or Instagram media ID. */
    externalId: text("external_id").notNull(),
    message: text("message"),
    permalinkUrl: text("permalink_url"),
    /** Meta's short-lived picture address (foundation D11): a convenience, never the durable copy. */
    pictureUrl: text("picture_url"),
    mediaType: text("media_type"),
    isAd: boolean("is_ad").notNull().default(false),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    remoteCommentCount: integer("remote_comment_count"),
    remoteUpdatedAt: timestamp("remote_updated_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    fetchAttempts: integer("fetch_attempts").notNull().default(0),
    fetchError: text("fetch_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqExt: uniqueIndex("uq_social_post_ref_ext").on(t.network, t.externalId),
    idxAccount: index("idx_social_post_ref_account").on(t.accountId, t.postedAt),
  }),
);

/**
 * One comment. A thread is a top-level comment (root_id NULL) plus its replies
 * (root_id = the root's id). work_state, assignee_id, unread_count,
 * last_activity_at, last_preview, done_* and refreshed_at mean something only
 * on the root row.
 */
export const socialComment = pgTable(
  "social_comment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => socialPostRef.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => inboxPhoneNumber.id),
    /** 'facebook' | 'instagram' */
    network: text("network").notNull(),
    /** Meta's comment ID. NULL only on a suite reply that Meta has not confirmed yet. */
    externalId: text("external_id"),
    parentExternalId: text("parent_external_id"),
    rootId: uuid("root_id").references((): AnyPgColumn => socialComment.id),
    /** 'comment' | 'live' | 'mention' */
    kind: text("kind").notNull().default("comment"),
    authorExternalId: text("author_external_id"),
    authorName: text("author_name"),
    authorUsername: text("author_username"),
    fromBusiness: boolean("from_business").notNull().default(false),
    sentByUserId: uuid("sent_by_user_id").references(() => adminUser.id),
    message: text("message"),
    attachmentUrl: text("attachment_url"),
    /** What the public sees: 'visible' | 'hidden' | 'deleted' */
    status: text("status").notNull().default("visible"),
    /** 'suite' (hidden here) | 'outside' (hidden in Meta's screens or by Meta) */
    hiddenSource: text("hidden_source"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    /** Only on replies written in the suite: 'queued' | 'sent' | 'failed' | 'unknown' */
    sendStatus: text("send_status"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    likedByBusiness: boolean("liked_by_business").notNull().default(false),
    likeCount: integer("like_count"),
    needsFetch: boolean("needs_fetch").notNull().default(false),
    /** 'open' | 'done' */
    workState: text("work_state").notNull().default("open"),
    assigneeId: uuid("assignee_id").references(() => adminUser.id),
    unreadCount: integer("unread_count").notNull().default(0),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    lastPreview: text("last_preview"),
    doneByUserId: uuid("done_by_user_id").references(() => adminUser.id),
    doneAt: timestamp("done_at", { withTimezone: true }),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
    /** One private reply per comment: 'queued' | 'sent' | 'failed' | 'unknown' */
    privateReplyStatus: text("private_reply_status"),
    privateReplyBody: text("private_reply_body"),
    privateReplyMessageId: text("private_reply_message_id"),
    privateReplyByUserId: uuid("private_reply_by_user_id").references(() => adminUser.id),
    privateReplyAt: timestamp("private_reply_at", { withTimezone: true }),
    privateReplyErrorCode: text("private_reply_error_code"),
    privateReplyError: text("private_reply_error"),
    conversationId: uuid("conversation_id").references(() => inboxConversation.id, { onDelete: "set null" }),
    commentedAt: timestamp("commented_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqExt: uniqueIndex("uq_social_comment_ext").on(t.network, t.externalId),
    idxThreads: index("idx_social_comment_threads")
      .on(t.workState, t.lastActivityAt.desc())
      .where(sql`root_id IS NULL`),
    idxRoot: index("idx_social_comment_root").on(t.rootId, t.commentedAt),
    idxPost: index("idx_social_comment_post").on(t.postId),
    idxFetch: index("idx_social_comment_fetch")
      .on(t.createdAt)
      .where(sql`needs_fetch`),
  }),
);

/**
 * Phase B (not built): "when a comment contains this word, send this private
 * message". Created now so no later migration is needed. Every rule starts
 * switched off; only the owner may switch one on. Nothing reads this table yet.
 */
export const socialCommentRule = pgTable("social_comment_rule", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").references(() => inboxPhoneNumber.id, { onDelete: "cascade" }),
  keyword: text("keyword").notNull(),
  /** 'contains' | 'exact' */
  match: text("match").notNull().default("contains"),
  replyText: text("reply_text").notNull(),
  isActive: boolean("is_active").notNull().default(false),
  activatedByUserId: uuid("activated_by_user_id").references(() => adminUser.id),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  sentCount: integer("sent_count").notNull().default(0),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { adminUser } from "./admin-user.js";
import { inboxPhoneNumber } from "./inbox.js";

/** One picture or video of a post, in display order. `key` is the R2 object key, never a Meta URL. */
export interface SocialPostMedia {
  key: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  duration_s: number | null;
  alt_text: string | null;
}

/**
 * A post written in the suite (suite spec 09). It is sent to one row per network in
 * social_post_target. Database CHECKs enforce the lists:
 * kind: 'text' | 'link' | 'photo' | 'album' | 'video' | 'story'
 * status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'partly_published' | 'failed' | 'needs_check' | 'missed'
 * Contains no token.
 */
export const socialPost = pgTable(
  "social_post",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    caption: text("caption").notNull().default(""),
    linkUrl: text("link_url"),
    media: jsonb("media").$type<SocialPostMedia[]>().notNull().default([]),
    status: text("status").notNull().default("draft"),
    /** null means "post as soon as approved". */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    statusNote: text("status_note"),
    approvedBy: uuid("approved_by").references(() => adminUser.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** The fingerprint of exactly what the person confirmed; the worker refuses to publish anything else. */
    approvedHash: text("approved_hash"),
    /** The hook for AI caption help: 'person' today. Nothing reads it yet. */
    captionSource: text("caption_source").notNull().default("person"),
    createdBy: uuid("created_by").references(() => adminUser.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxStatusSched: index("idx_social_post_status_sched").on(t.status, t.scheduledAt),
    idxCreated: index("idx_social_post_created").on(t.createdAt),
  }),
);

/**
 * One network a post goes to (suite spec 09).
 * network: 'facebook' | 'instagram'
 * status: 'pending' | 'publishing' | 'published' | 'failed' | 'unknown' | 'removed'
 * step: 'start' | 'media' | 'container' | 'wait' | 'publish' | 'done'
 * account_id is null only if the channel account row was deleted (ruling 9.2.8); such a target cannot publish.
 * (network, external_id) is what spec 11 (statistics) joins on and what spec 03 (comments) registers.
 */
export const socialPostTarget = pgTable(
  "social_post_target",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => socialPost.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => inboxPhoneNumber.id, { onDelete: "set null" }),
    network: text("network").notNull(),
    captionOverride: text("caption_override"),
    status: text("status").notNull().default("pending"),
    step: text("step").notNull().default("start"),
    containerId: text("container_id"),
    /** Facebook unpublished photo IDs for an album, or Instagram child container IDs for a carousel, in order. */
    childIds: jsonb("child_ids").$type<string[]>().notNull().default([]),
    /** Facebook Page post ID or video ID, or Instagram media ID. */
    externalId: text("external_id"),
    /** 'post' | 'video' | 'media' */
    externalKind: text("external_kind"),
    permalink: text("permalink"),
    attempts: integer("attempts").notNull().default(0),
    reconcileChecks: integer("reconcile_checks").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    waitStartedAt: timestamp("wait_started_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorSubcode: text("error_subcode"),
    errorMessage: text("error_message"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by").references(() => adminUser.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqAccount: uniqueIndex("uq_social_post_target_account").on(t.postId, t.accountId),
    uqExternal: uniqueIndex("uq_social_post_target_external")
      .on(t.network, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    idxDue: index("idx_social_post_target_due").on(t.status, t.nextAttemptAt),
  }),
);

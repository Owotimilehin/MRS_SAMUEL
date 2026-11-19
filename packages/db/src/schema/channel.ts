import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { adminUser } from "./admin-user.js";
import { inboxPhoneNumber } from "./inbox.js";

/**
 * Chat set-up for Messenger and Instagram (suite spec 04). One row per version of
 * the set-up for one channel account: the draft (at most one), or a publish attempt.
 * status: 'draft' | 'pushing' | 'live' | 'failed' | 'unknown' | 'superseded'
 * (a database CHECK enforces the list). Contains no token.
 */
export const channelChatSetup = pgTable(
  "channel_chat_setup",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => inboxPhoneNumber.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    /** A ChatSetupConfig (@ms/shared). */
    config: jsonb("config").notNull(),
    /** What Meta returned before and after the publish (the four properties only). */
    liveBefore: jsonb("live_before"),
    liveAfter: jsonb("live_after"),
    /** [{op: "delete" | "set" | "read", fields, ok, code, message, at}] */
    steps: jsonb("steps"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdByUserId: uuid("created_by_user_id").references(() => adminUser.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    pushedByUserId: uuid("pushed_by_user_id").references(() => adminUser.id),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    /** Every time this version was sent to Meta; each try counts towards the 10-minute limit (M6). */
    pushTries: timestamp("push_tries", { withTimezone: true }).array(),
  },
  (t) => ({
    uqVersion: uniqueIndex("uq_channel_chat_setup_version").on(t.accountId, t.version),
    uqDraft: uniqueIndex("uq_channel_chat_setup_draft")
      .on(t.accountId)
      .where(sql`status = 'draft'`),
    idxPushed: index("idx_channel_chat_setup_pushed").on(t.accountId, sql`pushed_at desc`),
  }),
);

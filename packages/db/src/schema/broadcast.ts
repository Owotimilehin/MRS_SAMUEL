import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { adminUser } from "./admin-user.js";
import { customer } from "./customer.js";
import { contactList } from "./contact.js";
import { inboxMessage, inboxPhoneNumber, inboxTemplate } from "./inbox.js";

/**
 * Broadcasts on WhatsApp (suite spec 14, Phase B; migration 0083). Everything
 * lives under the `broadcast_` prefix. One approved template sent to a list.
 *
 * The CHECK constraints (status, route, recipient state) live in the SQL
 * migration. The jsonb columns hold shapes defined in @ms/shared
 * (BroadcastBlanks); this package does not depend on @ms/shared, so they are
 * typed loosely here and narrowed where they are read.
 *
 * Foundation ruling 9.2.8: the columns that point at customer, inbox_message
 * and admin_user are ON DELETE SET NULL (or plain references to admin_user,
 * which is never deleted), and the contact erase and merge routes handle
 * broadcast_recipient (apps/api/src/lib/contacts-merge-erase.ts).
 */

/** draft → (scheduled →) sending → done. A person pauses or cancels; the system only ever stops. */
export const broadcast = pgTable(
  "broadcast",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** 'draft' | 'scheduled' | 'sending' | 'paused' | 'stopped' | 'done' | 'cancelled' */
    status: text("status").notNull().default("draft"),
    /** Why the system stopped it (BROADCAST_STOP_REASONS in @ms/shared). */
    stopReason: text("stop_reason"),
    stopDetail: text("stop_detail"),
    phoneNumberId: uuid("phone_number_id")
      .notNull()
      .references(() => inboxPhoneNumber.id),
    templateId: uuid("template_id").references(() => inboxTemplate.id, { onDelete: "set null" }),
    /** Copied at confirmation, so what was sent can be named after the template is gone. */
    templateName: text("template_name"),
    templateLanguage: text("template_language"),
    templateCategory: text("template_category"),
    listId: uuid("list_id").references(() => contactList.id, { onDelete: "set null" }),
    listName: text("list_name"),
    /** BroadcastBlanks (@ms/shared): how each blank of the template is filled. */
    blanks: jsonb("blanks").$type<Record<string, unknown>>().notNull().default({}),
    headerMediaKey: text("header_media_key"),
    headerMediaMime: text("header_media_mime"),
    /** Meta's media ID for the header picture (lasts 30 days). */
    headerMediaId: text("header_media_id"),
    headerMediaUploadedAt: timestamp("header_media_uploaded_at", { withTimezone: true }),
    /** 'cloud' | 'mm' */
    route: text("route").notNull().default("cloud"),
    /** SHA-256 of the message as it stands. Fixed at confirmation and re-checked before sending. */
    fingerprint: text("fingerprint"),
    /** The fingerprint at the last successful test. Must equal `fingerprint` to confirm. */
    testFingerprint: text("test_fingerprint"),
    testTo: text("test_to"),
    testMessageId: uuid("test_message_id").references(() => inboxMessage.id, { onDelete: "set null" }),
    testSentAt: timestamp("test_sent_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    confirmedBy: uuid("confirmed_by").references(() => adminUser.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedCount: integer("confirmed_count"),
    attributionDays: integer("attribution_days").notNull().default(7),
    /** The pause after the first batch: nothing goes out before this time. */
    warmupUntil: timestamp("warmup_until", { withTimezone: true }),
    /** Back-off after Meta asked us to slow down. */
    waitUntil: timestamp("wait_until", { withTimezone: true }),
    tempErrors: integer("temp_errors").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => adminUser.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ idxStatus: index("idx_broadcast_status").on(t.status, t.scheduledAt) }),
);

/**
 * One row per contact per broadcast, written at confirmation. The two unique
 * indexes are the "never twice" guarantee (rule R57): one row per contact and
 * one per phone number.
 */
export const broadcastRecipient = pgTable(
  "broadcast_recipient",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    broadcastId: uuid("broadcast_id")
      .notNull()
      .references(() => broadcast.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
    /** The WhatsApp number (digits) or user ID this row goes to, fixed at confirmation. */
    toWa: text("to_wa"),
    /** 'pending' | 'skipped' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown' */
    state: text("state").notNull().default("pending"),
    skipReason: text("skip_reason"),
    /** The filled blanks for this person: { body: string[], header?: string }. */
    values: jsonb("values").$type<{ body: string[]; header?: string }>(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    messageId: uuid("message_id").references(() => inboxMessage.id, { onDelete: "set null" }),
    waMessageId: text("wa_message_id"),
    errorCode: text("error_code"),
    errorText: text("error_text"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqCustomer: uniqueIndex("uq_broadcast_recipient_customer")
      .on(t.broadcastId, t.customerId)
      .where(sql`customer_id is not null`),
    uqNumber: uniqueIndex("uq_broadcast_recipient_number")
      .on(t.broadcastId, t.toWa)
      .where(sql`to_wa is not null and state <> 'skipped'`),
    idxWork: index("idx_broadcast_recipient_work").on(t.broadcastId, t.state, t.nextAttemptAt),
    idxCustomer: index("idx_broadcast_recipient_customer").on(t.customerId, t.sentAt),
    idxMessage: index("idx_broadcast_recipient_message").on(t.messageId),
  }),
);

/** What happened to a broadcast, and who did it: confirmed, started, paused, resumed, stopped, cancelled, finished, waiting_hours, waiting_limit, warmup, test. */
export const broadcastEvent = pgTable(
  "broadcast_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    broadcastId: uuid("broadcast_id")
      .notNull()
      .references(() => broadcast.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    detail: text("detail"),
    userId: uuid("user_id").references(() => adminUser.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ idx: index("idx_broadcast_event").on(t.broadcastId, t.at) }),
);

import { sql } from "drizzle-orm";
import { boolean, date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { inboxPhoneNumber } from "./inbox.js";

/**
 * Statistics from Meta, one row per figure per day (suite spec 11, migration 0079).
 *
 * source: 'facebook_page' | 'facebook_post' | 'instagram_account' | 'instagram_media'
 * | 'whatsapp' | 'whatsapp_template' (a database CHECK enforces the list).
 * `day` is the calendar day as the source counts it and `day_zone` the zone that day
 * follows; days are never converted. A missing figure has no row (it is not zero).
 * Rows with is_running_total are "the total so far on this day" and are never summed.
 */
export const insightMetricDaily = pgTable(
  "insight_metric_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    /** The ID Meta reports on: Page ID, Instagram account ID or WABA ID. */
    accountKey: text("account_key").notNull(),
    /** The channel account row for a Page or Instagram account; null for WhatsApp. */
    accountId: uuid("account_id").references(() => inboxPhoneNumber.id, { onDelete: "set null" }),
    /** '' for account-level figures; a Page post ID, Instagram media ID or template ID otherwise. */
    subjectId: text("subject_id").notNull().default(""),
    metric: text("metric").notNull(),
    day: date("day").notNull(),
    dayZone: text("day_zone").notNull(),
    /** '' or "key=value" pairs joined with ";" in alphabetical key order. */
    breakdown: text("breakdown").notNull().default(""),
    value: numeric("value", { precision: 20, scale: 4 }).notNull(),
    isRunningTotal: boolean("is_running_total").notNull().default(false),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("uq_insight_metric_daily").on(t.source, t.accountKey, t.subjectId, t.metric, t.day, t.breakdown),
    idxDay: index("idx_insight_metric_day").on(t.source, t.metric, t.day),
    idxSubject: index("idx_insight_metric_subject")
      .on(t.source, t.subjectId)
      .where(sql`subject_id <> ''`),
  }),
);

/**
 * A label for each post or template so tables can show a title and a link.
 * source: 'facebook_post' | 'instagram_media' | 'whatsapp_template'. gone_at is set
 * when Meta says the item no longer exists. No Meta media URL is stored.
 */
export const insightSubject = pgTable(
  "insight_subject",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    accountKey: text("account_key").notNull(),
    subjectId: text("subject_id").notNull(),
    kind: text("kind"),
    title: text("title"),
    permalink: text("permalink"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    goneAt: timestamp("gone_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("uq_insight_subject").on(t.source, t.subjectId),
  }),
);

import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  numeric,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { adminUser } from "./admin-user.js";
import { customer } from "./customer.js";
import { inboxConversation } from "./inbox.js";
import { saleOrder } from "./sale-order.js";

/**
 * Ads: results, spend and click-to-chat adverts (suite spec 12, migration 0080).
 * The CHECK lists on the state columns, and the trigger that makes ad_action_log
 * append-only, live in the SQL migration.
 *
 * Units: every *_units column holds the integer exactly as Meta's API gives or
 * takes it for a budget. ad_account_link.budget_factor is how many units make
 * one whole unit of the account's currency (100 if Meta works in kobo or cents,
 * 1 if in whole naira). It is null until an owner has calibrated it.
 */

/** The one ad account the suite reads. At most one active row (partial unique index). */
export const adAccountLink = pgTable(
  "ad_account_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adAccountId: text("ad_account_id").notNull().unique(),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    timezoneName: text("timezone_name").notNull(),
    timezoneOffsetHoursUtc: numeric("timezone_offset_hours_utc", { precision: 5, scale: 2 }),
    accountStatus: integer("account_status"),
    minDailyBudgetUnits: bigint("min_daily_budget_units", { mode: "number" }),
    budgetFactor: integer("budget_factor"),
    budgetFactorConfirmedBy: uuid("budget_factor_confirmed_by").references(() => adminUser.id, { onDelete: "set null" }),
    budgetFactorConfirmedAt: timestamp("budget_factor_confirmed_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    linkedBy: uuid("linked_by").references(() => adminUser.id, { onDelete: "set null" }),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    backfilledAt: timestamp("backfilled_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
  },
  (t) => ({
    uqOneActive: uniqueIndex("uq_ad_account_link_one_active").on(t.isActive).where(sql`${t.isActive}`),
  }),
);

/** Campaigns, ad sets and ads as Meta last listed them. level: 'campaign' | 'adset' | 'ad'. */
export const adCampaignCache = pgTable(
  "ad_campaign_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adAccountId: text("ad_account_id").notNull(),
    level: text("level").notNull(),
    externalId: text("external_id").notNull(),
    parentExternalId: text("parent_external_id"),
    campaignExternalId: text("campaign_external_id"),
    name: text("name"),
    status: text("status"),
    effectiveStatus: text("effective_status"),
    objective: text("objective"),
    destinationType: text("destination_type"),
    dailyBudgetUnits: bigint("daily_budget_units", { mode: "number" }),
    lifetimeBudgetUnits: bigint("lifetime_budget_units", { mode: "number" }),
    startTime: timestamp("start_time", { withTimezone: true }),
    endTime: timestamp("end_time", { withTimezone: true }),
    /** For ads: { title, body } only. Never an image link. */
    creative: jsonb("creative").$type<{ title: string | null; body: string | null } | null>(),
    /** True only for objects the suite created AND verified. Only these can be turned on from the suite. */
    createdBySuite: boolean("created_by_suite").notNull().default(false),
    goneAt: timestamp("gone_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("uq_ad_campaign_cache").on(t.level, t.externalId),
    idxAccount: index("idx_ad_campaign_cache_account").on(t.adAccountId, t.level),
  }),
);

/** One row per ad (or the whole account) per day, as the ad account counts days. level: 'account' | 'ad'. */
export const adInsightDaily = pgTable(
  "ad_insight_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adAccountId: text("ad_account_id").notNull(),
    level: text("level").notNull(),
    externalId: text("external_id").notNull(),
    day: date("day").notNull(),
    dayZone: text("day_zone").notNull(),
    currency: text("currency").notNull(),
    spend: numeric("spend", { precision: 14, scale: 2 }).notNull().default("0"),
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    reach: bigint("reach", { mode: "number" }),
    clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
    linkClicks: bigint("link_clicks", { mode: "number" }),
    conversationsStarted: integer("conversations_started").notNull().default(0),
    firstReplies: integer("first_replies").notNull().default(0),
    metaPurchases: numeric("meta_purchases", { precision: 14, scale: 2 }).notNull().default("0"),
    metaPurchaseValue: numeric("meta_purchase_value", { precision: 14, scale: 2 }).notNull().default("0"),
    actions: jsonb("actions").$type<{ action_type: string; value: string }[]>().notNull().default(sql`'[]'::jsonb`),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("uq_ad_insight_daily").on(t.level, t.externalId, t.day),
    idxAccountDay: index("idx_ad_insight_daily_account_day").on(t.adAccountId, t.day),
  }),
);

/**
 * Everything the suite did, or tried to do, to the ad account. APPEND-ONLY: a
 * database trigger refuses UPDATE, DELETE and TRUNCATE, and the code only ever
 * inserts (through writeAdLog in @ms/domain). Each action writes a 'requested'
 * row BEFORE the call to Meta and a 'result' row after it, sharing request_id;
 * a 'requested' row with no 'result' means "unknown".
 * actor_user_id has no foreign key on purpose: deleting a staff account must
 * not block or alter the log. `request` never contains a token.
 */
export const adActionLog = pgTable(
  "ad_action_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id").notNull(),
    /** 'requested' | 'result' */
    phase: text("phase").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** 'person' | 'rule' | 'safety' | 'system' */
    actorKind: text("actor_kind").notNull(),
    actorUserId: uuid("actor_user_id"),
    actorName: text("actor_name"),
    action: text("action").notNull(),
    adAccountId: text("ad_account_id"),
    objectLevel: text("object_level"),
    objectExternalId: text("object_external_id"),
    summary: text("summary").notNull(),
    maxSpendUnits: bigint("max_spend_units", { mode: "number" }),
    currency: text("currency"),
    confirmText: text("confirm_text"),
    request: jsonb("request").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** 'ok' | 'refused' | 'unknown' | 'blocked' (result rows only) */
    outcome: text("outcome"),
    metaCode: text("meta_code"),
    metaMessage: text("meta_message"),
    response: jsonb("response").$type<Record<string, unknown> | null>(),
  },
  (t) => ({
    uqRequestPhase: uniqueIndex("uq_ad_action_log_request_phase").on(t.requestId, t.phase),
    idxAt: index("idx_ad_action_log_at").on(t.at),
  }),
);

/** One row per time a customer arrived from an advert. source_key makes it idempotent. */
export const adTouch = pgTable(
  "ad_touch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 'msg:<inbox_message.id>' for WhatsApp, 'evt:<inbox_webhook_event.id>:<n>' for Messenger and Instagram. */
    sourceKey: text("source_key").notNull().unique(),
    /** 'whatsapp' | 'messenger' | 'instagram' */
    channel: text("channel").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => inboxConversation.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    adExternalId: text("ad_external_id"),
    postExternalId: text("post_external_id"),
    headline: text("headline"),
    body: text("body"),
    sourceUrl: text("source_url"),
    mediaType: text("media_type"),
    /** Meta's click ID for a click-to-WhatsApp tap. Personal data: never returned by a route, shortened in the log. */
    ctwaClid: text("ctwa_clid"),
    accountExternalId: text("account_external_id"),
    senderExternalId: text("sender_external_id"),
    touchedAt: timestamp("touched_at", { withTimezone: true }).notNull(),
    reportingBlockedAt: timestamp("reporting_blocked_at", { withTimezone: true }),
    reportingBlockedBy: uuid("reporting_blocked_by").references(() => adminUser.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxCustomer: index("idx_ad_touch_customer").on(t.customerId, t.touchedAt),
    idxAd: index("idx_ad_touch_ad").on(t.adExternalId, t.touchedAt),
    idxConversation: index("idx_ad_touch_conversation").on(t.conversationId),
  }),
);

/** Which advert tap a paid shop order is credited to. At most one row per order. */
export const adOrderAttribution = pgTable(
  "ad_order_attribution",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleOrderId: uuid("sale_order_id")
      .notNull()
      .unique()
      .references(() => saleOrder.id, { onDelete: "cascade" }),
    touchId: uuid("touch_id")
      .notNull()
      .references(() => adTouch.id, { onDelete: "cascade" }),
    rule: text("rule").notNull(),
    orderAt: timestamp("order_at", { withTimezone: true }).notNull(),
    /** Goods total without the delivery fee, whole naira. */
    valueNgn: integer("value_ngn").notNull(),
    /** 'none' | 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'skipped' */
    capiStatus: text("capi_status").notNull().default("none"),
    capiNote: text("capi_note"),
    capiAttempts: integer("capi_attempts").notNull().default(0),
    capiLockedAt: timestamp("capi_locked_at", { withTimezone: true }),
    capiSentAt: timestamp("capi_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxTouch: index("idx_ad_order_attribution_touch").on(t.touchId),
    idxCapi: index("idx_ad_order_attribution_capi").on(t.capiStatus),
  }),
);

/** What the owner typed into the New advert form (validated with zod in @ms/domain on every write). */
export interface AdDraftSpec {
  destination: "whatsapp" | "messenger" | "instagram";
  /** inbox_phone_number.id: the WhatsApp number, the Page, or the Instagram account. */
  account_id: string;
  name: string;
  headline: string;
  primary_text: string;
  description: string | null;
  image_key: string;
  greeting: string;
  prefilled_message: string | null;
  audience: { area: "nigeria" | "near_shop"; radius_km: number | null; age_min: number; age_max: number };
  /** Whole currency units of the ad account, integer >= 1. */
  daily_budget: number;
  start_at: string;
  end_at: string;
  special_category: false;
}

/** An advert being written or created. status: 'draft' | 'creating' | 'created' | 'failed' | 'needs_check'. */
export const adDraft = pgTable("ad_draft", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull().default("draft"),
  spec: jsonb("spec").$type<AdDraftSpec>().notNull(),
  /** 'start' | 'image' | 'campaign' | 'adset' | 'creative' | 'ad' | 'verify' | 'done': the step to run next. */
  step: text("step").notNull().default("start"),
  imageHash: text("image_hash"),
  campaignExternalId: text("campaign_external_id"),
  adsetExternalId: text("adset_external_id"),
  creativeExternalId: text("creative_external_id"),
  adExternalId: text("ad_external_id"),
  confirmedBy: uuid("confirmed_by").references(() => adminUser.id, { onDelete: "set null" }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  confirmedHash: text("confirmed_hash"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdBy: uuid("created_by").references(() => adminUser.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** "Pause if a chat costs more than X". Rules can only ever pause. metric: 'cost_per_conversation'. */
export const adRule = pgTable("ad_rule", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  metric: text("metric").notNull(),
  threshold: numeric("threshold", { precision: 14, scale: 2 }).notNull(),
  currency: text("currency").notNull(),
  lookbackDays: integer("lookback_days").notNull(),
  minSpend: numeric("min_spend", { precision: 14, scale: 2 }).notNull().default("0"),
  scopeCampaignExternalId: text("scope_campaign_external_id"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by").references(() => adminUser.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
});

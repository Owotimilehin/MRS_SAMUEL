import { pgTable, text, jsonb, timestamp, uuid } from "drizzle-orm/pg-core";
import { adminUser } from "./admin-user.js";

/**
 * Generic key/value store for owner-editable site settings (starting with the
 * homepage banner). One row per setting `key`; `value` is the setting's JSON.
 */
export const appSetting = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => adminUser.id),
});

/** JSON shape stored under the `site_banner` key. */
export interface SiteBannerValue {
  enabled: boolean;
  message: string;
}

export const SITE_BANNER_KEY = "site_banner";

/** JSON shape stored under the `payment_provider` key. */
export interface PaymentProviderValue {
  provider: "opay";
}

export const PAYMENT_PROVIDER_KEY = "payment_provider";

/** JSON shape stored under the `social_publishing` key (suite spec 09). A missing row means false. */
export interface SocialPublishingValue {
  scheduled_enabled: boolean;
}

export const SOCIAL_PUBLISHING_KEY = "social_publishing";

/**
 * JSON shape stored under the `insights_state` key (suite spec 11, section 4.4):
 * when the statistics were last collected and what each source last said. No token.
 */
export interface InsightsStateValue {
  /** Lagos day YYYY-MM-DD of the last completed daily run. */
  last_daily_run_day: string | null;
  /** ISO time of the last completed full run. */
  last_run_at: string | null;
  /** ISO time the Refresh button was last pressed. */
  refresh_requested_at: string | null;
  /** Key: `${source}:${account_key}`. */
  sources: Record<
    string,
    {
      last_ok_at: string | null;
      backfilled: boolean;
      problem_code: string | null;
      problem_message: string | null;
      invalid_metrics: string[];
    }
  >;
  /** Key: WABA id. Present only after the owner turned template figures on. */
  template_analytics: Record<string, { enabled_at: string; enabled_by: string }>;
}

export const INSIGHTS_STATE_KEY = "insights_state";

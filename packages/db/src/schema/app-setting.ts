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

/**
 * JSON shape stored under the `ads_settings` key (suite spec 12, section 4.3).
 * Every switch is off until the owner turns it on; a daily cap of 0 means
 * nothing may be turned on.
 */
export interface AdsSettingsValue {
  /** Phase B master switch: adverts may be created and changed from the suite. Default false. */
  manage_enabled: boolean;
  /** Whole currency units of the ad account, e.g. 10000 = ₦10,000. Default 0 = nothing may be turned on. */
  daily_cap: number;
  /** Let rules pause adverts unattended. Default false. Rules can only pause. */
  rules_enabled: boolean;
  /** Report purchases to Meta. Default false. */
  capi_enabled: boolean;
  capi_privacy_confirmed_by: string | null;
  capi_privacy_confirmed_at: string | null;
  /** WABA id -> dataset id. */
  datasets: Record<string, string>;
  /** 1..28, default 7. */
  attribution_window_days: number;
  refresh_requested_at: string | null;
  /** Lagos day of the last full sync. */
  last_sync_day: string | null;
}

export const ADS_SETTINGS_KEY = "ads_settings";

export const ADS_SETTINGS_DEFAULT: AdsSettingsValue = {
  manage_enabled: false,
  daily_cap: 0,
  rules_enabled: false,
  capi_enabled: false,
  capi_privacy_confirmed_by: null,
  capi_privacy_confirmed_at: null,
  datasets: {},
  attribution_window_days: 7,
  refresh_requested_at: null,
  last_sync_day: null,
};

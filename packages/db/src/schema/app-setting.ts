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

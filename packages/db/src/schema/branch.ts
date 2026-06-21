import { pgTable, uuid, text, boolean, timestamp, time, jsonb, numeric } from "drizzle-orm/pg-core";
import { adminUser } from "./admin-user.js";

export interface DeliveryZone {
  name: string;
  fee_ngn: number;
}

export const branch = pgTable("branch", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  address: text("address"),
  phone: text("phone"),
  /** Branch coordinates used for pickup when requesting delivery from
   *  third-party providers (Bolt, etc). Optional — if null, the provider
   *  geocodes the address text instead (lower accuracy). */
  lat: numeric("lat", { precision: 10, scale: 6 }),
  lng: numeric("lng", { precision: 10, scale: 6 }),
  managerUserId: uuid("manager_user_id").references(() => adminUser.id, { onDelete: "set null" }),
  deliveryZones: jsonb("delivery_zones").$type<DeliveryZone[]>().notNull().default([]),
  opensAt: time("opens_at"),
  closesAt: time("closes_at"),
  timezone: text("timezone").notNull().default("Africa/Lagos"),
  isActive: boolean("is_active").notNull().default(true),
  /** The one branch that fulfils web orders. Checkout falls back to the first
   *  active branch when none is set. App enforces at most one true. */
  isOnlineDefault: boolean("is_online_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

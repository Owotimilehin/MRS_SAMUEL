import { pgTable, uuid, text, boolean, timestamp, time, jsonb } from "drizzle-orm/pg-core";
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
  managerUserId: uuid("manager_user_id").references(() => adminUser.id, { onDelete: "set null" }),
  deliveryZones: jsonb("delivery_zones").$type<DeliveryZone[]>().notNull().default([]),
  opensAt: time("opens_at"),
  closesAt: time("closes_at"),
  timezone: text("timezone").notNull().default("Africa/Lagos"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

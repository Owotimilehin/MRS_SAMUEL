import { pgTable, uuid, text, integer, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";

/** Subscription plans shown on the public site (read-only; WhatsApp CTA). */
export const subscriptionPlan = pgTable("subscription_plan", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  priceNgn: integer("price_ngn").notNull(),
  period: text("period").notNull(),
  bottlesLabel: text("bottles_label"),
  description: text("description"),
  perks: jsonb("perks").notNull().default([]).$type<string[]>(),
  popular: boolean("popular").notNull().default(false),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  // Optional native-plan code (unused while billing is self-managed) + a
  // fulfilment hint for the per-cycle staff order.
  payazaPlanCode: text("payaza_plan_code"),
  bottlesPerCycle: integer("bottles_per_cycle"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

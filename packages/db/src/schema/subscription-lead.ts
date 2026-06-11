import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

/** Subscription enquiry leads captured when a visitor clicks a plan CTA. */
export const subscriptionLead = pgTable("subscription_lead", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  planSlug: text("plan_slug").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

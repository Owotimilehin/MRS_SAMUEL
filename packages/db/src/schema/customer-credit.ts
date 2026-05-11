import { pgTable, uuid, integer, text, timestamp } from "drizzle-orm/pg-core";
import { customer } from "./customer.js";

/**
 * Signed-amount credit ledger per customer. Positive rows are earned
 * (store_credit refunds), negative rows are redemptions against future
 * orders. Balance = SUM(amount_ngn).
 */
export const customerCredit = pgTable("customer_credit", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  amountNgn: integer("amount_ngn").notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

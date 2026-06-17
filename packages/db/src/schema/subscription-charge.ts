import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { customerSubscription } from "./customer-subscription.js";
import { saleOrder } from "./sale-order.js";

/**
 * One row per recurring charge attempt against a subscription — the invoice
 * ledger. A successful charge spawns a subscription `sale_order` into the
 * staff-fulfil queue (sale_order_id links it). Failed charges drive dunning.
 */
export const subscriptionCharge = pgTable("subscription_charge", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: uuid("subscription_id")
    .notNull()
    .references(() => customerSubscription.id, { onDelete: "cascade" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  amountNgn: integer("amount_ngn").notNull(),
  status: text("status").notNull(), // success | failed
  processorReference: text("processor_reference"),
  saleOrderId: uuid("sale_order_id").references(() => saleOrder.id),
  failureReason: text("failure_reason"),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
});

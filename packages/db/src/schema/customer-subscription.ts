import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { customer } from "./customer.js";
import { subscriptionPlan } from "./subscription-plan.js";
import { branch } from "./branch.js";

/**
 * A live subscription instance for one customer on one plan. Payaza has no
 * server-side recurring API in its public integration, so billing is
 * self-managed: the first payment (via the checkout SDK with save-card) yields
 * a reusable card token; the worker then charges that token each period.
 *
 * status: pending (awaiting first payment) → active → past_due (a charge
 * failed) → cancelled | expired. paused is a manual hold.
 */
export const customerSubscription = pgTable("customer_subscription", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  planId: uuid("plan_id").notNull().references(() => subscriptionPlan.id),
  // Branch that fulfils each cycle's order (snapshot at subscribe time).
  branchId: uuid("branch_id").notNull().references(() => branch.id),
  // Price + period snapshotted so plan edits don't retroactively re-bill.
  priceNgn: integer("price_ngn").notNull(),
  period: text("period").notNull(), // weekly | biweekly | monthly
  status: text("status").notNull().default("pending"),
  // Reusable Payaza authorization_code captured from the first charge.
  payazaToken: text("payaza_token"),
  payazaCustomerRef: text("payaza_customer_ref"),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  nextChargeAt: timestamp("next_charge_at", { withTimezone: true }),
  lastChargeAt: timestamp("last_charge_at", { withTimezone: true }),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  pastDueSince: timestamp("past_due_since", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

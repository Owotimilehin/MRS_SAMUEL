import { pgTable, uuid, text, integer, date, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { adminUser } from "./admin-user.js";
import { businessExpenseCategory } from "./business-expense.js";

/**
 * Schedule template for an expense that recurs monthly. The worker
 * materialises today's matching schedules into real `business_expense` rows.
 *
 * `day_of_month` is 1..31. For schedules with `day_of_month > 28` in months
 * that don't have that many days, the worker fires on the last day of that
 * month (e.g. day 31 in Feb).
 */
export const recurringExpense = pgTable(
  "recurring_expense",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryCode: businessExpenseCategory("category_code").notNull(),
    amountNgn: integer("amount_ngn").notNull(),
    vendorName: text("vendor_name"),
    description: text("description"),
    reasonNote: text("reason_note"),
    dayOfMonth: integer("day_of_month").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    active: boolean("active").notNull().default(true),
    recordedByUserId: uuid("recorded_by_user_id").references(() => adminUser.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxActive: index("idx_recurring_active").on(t.active),
    idxDom: index("idx_recurring_dom").on(t.dayOfMonth),
  }),
);

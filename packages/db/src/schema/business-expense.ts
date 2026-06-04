import { pgTable, uuid, pgEnum, text, integer, date, timestamp, index } from "drizzle-orm/pg-core";
import { adminUser } from "./admin-user.js";
import { vendor } from "./vendor.js";

export const businessExpenseCategory = pgEnum("business_expense_category", [
  "raw_materials",
  "packaging",
  "utilities",
  "transport",
  "salaries",
  "rent",
  "marketing",
  "equipment",
  "regulatory",
  "other_with_note",
]);

/**
 * One row per money-out event. `receipt_url` stores the bare R2 object key;
 * the API converts it to a signed GET URL on read. Soft-delete via `deleted_at`.
 */
export const businessExpense = pgTable(
  "business_expense",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expenseDate: date("expense_date").notNull(),
    categoryCode: businessExpenseCategory("category_code").notNull(),
    amountNgn: integer("amount_ngn").notNull(),
    vendorName: text("vendor_name"),
    vendorId: uuid("vendor_id").references(() => vendor.id),
    description: text("description"),
    reasonNote: text("reason_note"),
    receiptUrl: text("receipt_url"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => adminUser.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxDate: index("idx_business_expense_date").on(t.expenseDate),
    idxCategory: index("idx_business_expense_category").on(t.categoryCode),
    idxDeleted: index("idx_business_expense_deleted").on(t.deletedAt),
  }),
);

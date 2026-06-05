import { pgTable, uuid, integer, text, date, timestamp } from "drizzle-orm/pg-core";
import { factory } from "./factory.js";
import { packagingMaterial } from "./packaging-material.js";
import { businessExpense } from "./business-expense.js";
import { adminUser } from "./admin-user.js";

/**
 * One row per recorded purchase. Posts a credit to packaging_stock_ledger
 * and (when feed_bookkeeping was on) also creates a business_expense row,
 * with the FK kept here for cross-reference.
 */
export const packagingPurchase = pgTable("packaging_purchase", {
  id: uuid("id").primaryKey().defaultRandom(),
  factoryId: uuid("factory_id").notNull().references(() => factory.id, { onDelete: "restrict" }),
  packagingMaterialId: uuid("packaging_material_id")
    .notNull()
    .references(() => packagingMaterial.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
  unitCostNgn: integer("unit_cost_ngn").notNull(),
  totalCostNgn: integer("total_cost_ngn").notNull(),
  supplierName: text("supplier_name"),
  purchaseDate: date("purchase_date").notNull(),
  businessExpenseId: uuid("business_expense_id").references(() => businessExpense.id),
  recordedByUserId: uuid("recorded_by_user_id").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

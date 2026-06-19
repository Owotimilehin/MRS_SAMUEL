import { pgTable, uuid, integer, text, timestamp, date } from "drizzle-orm/pg-core";
import { branch } from "./branch.js";
import { product } from "./product.js";
import { productVariant } from "./product-variant.js";
import { adminUser } from "./admin-user.js";

export const shiftOpen = pgTable(
  "shift_open",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: uuid("branch_id").notNull().references(() => branch.id),
    businessDate: date("business_date").notNull(),
    openedByUserId: uuid("opened_by_user_id").references(() => adminUser.id),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    notes: text("notes"),
    status: text("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id").references(() => adminUser.id),
    shiftNumber: integer("shift_number").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const shiftOpenStockCount = pgTable("shift_open_stock_count", {
  id: uuid("id").primaryKey().defaultRandom(),
  shiftOpenId: uuid("shift_open_id")
    .notNull()
    .references(() => shiftOpen.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => product.id),
  variantId: uuid("variant_id").references(() => productVariant.id),
  systemQuantity: integer("system_quantity").notNull(),
  countedQuantity: integer("counted_quantity").notNull(),
  variance: integer("variance").notNull(),
  varianceReason: text("variance_reason"),
});

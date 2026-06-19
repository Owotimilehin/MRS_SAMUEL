import { pgTable, uuid, integer, text, timestamp, date, unique } from "drizzle-orm/pg-core";
import { branch } from "./branch.js";
import { product } from "./product.js";
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ branchDateUnique: unique().on(t.branchId, t.businessDate) }),
);

export const shiftOpenStockCount = pgTable("shift_open_stock_count", {
  id: uuid("id").primaryKey().defaultRandom(),
  shiftOpenId: uuid("shift_open_id")
    .notNull()
    .references(() => shiftOpen.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => product.id),
  systemQuantity: integer("system_quantity").notNull(),
  countedQuantity: integer("counted_quantity").notNull(),
  variance: integer("variance").notNull(),
  varianceReason: text("variance_reason"),
});

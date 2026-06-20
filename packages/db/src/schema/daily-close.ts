import { pgTable, uuid, integer, text, timestamp, pgEnum, date } from "drizzle-orm/pg-core";
import { branch } from "./branch.js";
import { product } from "./product.js";
import { adminUser } from "./admin-user.js";
import { shiftOpen } from "./shift-open.js";

export const dailyCloseStatus = pgEnum("daily_close_status", [
  "draft",
  "submitted",
  "approved",
  "disputed",
]);

export const dailyClose = pgTable(
  "daily_close",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: uuid("branch_id").notNull().references(() => branch.id),
    businessDate: date("business_date").notNull(),
    status: dailyCloseStatus("status").notNull().default("draft"),
    cashCountedNgn: integer("cash_counted_ngn").notNull().default(0),
    transfersCountedNgn: integer("transfers_counted_ngn").notNull().default(0),
    systemCashTotalNgn: integer("system_cash_total_ngn").notNull().default(0),
    varianceNgn: integer("variance_ngn").notNull().default(0),
    submittedByUserId: uuid("submitted_by_user_id").references(() => adminUser.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedByUserId: uuid("approved_by_user_id").references(() => adminUser.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    notes: text("notes"),
    shiftId: uuid("shift_id").references(() => shiftOpen.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const dailyCloseStockCount = pgTable("daily_close_stock_count", {
  id: uuid("id").primaryKey().defaultRandom(),
  dailyCloseId: uuid("daily_close_id")
    .notNull()
    .references(() => dailyClose.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => product.id),
  systemQuantity: integer("system_quantity").notNull(),
  countedQuantity: integer("counted_quantity").notNull(),
  variance: integer("variance").notNull(),
  varianceReason: text("variance_reason"),
});

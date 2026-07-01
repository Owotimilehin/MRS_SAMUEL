import { pgTable, uuid, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { saleOrder, paymentMethod, paymentStatus } from "./sale-order.js";
import { adminUser } from "./admin-user.js";

export const payment = pgTable("payment", {
  id: uuid("id").primaryKey().defaultRandom(),
  saleOrderId: uuid("sale_order_id")
    .notNull()
    .references(() => saleOrder.id, { onDelete: "cascade" }),
  method: paymentMethod("method").notNull(),
  amountNgn: integer("amount_ngn").notNull(),
  status: paymentStatus("status").notNull().default("pending"),
  processor: text("processor"),
  processorReference: text("processor_reference"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  feeNgn: integer("fee_ngn"),
  grossNgn: integer("gross_ngn"),
  netNgn: integer("net_ngn"),
  rawBreakdown: jsonb("raw_breakdown"),
  collectedByUserId: uuid("collected_by_user_id").references(() => adminUser.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

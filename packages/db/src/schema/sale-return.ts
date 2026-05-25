import { pgTable, uuid, text, integer, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { saleOrder, saleOrderItem } from "./sale-order.js";
import { branch } from "./branch.js";
import { product } from "./product.js";
import { adminUser } from "./admin-user.js";

export const returnStatus = pgEnum("return_status", [
  "draft",
  "pending_approval",
  "completed",
  "cancelled",
]);

export const returnReasonCategory = pgEnum("return_reason_category", [
  "changed_mind",
  "wrong_flavor",
  "wrong_item",
  "quality_issue",
  "damaged_on_arrival",
  "delivery_failed",
  "other_with_note",
]);

export const returnRefundMethod = pgEnum("return_refund_method", [
  "cash",
  "card_reversal",
  "transfer",
  "store_credit",
  "replacement",
  "chowdeck_external",
  "none",
]);

export const returnDisposition = pgEnum("return_disposition", [
  "restocked",
  "wasted",
  "replaced",
]);

export const saleReturn = pgTable("sale_return", {
  id: uuid("id").primaryKey().defaultRandom(),
  returnNumber: text("return_number").notNull().unique(),
  originalSaleOrderId: uuid("original_sale_order_id")
    .notNull()
    .references(() => saleOrder.id),
  branchId: uuid("branch_id").notNull().references(() => branch.id),
  channel: text("channel").notNull(),
  status: returnStatus("status").notNull().default("draft"),
  reasonCategory: returnReasonCategory("reason_category").notNull(),
  reasonNote: text("reason_note"),
  refundMethod: returnRefundMethod("refund_method").notNull(),
  refundAmountNgn: integer("refund_amount_ngn").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => adminUser.id),
  approvedByUserId: uuid("approved_by_user_id").references(() => adminUser.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  idempotencyKey: uuid("idempotency_key").notNull().unique(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const saleReturnItem = pgTable("sale_return_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  saleReturnId: uuid("sale_return_id")
    .notNull()
    .references(() => saleReturn.id, { onDelete: "cascade" }),
  saleOrderItemId: uuid("sale_order_item_id")
    .notNull()
    .references(() => saleOrderItem.id),
  productId: uuid("product_id").notNull().references(() => product.id),
  quantityReturned: integer("quantity_returned").notNull(),
  unitRefundNgn: integer("unit_refund_ngn").notNull(),
  disposition: returnDisposition("disposition").notNull(),
  photoUrls: jsonb("photo_urls").$type<string[]>().notNull().default([]),
});

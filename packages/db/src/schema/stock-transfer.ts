import { pgTable, uuid, integer, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { factory } from "./factory";
import { branch } from "./branch";
import { product } from "./product";
import { adminUser } from "./admin-user";

export const stockTransferStatus = pgEnum("stock_transfer_status", [
  "draft",
  "dispatched",
  "in_transit",
  "arrived",
  "received",
  "received_with_variance",
  "rejected",
  "completed",
  "cancelled",
]);

export const stockTransferVarianceReason = pgEnum("stock_transfer_variance_reason", [
  "short_shipped",
  "damaged_in_transit",
  "wrong_item",
  "extra_received",
  "count_error_at_branch",
  "other_with_note",
]);

/**
 * Human-readable transfer numbers (e.g. "TRF-2026-00042") come from a
 * dedicated postgres sequence created in a hand-written companion migration
 * (the sequence cannot be expressed via Drizzle alone).
 *
 * The domain layer reads the next value with:
 *   SELECT nextval('stock_transfer_seq')
 */
export const stockTransfer = pgTable("stock_transfer", {
  id: uuid("id").primaryKey().defaultRandom(),
  transferNumber: text("transfer_number").notNull().unique(),
  factoryId: uuid("factory_id").notNull().references(() => factory.id, { onDelete: "restrict" }),
  branchId: uuid("branch_id").notNull().references(() => branch.id, { onDelete: "restrict" }),
  status: stockTransferStatus("status").notNull().default("draft"),
  dispatchedByUserId: uuid("dispatched_by_user_id").references(() => adminUser.id),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  receivedByUserId: uuid("received_by_user_id").references(() => adminUser.id),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  approvedByUserId: uuid("approved_by_user_id").references(() => adminUser.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  rejectedByUserId: uuid("rejected_by_user_id").references(() => adminUser.id),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectReason: text("reject_reason"),
  vehicleInfo: text("vehicle_info"),
  driverName: text("driver_name"),
  manifestUrl: text("manifest_url"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stockTransferItem = pgTable("stock_transfer_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  stockTransferId: uuid("stock_transfer_id")
    .notNull()
    .references(() => stockTransfer.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => product.id, { onDelete: "restrict" }),
  quantitySent: integer("quantity_sent").notNull(),
  quantityReceived: integer("quantity_received"),
  varianceReason: stockTransferVarianceReason("variance_reason"),
  unitCostNgn: integer("unit_cost_ngn"),
  notes: text("notes"),
});

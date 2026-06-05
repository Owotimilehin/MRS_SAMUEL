import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  pgEnum,
  jsonb,
  index,
  numeric,
} from "drizzle-orm/pg-core";
import { saleOrder } from "./sale-order.js";
import { branch } from "./branch.js";

/**
 * Third-party delivery provider (today only Bolt; left as enum so adding
 * Glovo / Chowdeck Send / in-house dispatch is a one-line migration).
 */
export const deliveryProvider = pgEnum("delivery_provider", ["bolt", "manual", "shipbubble"]);

/**
 * Status machine for a delivery, parallel to (but distinct from) sale_order
 * lifecycle. A sale can have at most one ACTIVE delivery_order — re-tries
 * create new rows so we have full audit history.
 */
export const deliveryStatus = pgEnum("delivery_status", [
  "searching_rider",
  "assigned",
  "picked_up",
  "in_transit",
  "delivered",
  "failed",
  "cancelled",
]);

export const deliveryOrder = pgTable(
  "delivery_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleOrderId: uuid("sale_order_id")
      .notNull()
      .references(() => saleOrder.id, { onDelete: "cascade" }),
    provider: deliveryProvider("provider").notNull().default("bolt"),
    /** Provider's own id, e.g. "bolt_2026_xyz". Null until the request returns. */
    externalRef: text("external_ref"),
    status: deliveryStatus("status").notNull().default("searching_rider"),
    pickupBranchId: uuid("pickup_branch_id")
      .notNull()
      .references(() => branch.id),
    pickupAddress: text("pickup_address").notNull(),
    pickupLat: numeric("pickup_lat", { precision: 10, scale: 6 }),
    pickupLng: numeric("pickup_lng", { precision: 10, scale: 6 }),
    dropoffAddress: text("dropoff_address").notNull(),
    dropoffLat: numeric("dropoff_lat", { precision: 10, scale: 6 }),
    dropoffLng: numeric("dropoff_lng", { precision: 10, scale: 6 }),
    /** Fee quoted at order creation (what we charged the customer). */
    quotedFeeNgn: integer("quoted_fee_ngn").notNull(),
    /** Fee actually invoiced by the provider — set on completion. */
    actualFeeNgn: integer("actual_fee_ngn"),
    etaMinutes: integer("eta_minutes"),
    riderName: text("rider_name"),
    riderPhone: text("rider_phone"),
    riderVehicle: text("rider_vehicle"),
    /** Provider-hosted tracking page (shown to customer). */
    trackingUrl: text("tracking_url"),
    /**
     * Last raw webhook payload — kept for audit + replaying state if our
     * mapping ever drifts from the provider's.
     */
    rawWebhookJson: jsonb("raw_webhook_json"),
    failReason: text("fail_reason"),
    retryCount: integer("retry_count").notNull().default(0),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxSale: index("idx_delivery_sale").on(t.saleOrderId),
    idxStatus: index("idx_delivery_status").on(t.status, t.requestedAt),
    idxExternal: index("idx_delivery_external_ref").on(t.externalRef),
  }),
);

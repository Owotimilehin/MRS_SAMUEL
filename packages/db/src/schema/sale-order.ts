import { pgTable, uuid, text, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { branch } from "./branch.js";
import { customer } from "./customer.js";
import { product } from "./product.js";
import { productVariant } from "./product-variant.js";
import { productPrice } from "./product-price.js";
import { adminUser } from "./admin-user.js";

export const saleChannel = pgEnum("sale_channel", [
  "walkup",
  "online",
  "phone",
  "whatsapp",
  "chowdeck_pickup",
]);

export const saleStatus = pgEnum("sale_status", [
  "draft",
  "confirmed",
  "paid",
  "handed_over",
  "out_for_delivery",
  "delivered",
  "failed",
  "cancelled",
  "reconcile_needed",
]);

export const paymentMethod = pgEnum("payment_method", [
  "cash",
  "card",
  "transfer",
  "chowdeck_external",
  "replacement",
]);

export const paymentStatus = pgEnum("payment_status", [
  "pending",
  "paid",
  "failed",
  "refunded",
]);

/**
 * SaleOrder is the single record for any sale across all channels. The
 * idempotency_key is generated client-side BEFORE the order is even submitted,
 * so the same retry from an offline branch tablet maps to the same server row.
 */
export const saleOrder = pgTable("sale_order", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderNumber: text("order_number").notNull().unique(),
  branchId: uuid("branch_id").notNull().references(() => branch.id),
  channel: saleChannel("channel").notNull(),
  customerId: uuid("customer_id").references(() => customer.id),
  status: saleStatus("status").notNull().default("draft"),
  subtotalNgn: integer("subtotal_ngn").notNull(),
  deliveryFeeNgn: integer("delivery_fee_ngn").notNull().default(0),
  totalNgn: integer("total_ngn").notNull(),
  paymentMethod: paymentMethod("payment_method").notNull(),
  paymentStatus: paymentStatus("payment_status").notNull().default("pending"),
  createdAtLocal: timestamp("created_at_local", { withTimezone: true }).notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => adminUser.id),
  idempotencyKey: uuid("idempotency_key").notNull().unique(),
  externalReference: text("external_reference"),
  notes: text("notes"),
  cancelReason: text("cancel_reason"),
  cancelledByUserId: uuid("cancelled_by_user_id").references(() => adminUser.id),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  outForDeliveryAt: timestamp("out_for_delivery_at", { withTimezone: true }),
  // When set, the customer asked for a future delivery time.
  scheduledDeliveryAt: timestamp("scheduled_delivery_at", { withTimezone: true }),
  // Destination state. NULL or "Lagos" = in-area (Bolt dispatch). Any other
  // value = outside Lagos: automated dispatch is bypassed and delivery is ₦0.
  deliveryState: text("delivery_state"),
  deliveryProviderRef: text("delivery_provider_ref"),
  // The courier option the customer chose at checkout, encoded
  // `requestToken::courierId::serviceCode`. Passed to dispatch so we send the
  // exact courier they paid for (not the auto-cheapest).
  deliveryQuoteRef: text("delivery_quote_ref"),
  // The courier-validated dropoff captured at quote time. The address_code is
  // reused at dispatch so the rider routes to exactly the quoted+confirmed
  // address; the formatted string is what we show/store as the delivery address.
  deliveryAddressCode: text("delivery_address_code"),
  deliveryAddressFormatted: text("delivery_address_formatted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const saleOrderItem = pgTable("sale_order_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  saleOrderId: uuid("sale_order_id")
    .notNull()
    .references(() => saleOrder.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => product.id),
  variantId: uuid("variant_id").references(() => productVariant.id),
  productPriceId: uuid("product_price_id").notNull().references(() => productPrice.id),
  quantity: integer("quantity").notNull(),
  unitPriceNgn: integer("unit_price_ngn").notNull(),
  lineTotalNgn: integer("line_total_ngn").notNull(),
  notes: text("notes"),
});

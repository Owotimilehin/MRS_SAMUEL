import { pgTable, uuid, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";

/**
 * Append-only diagnostic log of customer checkout attempts. One row per stage
 * of a "Place order" press; rows of one press share `attemptId` (the checkout
 * idempotency key). Pruned after 30 days by the worker. Holds customer PII
 * (name/phone/email/address) — read access is owner-only. No payment/card data.
 */
export const checkoutAttemptLog = pgTable(
  "checkout_attempt_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: text("attempt_id").notNull(),
    stage: text("stage").notNull(),
    status: text("status").notNull(),
    orderNumber: text("order_number"),
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"),
    customerEmail: text("customer_email"),
    deliveryAddress: text("delivery_address"),
    deliveryState: text("delivery_state"),
    deliveryWindow: text("delivery_window"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    itemsJson: jsonb("items_json").$type<Array<Record<string, unknown>>>(),
    totalNgn: integer("total_ngn"),
    errorMessage: text("error_message"),
    responseJson: jsonb("response_json").$type<Record<string, unknown>>(),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxAttempt: index("idx_checkout_log_attempt").on(t.attemptId),
    idxCreated: index("idx_checkout_log_created").on(t.createdAt),
  }),
);

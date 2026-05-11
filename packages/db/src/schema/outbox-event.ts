import { pgTable, uuid, text, timestamp, jsonb, integer, index, pgEnum } from "drizzle-orm/pg-core";

export const outboxStatus = pgEnum("outbox_status", ["pending", "sent", "failed"]);

/**
 * Transactional outbox. Any side effect (Telegram message, email, push) is
 * written here inside the same DB transaction as the domain change that
 * caused it. A background worker drains pending rows, dispatches the side
 * effect, and marks the row as sent (or failed-and-retried).
 *
 * Conventions:
 *   - eventType is a dotted namespace: 'stock_transfer.dispatched',
 *     'sale.paid_online', 'daily_close.late', etc.
 *   - payload contains exactly the data the worker needs to format and
 *     dispatch the notification — including the entity id and a few denorm
 *     fields for the message body (transfer_number, branch_id, etc.).
 */
export const outboxEvent = pgTable(
  "outbox_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: outboxStatus("status").notNull().default("pending"),
    retries: integer("retries").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    idxStatus: index("idx_outbox_status").on(t.status, t.createdAt),
  }),
);

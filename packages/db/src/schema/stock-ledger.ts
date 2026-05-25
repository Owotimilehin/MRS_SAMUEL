import { pgTable, uuid, integer, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { product } from "./product.js";
import { productVariant } from "./product-variant.js";
import { adminUser } from "./admin-user.js";

export const ledgerLocationType = pgEnum("ledger_location_type", ["factory", "branch"]);

export const ledgerSourceType = pgEnum("ledger_source_type", [
  "production_run",
  "transfer_dispatch",
  "transfer_receive",
  "transfer_reject_reverse",
  "sale",
  "sale_cancelled",
  "return_restock",
  "waste",
  "adjustment",
  "count_correction",
  "opening_balance",
]);

/**
 * Append-only stock ledger. Every stock movement is one row.
 * Current balance at a location = SUM(delta) for that location + product.
 *
 * INVARIANTS (enforced by a deferred-immediate AFTER INSERT trigger applied
 * in a hand-written migration immediately after this schema's generated SQL):
 *   - Running balance for any (location_type, location_id, product_id) must
 *     never go negative. Trigger raises check_violation if it would.
 *   - Rows are append-only. The application's DB user is GRANT'd INSERT + SELECT
 *     only; UPDATE/DELETE are revoked.
 */
export const stockLedger = pgTable(
  "stock_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationType: ledgerLocationType("location_type").notNull(),
    locationId: uuid("location_id").notNull(),
    productId: uuid("product_id").notNull().references(() => product.id, { onDelete: "restrict" }),
    variantId: uuid("variant_id").references(() => productVariant.id, { onDelete: "restrict" }),
    delta: integer("delta").notNull(),
    sourceType: ledgerSourceType("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid("recorded_by_user_id").references(() => adminUser.id),
    note: text("note"),
  },
  (t) => ({
    idxLocProduct: index("idx_ledger_loc_product").on(t.locationType, t.locationId, t.productId),
    idxOccurred: index("idx_ledger_occurred").on(t.occurredAt),
    idxVariant: index("idx_ledger_variant").on(t.variantId),
  }),
);

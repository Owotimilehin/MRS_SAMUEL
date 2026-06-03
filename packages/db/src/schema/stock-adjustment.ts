import { pgTable, uuid, pgEnum, text, timestamp, index } from "drizzle-orm/pg-core";
import { adminUser } from "./admin-user.js";
import { ledgerLocationType } from "./stock-ledger.js";

/**
 * Reasons an owner can attach to a manual stock adjustment.
 * Mirrors the `variance_reason` taxonomy on transfer receipt so reporting
 * categories line up across the two flows.
 */
export const stockAdjustmentReason = pgEnum("stock_adjustment_reason", [
  "physical_recount",
  "damaged",
  "spoilage",
  "theft",
  "found",
  "opening_balance",
  "other_with_note",
]);

/**
 * Header for one owner-initiated inventory adjustment. Each header groups
 * N `stock_ledger` rows (one per product whose count changed). The ledger
 * row references this header via (source_type='adjustment', source_id=this.id).
 *
 * `reason_note` is REQUIRED when reason_code = 'other_with_note', enforced
 * by the Hono route's Zod refine — DB allows null.
 */
export const stockAdjustment = pgTable(
  "stock_adjustment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationType: ledgerLocationType("location_type").notNull(),
    locationId: uuid("location_id").notNull(),
    reasonCode: stockAdjustmentReason("reason_code").notNull(),
    reasonNote: text("reason_note"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => adminUser.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxLocation: index("idx_stock_adj_location").on(t.locationType, t.locationId),
    idxCreated: index("idx_stock_adj_created").on(t.createdAt),
  }),
);

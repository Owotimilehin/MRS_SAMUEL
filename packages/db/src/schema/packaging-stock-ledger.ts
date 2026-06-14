import { pgTable, uuid, integer, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { factory } from "./factory.js";
import { packagingMaterial } from "./packaging-material.js";
import { adminUser } from "./admin-user.js";
import { ledgerLocationType } from "./stock-ledger.js";

export const packagingLedgerSourceType = pgEnum("packaging_ledger_source_type", [
  "purchase",
  "consumption",
  "adjustment",
  "opening_balance",
]);

/**
 * Append-only movement log for packaging stock. Balance at a factory for a
 * material = SUM(delta) where (factory_id, packaging_material_id) match.
 *
 * INVARIANT: an AFTER INSERT trigger (in the 0032 migration) recomputes the
 * running balance and raises check_violation if it would go negative.
 */
export const packagingStockLedger = pgTable(
  "packaging_stock_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    factoryId: uuid("factory_id").references(() => factory.id, { onDelete: "restrict" }),
    locationType: ledgerLocationType("location_type").notNull(),
    locationId: uuid("location_id").notNull(),
    packagingMaterialId: uuid("packaging_material_id")
      .notNull()
      .references(() => packagingMaterial.id, { onDelete: "restrict" }),
    delta: integer("delta").notNull(),
    sourceType: packagingLedgerSourceType("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid("recorded_by_user_id").references(() => adminUser.id),
    note: text("note"),
  },
  (t) => ({
    idxFactoryMaterial: index("idx_pkg_ledger_factory_material").on(
      t.factoryId,
      t.packagingMaterialId,
    ),
    idxOccurred: index("idx_pkg_ledger_occurred").on(t.occurredAt),
    idxLocationMaterial: index("idx_pkg_ledger_location_material").on(
      t.locationType, t.locationId, t.packagingMaterialId,
    ),
  }),
);

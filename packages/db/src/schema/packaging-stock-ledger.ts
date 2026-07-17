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
  // Bag movements between factory and branch (Workstream A2b).
  "transfer_dispatch",
  "transfer_receive",
  "transfer_reject_reverse",
  // Owner relocates a bag transfer variance back to factory/branch stock.
  "transfer_variance_settlement",
]);

/**
 * Append-only movement log for packaging stock. Location-aware since 0044:
 * balance at a location for a material = SUM(delta) where
 * (location_type, location_id, packaging_material_id) match. `location_type`
 * is 'factory' or 'branch' (bottles live at factories; bags can live at
 * either). `factory_id` is retained for factory rows for back-compat.
 *
 * INVARIANT: an AFTER INSERT trigger (function re-keyed in the 0044 migration)
 * recomputes the running balance per (location_type, location_id, material)
 * and raises check_violation if it would go negative.
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

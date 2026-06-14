import { pgTable, uuid, text, integer, boolean, timestamp, index, pgEnum } from "drizzle-orm/pg-core";

export const packagingMaterialKind = pgEnum("packaging_material_kind", [
  "bottle",
  "bag",
  "other",
]);

/**
 * Catalog of packaging materials. `kind` classifies each row: 'bottle' (sized,
 * consumed by production), 'bag' (unsized, consumed at the POS), or 'other'.
 * Seeded: 330ml/650ml glass bottles + Small/Medium/Large bags (0043/0044).
 *
 * `size_ml` is nullable so non-sized materials (caps, labels) coexist.
 */
export const packagingMaterial = pgTable(
  "packaging_material",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    unitLabel: text("unit_label").notNull(),
    sizeMl: integer("size_ml"),
    kind: packagingMaterialKind("kind").notNull().default("other"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxActive: index("idx_packaging_material_active").on(t.isActive),
  }),
);

import { pgTable, uuid, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Catalog of packaging materials a factory can consume. MVP seeds two rows
 * (330ml glass bottle, 650ml glass bottle); caps + labels go in later as
 * additional rows without code changes.
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
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxActive: index("idx_packaging_material_active").on(t.isActive),
  }),
);

-- Per-size low-stock alert level. Additive only: one nullable column on
-- product_variant, so it is safe on the live table. Safe to run twice.
--   product_variant.low_stock_level  stock at or below this counts as "running low"
--                                     for this size at a location; null = the default of 10
-- Undo: ALTER TABLE "product_variant" DROP COLUMN IF EXISTS "low_stock_level";
--       (dropping the column drops its CHECK constraint with it)

ALTER TABLE "product_variant" ADD COLUMN IF NOT EXISTS "low_stock_level" integer CHECK ("low_stock_level" >= 0);

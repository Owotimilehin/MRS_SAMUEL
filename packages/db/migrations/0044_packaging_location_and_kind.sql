-- A2a foundation: classify packaging materials by kind, seed the 3 bag sizes,
-- and make packaging_stock_ledger location-aware (factory AND branch) so bags
-- can later move factory→branch (A2b) and be consumed at a branch POS (A2c).

-- 1) packaging_material.kind
CREATE TYPE "packaging_material_kind" AS ENUM ('bottle', 'bag', 'other');

ALTER TABLE "packaging_material"
  ADD COLUMN "kind" "packaging_material_kind" NOT NULL DEFAULT 'other';

-- Existing sized materials are the bottles.
UPDATE "packaging_material" SET kind = 'bottle' WHERE size_ml IS NOT NULL;

-- 2) Seed the three bag sizes (idempotent: skip if a bag of that name exists).
INSERT INTO "packaging_material" (name, unit_label, size_ml, is_active, kind)
SELECT v.name, 'bag', NULL, true, 'bag'
FROM (VALUES ('Small Bag'), ('Medium Bag'), ('Large Bag')) AS v(name)
WHERE NOT EXISTS (
  SELECT 1 FROM "packaging_material" m WHERE m.kind = 'bag' AND m.name = v.name
);

-- 3) Location-aware packaging_stock_ledger.
--    Reuse the finished-goods location enum (factory|branch).
ALTER TABLE "packaging_stock_ledger"
  ADD COLUMN "location_type" "ledger_location_type",
  ADD COLUMN "location_id"   uuid;

-- Backfill every existing row to its factory.
UPDATE "packaging_stock_ledger"
  SET location_type = 'factory', location_id = factory_id
  WHERE location_type IS NULL;

ALTER TABLE "packaging_stock_ledger"
  ALTER COLUMN "location_type" SET NOT NULL,
  ALTER COLUMN "location_id"   SET NOT NULL;

-- factory_id is now optional (branch rows have no factory); keep it populated
-- for factory rows this release for back-compat, drop in a later cleanup.
ALTER TABLE "packaging_stock_ledger"
  ALTER COLUMN "factory_id" DROP NOT NULL;

-- 4) Re-key the non-negative balance trigger on (location_type, location_id, material).
CREATE OR REPLACE FUNCTION packaging_ledger_check_balance() RETURNS trigger AS $$
DECLARE
  current_sum integer;
BEGIN
  SELECT COALESCE(SUM(delta), 0) INTO current_sum
    FROM packaging_stock_ledger
    WHERE location_type        = NEW.location_type
      AND location_id          = NEW.location_id
      AND packaging_material_id = NEW.packaging_material_id;
  IF current_sum < 0 THEN
    RAISE EXCEPTION
      'packaging_stock_ledger negative balance: location_type=% location_id=% material_id=% sum=%',
      NEW.location_type, NEW.location_id, NEW.packaging_material_id, current_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5) Covering index for the new grouping.
CREATE INDEX IF NOT EXISTS idx_pkg_ledger_location_material
  ON packaging_stock_ledger (location_type, location_id, packaging_material_id);

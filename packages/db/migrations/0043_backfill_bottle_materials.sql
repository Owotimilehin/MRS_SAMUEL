-- Bottles never reduced on production because no bottle materials existed and
-- no variant was linked to one (product_variant.bottle_material_id was always
-- NULL → the /complete consumption loop skipped every item). This migration is
-- idempotent: it ensures the two bottle materials exist, then links every
-- variant to the material matching its size.

-- 1) Ensure the 330ml and 650ml glass bottle materials exist (match by size_ml
--    so a manually-created row is reused rather than duplicated).
INSERT INTO packaging_material (name, unit_label, size_ml, is_active)
SELECT '330ml Glass Bottle', 'bottle', 330, true
WHERE NOT EXISTS (
  SELECT 1 FROM packaging_material WHERE size_ml = 330
);

INSERT INTO packaging_material (name, unit_label, size_ml, is_active)
SELECT '650ml Glass Bottle', 'bottle', 650, true
WHERE NOT EXISTS (
  SELECT 1 FROM packaging_material WHERE size_ml = 650
);

-- 2) Backfill: link each variant with no bottle yet to the bottle material whose
--    size_ml matches the variant's size. Picks the lowest id if (somehow) there
--    are duplicate materials for a size, so the result is deterministic.
UPDATE product_variant pv
SET bottle_material_id = m.id
FROM (
  SELECT DISTINCT ON (size_ml) id, size_ml
  FROM packaging_material
  WHERE size_ml IS NOT NULL
  ORDER BY size_ml, id
) m
WHERE pv.bottle_material_id IS NULL
  AND pv.size_ml = m.size_ml;

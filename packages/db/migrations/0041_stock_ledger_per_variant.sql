-- Phase 1 of per-size stock tracking. The ledger already has variant_id; this
-- migration makes the NON-NEGATIVE invariant operate per (location, product,
-- variant) instead of per (location, product), and auto-assigns legacy
-- NULL-variant balances to a flavour's sole variant where unambiguous.
--
-- IMPORTANT: NULL-variant rows are a distinct bucket. `variant_id = X` and
-- `variant_id IS NULL` never merge, so multi-size flavours keep their old
-- pooled balance under the NULL bucket until staff recount (see admin UI).

-- 1) Retarget the balance-check trigger function. NULL variant_id is compared
--    with `IS NOT DISTINCT FROM` so the NULL bucket is summed on its own.
CREATE OR REPLACE FUNCTION stock_ledger_check_balance() RETURNS trigger AS $$
DECLARE
  current_sum integer;
BEGIN
  SELECT COALESCE(SUM(delta), 0) INTO current_sum
    FROM stock_ledger
    WHERE location_type = NEW.location_type
      AND location_id   = NEW.location_id
      AND product_id    = NEW.product_id
      AND variant_id IS NOT DISTINCT FROM NEW.variant_id;
  IF current_sum < 0 THEN
    RAISE EXCEPTION
      'stock_ledger negative balance: location_type=% location_id=% product_id=% variant_id=% sum=%',
      NEW.location_type, NEW.location_id, NEW.product_id, NEW.variant_id, current_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2) Auto-assign legacy NULL-variant balances for SINGLE-variant flavours.
--    For each such flavour at each location, post a paired correction: move the
--    NULL-bucket balance onto the sole active variant. Multi-variant flavours
--    are intentionally skipped (left as a NULL "needs recount" bucket).
WITH single_variant AS (
  SELECT pv.product_id, MIN(pv.id::text)::uuid AS variant_id
  FROM product_variant pv
  WHERE pv.deleted_at IS NULL
  GROUP BY pv.product_id
  HAVING COUNT(*) = 1
),
null_bucket AS (
  SELECT sl.location_type, sl.location_id, sl.product_id,
         COALESCE(SUM(sl.delta), 0)::int AS bal
  FROM stock_ledger sl
  WHERE sl.variant_id IS NULL
  GROUP BY sl.location_type, sl.location_id, sl.product_id
  HAVING COALESCE(SUM(sl.delta), 0) <> 0
)
INSERT INTO stock_ledger
  (location_type, location_id, product_id, variant_id, delta, source_type, source_id, note)
SELECT nb.location_type, nb.location_id, nb.product_id, sv.variant_id,
       nb.bal, 'count_correction', gen_random_uuid(),
       'Phase1 auto-assign NULL bucket to sole variant'
FROM null_bucket nb
JOIN single_variant sv ON sv.product_id = nb.product_id;

-- Mirror: drain the NULL bucket by the same amount so totals are conserved.
WITH single_variant AS (
  SELECT pv.product_id, MIN(pv.id::text)::uuid AS variant_id
  FROM product_variant pv
  WHERE pv.deleted_at IS NULL
  GROUP BY pv.product_id
  HAVING COUNT(*) = 1
),
null_bucket AS (
  SELECT sl.location_type, sl.location_id, sl.product_id,
         COALESCE(SUM(sl.delta), 0)::int AS bal
  FROM stock_ledger sl
  WHERE sl.variant_id IS NULL
  GROUP BY sl.location_type, sl.location_id, sl.product_id
  HAVING COALESCE(SUM(sl.delta), 0) <> 0
)
INSERT INTO stock_ledger
  (location_type, location_id, product_id, variant_id, delta, source_type, source_id, note)
SELECT nb.location_type, nb.location_id, nb.product_id, NULL,
       -nb.bal, 'count_correction', gen_random_uuid(),
       'Phase1 drain NULL bucket (moved to sole variant)'
FROM null_bucket nb
JOIN single_variant sv ON sv.product_id = nb.product_id;

-- 3) Covering index for the new grouping.
CREATE INDEX IF NOT EXISTS idx_ledger_loc_product_variant
  ON stock_ledger (location_type, location_id, product_id, variant_id);

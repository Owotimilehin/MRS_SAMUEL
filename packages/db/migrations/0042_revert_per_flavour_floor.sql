-- Revert the non-negative-balance floor from per-(location, product, variant)
-- back to per-(location, product). Per-size ENFORCEMENT is deferred until all
-- stock write paths (transfers, POS) are size-aware; enforcing per-size now
-- rejects legitimate sales because inbound stock (transfers) lands in the
-- NULL/no-size bucket while sales debit a concrete variant.
--
-- We KEEP migration 0041's covering index (idx_ledger_loc_product_variant) and
-- its one-time backfill (single-variant NULL buckets moved onto the sole
-- variant) — both are harmless under a per-flavour floor and useful for the
-- per-size READ/reporting path that ships now.

CREATE OR REPLACE FUNCTION stock_ledger_check_balance() RETURNS trigger AS $$
DECLARE
  current_sum integer;
BEGIN
  SELECT COALESCE(SUM(delta), 0) INTO current_sum
    FROM stock_ledger
    WHERE location_type = NEW.location_type
      AND location_id   = NEW.location_id
      AND product_id    = NEW.product_id;
  IF current_sum < 0 THEN
    RAISE EXCEPTION
      'stock_ledger negative balance: location_type=% location_id=% product_id=% sum=%',
      NEW.location_type, NEW.location_id, NEW.product_id, current_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

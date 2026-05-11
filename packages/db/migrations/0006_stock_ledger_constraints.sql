-- Hand-written companion to 0005_goofy_ricochet.sql (the drizzle-generated
-- stock_ledger schema). Adds two invariants that cannot be expressed in
-- the Drizzle schema language:
--
--   1) The application's DB user can INSERT and SELECT but NOT UPDATE or
--      DELETE — making the ledger truly append-only at the role level.
--      (Migrations run as the DB owner role, so they retain full DDL.)
--
--   2) An AFTER INSERT trigger that recomputes the running balance for the
--      affected (location_type, location_id, product_id) tuple and raises
--      a check_violation if the new total is negative.
--
-- The trigger is DEFERRABLE INITIALLY IMMEDIATE so a transaction that
-- inserts a negative-delta row first and a positive-delta row second
-- (rare, but legal in domain logic) still gets checked correctly.

REVOKE UPDATE, DELETE ON stock_ledger FROM PUBLIC;

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

CREATE CONSTRAINT TRIGGER stock_ledger_balance_check
  AFTER INSERT ON stock_ledger
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW
  EXECUTE FUNCTION stock_ledger_check_balance();

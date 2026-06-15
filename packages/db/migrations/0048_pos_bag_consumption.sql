-- POS bags (Workstream A2c). A walk-up sale can hand the customer a bag. Bags
-- are TRACKED-ONLY, not charged: we record what went out and decrement the
-- branch bag estimate, but we never block a sale on bag stock.
--
-- To honour "warn-but-allow" the non-negative trigger now guards FACTORY
-- packaging only (authoritative bottle/bag inventory). BRANCH packaging is a
-- tracked estimate and may legitimately go negative when bags are handed out
-- faster than receipts are recorded.
CREATE OR REPLACE FUNCTION packaging_ledger_check_balance() RETURNS trigger AS $$
DECLARE
  current_sum integer;
BEGIN
  -- Branch packaging (bags) is tracked-only — allow it to go negative.
  IF NEW.location_type <> 'factory' THEN
    RETURN NEW;
  END IF;
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
--> statement-breakpoint

-- One row per bag handed out on a sale. The authoritative record of bag usage
-- (the packaging ledger is only the running estimate it decrements).
CREATE TABLE IF NOT EXISTS "sale_order_packaging" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sale_order_id" uuid NOT NULL REFERENCES "sale_order"("id") ON DELETE CASCADE,
  "packaging_material_id" uuid NOT NULL REFERENCES "packaging_material"("id") ON DELETE RESTRICT,
  "quantity" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sale_order_packaging_order"
  ON "sale_order_packaging" ("sale_order_id");

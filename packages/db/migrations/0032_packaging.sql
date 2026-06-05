-- Packaging inventory: bottles (and later caps + labels) tracked separately
-- from finished products. See docs/superpowers/specs/2026-06-05-packaging-inventory-design.md

-- 1. packaging_material — catalog
CREATE TABLE "packaging_material" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"        text NOT NULL,
  "unit_label"  text NOT NULL,
  "size_ml"     integer,
  "is_active"   boolean NOT NULL DEFAULT true,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "idx_packaging_material_active" ON "packaging_material" ("is_active");

-- 2. packaging_ledger_source_type enum + packaging_stock_ledger table
CREATE TYPE "packaging_ledger_source_type" AS ENUM (
  'purchase', 'consumption', 'adjustment', 'opening_balance'
);

CREATE TABLE "packaging_stock_ledger" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "factory_id"            uuid NOT NULL REFERENCES "factory"("id") ON DELETE RESTRICT,
  "packaging_material_id" uuid NOT NULL REFERENCES "packaging_material"("id") ON DELETE RESTRICT,
  "delta"                 integer NOT NULL,
  "source_type"           "packaging_ledger_source_type" NOT NULL,
  "source_id"             uuid NOT NULL,
  "occurred_at"           timestamptz NOT NULL DEFAULT now(),
  "recorded_by_user_id"   uuid REFERENCES "admin_user"("id"),
  "note"                  text
);
CREATE INDEX "idx_pkg_ledger_factory_material"
  ON "packaging_stock_ledger" ("factory_id", "packaging_material_id");
CREATE INDEX "idx_pkg_ledger_occurred"
  ON "packaging_stock_ledger" ("occurred_at");

-- 3. Non-negative balance trigger (same pattern as stock_ledger).
CREATE OR REPLACE FUNCTION packaging_ledger_check_balance() RETURNS trigger AS $$
DECLARE
  current_sum integer;
BEGIN
  SELECT COALESCE(SUM(delta), 0) INTO current_sum
    FROM packaging_stock_ledger
    WHERE factory_id            = NEW.factory_id
      AND packaging_material_id = NEW.packaging_material_id;
  IF current_sum < 0 THEN
    RAISE EXCEPTION
      'packaging_stock_ledger negative balance: factory_id=% material_id=% sum=%',
      NEW.factory_id, NEW.packaging_material_id, current_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER packaging_ledger_balance_check
  AFTER INSERT ON packaging_stock_ledger
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW
  EXECUTE FUNCTION packaging_ledger_check_balance();

REVOKE UPDATE, DELETE ON "packaging_stock_ledger" FROM PUBLIC;

-- 4. packaging_purchase — purchase header
CREATE TABLE "packaging_purchase" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "factory_id"            uuid NOT NULL REFERENCES "factory"("id") ON DELETE RESTRICT,
  "packaging_material_id" uuid NOT NULL REFERENCES "packaging_material"("id") ON DELETE RESTRICT,
  "quantity"              integer NOT NULL,
  "unit_cost_ngn"         integer NOT NULL,
  "total_cost_ngn"        integer NOT NULL,
  "supplier_name"         text,
  "purchase_date"         date NOT NULL,
  "business_expense_id"   uuid REFERENCES "business_expense"("id"),
  "recorded_by_user_id"   uuid REFERENCES "admin_user"("id"),
  "created_at"            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "idx_packaging_purchase_factory_date"
  ON "packaging_purchase" ("factory_id", "purchase_date" DESC);

-- 5. product_variant.bottle_material_id (nullable FK)
ALTER TABLE "product_variant"
  ADD COLUMN "bottle_material_id" uuid REFERENCES "packaging_material"("id");

-- 6. production_run_item.variant_id (nullable FK; historical rows stay NULL)
ALTER TABLE "production_run_item"
  ADD COLUMN "variant_id" uuid REFERENCES "product_variant"("id");

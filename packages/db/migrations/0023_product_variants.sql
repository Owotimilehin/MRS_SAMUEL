-- Additive: introduce product_variant so a flavor can carry multiple sizes
-- (330ml can, 650ml bottle) with independent prices and stock. Existing
-- product_id columns stay; a nullable variant_id is added alongside and
-- backfilled. Follow-up PR wires the catalog API, checkout, and POS to
-- address variants explicitly.

CREATE TABLE IF NOT EXISTS "product_variant" (
    "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "product_id"  uuid NOT NULL REFERENCES "product"("id") ON DELETE RESTRICT,
    "size_ml"     integer NOT NULL,
    "sku"         text NOT NULL,
    "is_active"   boolean NOT NULL DEFAULT true,
    "created_at"  timestamptz NOT NULL DEFAULT now(),
    "updated_at"  timestamptz NOT NULL DEFAULT now(),
    "deleted_at"  timestamptz,
    CONSTRAINT "uq_product_variant_sku"          UNIQUE ("sku"),
    CONSTRAINT "uq_product_variant_product_size" UNIQUE ("product_id", "size_ml")
);

CREATE INDEX IF NOT EXISTS "idx_product_variant_product" ON "product_variant" ("product_id");

--> statement-breakpoint

-- Backfill: one variant per existing product, carrying its current size.
-- Existing seed sets product.size_ml = 330 for every flavor; COALESCE keeps
-- the migration safe if anything later inserted a NULL.
INSERT INTO "product_variant" ("product_id", "size_ml", "sku")
SELECT
    p."id",
    COALESCE(p."size_ml", 330),
    p."slug" || '-' || COALESCE(p."size_ml", 330) || 'ml'
FROM "product" p
WHERE NOT EXISTS (
    SELECT 1 FROM "product_variant" v WHERE v."product_id" = p."id"
);

--> statement-breakpoint

-- Add nullable variant_id to every table that keys off product today.
-- Kept nullable on purpose so legacy inserts (which only set product_id)
-- keep working until the follow-up PR migrates writers.
ALTER TABLE "product_price"
    ADD COLUMN IF NOT EXISTS "variant_id" uuid REFERENCES "product_variant"("id") ON DELETE RESTRICT;

ALTER TABLE "stock_ledger"
    ADD COLUMN IF NOT EXISTS "variant_id" uuid REFERENCES "product_variant"("id") ON DELETE RESTRICT;

ALTER TABLE "stock_reservation"
    ADD COLUMN IF NOT EXISTS "variant_id" uuid REFERENCES "product_variant"("id");

ALTER TABLE "sale_order_item"
    ADD COLUMN IF NOT EXISTS "variant_id" uuid REFERENCES "product_variant"("id");

--> statement-breakpoint

-- Backfill variant_id from product_id (every product has exactly one variant
-- after the insert above, so the join is unambiguous).
UPDATE "product_price" pp
SET "variant_id" = v."id"
FROM "product_variant" v
WHERE v."product_id" = pp."product_id" AND pp."variant_id" IS NULL;

UPDATE "stock_ledger" sl
SET "variant_id" = v."id"
FROM "product_variant" v
WHERE v."product_id" = sl."product_id" AND sl."variant_id" IS NULL;

UPDATE "stock_reservation" sr
SET "variant_id" = v."id"
FROM "product_variant" v
WHERE v."product_id" = sr."product_id" AND sr."variant_id" IS NULL;

UPDATE "sale_order_item" si
SET "variant_id" = v."id"
FROM "product_variant" v
WHERE v."product_id" = si."product_id" AND si."variant_id" IS NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_price_variant"       ON "product_price"     ("variant_id");
CREATE INDEX IF NOT EXISTS "idx_ledger_variant"      ON "stock_ledger"      ("variant_id");
CREATE INDEX IF NOT EXISTS "idx_reservation_variant" ON "stock_reservation" ("variant_id");
CREATE INDEX IF NOT EXISTS "idx_sale_item_variant"   ON "sale_order_item"   ("variant_id");

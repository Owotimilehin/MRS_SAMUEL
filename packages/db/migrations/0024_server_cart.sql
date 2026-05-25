-- Server-side anonymous cart. One row per cart, identified by a cookie UUID.
-- Lines reference product_variant so price/size are unambiguous.

CREATE TABLE IF NOT EXISTS "cart" (
    "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS "idx_cart_expires" ON "cart" ("expires_at");

CREATE TABLE IF NOT EXISTS "cart_line" (
    "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "cart_id"     uuid NOT NULL REFERENCES "cart"("id") ON DELETE CASCADE,
    "variant_id"  uuid NOT NULL REFERENCES "product_variant"("id") ON DELETE RESTRICT,
    "quantity"    integer NOT NULL CHECK ("quantity" > 0),
    "added_at"    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "uq_cart_line_variant" UNIQUE ("cart_id", "variant_id")
);

CREATE INDEX IF NOT EXISTS "idx_cart_line_cart" ON "cart_line" ("cart_id");

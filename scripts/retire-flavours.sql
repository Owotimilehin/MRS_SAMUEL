-- Retire Tropical Mango and Nourish Blend.
--
-- SOFT delete, deliberately. A hard DELETE would orphan the variant_id foreign
-- keys on every historical sale_order_item, breaking past reports, FIFO
-- packaging costing and the P&L. This does exactly what the admin "Delete"
-- button does (DELETE /v1/products/:id): stamps deleted_at + is_active = false
-- on the product and every one of its sizes. Sales history is untouched.
--
-- Reversible: set deleted_at = NULL and is_active = true on the same rows.
--
-- HOW TO RUN (on the prod droplet):
--   psql "$DATABASE_URL" -f scripts/retire-flavours.sql
--
-- It prints what it will do, does it in one transaction, then prints the
-- result. Nothing is removed if the slugs do not match — check the first
-- output block before trusting the second.

\echo '=== BEFORE: products matching the target slugs ==='
SELECT slug, name, is_active, deleted_at
FROM product
WHERE slug IN ('tropical-mango', 'nourish-blend')
ORDER BY slug;

BEGIN;

WITH targets AS (
  SELECT id FROM product
  WHERE slug IN ('tropical-mango', 'nourish-blend')
    AND deleted_at IS NULL
)
UPDATE product_variant v
SET deleted_at = now(), is_active = false
FROM targets t
WHERE v.product_id = t.id
  AND v.deleted_at IS NULL;

UPDATE product
SET deleted_at = now(), is_active = false, updated_at = now()
WHERE slug IN ('tropical-mango', 'nourish-blend')
  AND deleted_at IS NULL;

COMMIT;

\echo '=== AFTER: both should show is_active = f and a deleted_at timestamp ==='
SELECT p.slug, p.name, p.is_active, p.deleted_at,
       count(v.id) FILTER (WHERE v.deleted_at IS NOT NULL) AS sizes_retired,
       count(v.id) FILTER (WHERE v.deleted_at IS NULL)     AS sizes_still_live
FROM product p
LEFT JOIN product_variant v ON v.product_id = p.id
WHERE p.slug IN ('tropical-mango', 'nourish-blend')
GROUP BY p.slug, p.name, p.is_active, p.deleted_at
ORDER BY p.slug;

\echo '=== Historical sales referencing these flavours (must be UNCHANGED) ==='
SELECT p.slug, count(i.id) AS order_lines
FROM product p
JOIN sale_order_item i ON i.product_id = p.id
WHERE p.slug IN ('tropical-mango', 'nourish-blend')
GROUP BY p.slug
ORDER BY p.slug;

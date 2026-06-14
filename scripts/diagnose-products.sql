-- READ ONLY. Lists every product with on-hand stock and lifetime units sold,
-- so junk "atrocity" rows can be reconciled against the 20-flavour menu.
-- Run against prod with a read-only role:  psql "$DATABASE_URL" -f scripts/diagnose-products.sql
SELECT
  p.id,
  p.name,
  p.slug,
  p.is_active,
  p.deleted_at,
  COALESCE(oh.on_hand, 0)        AS on_hand,
  COALESCE(sold.units_sold, 0)   AS units_sold,
  p.created_at
FROM product p
LEFT JOIN (
  SELECT product_id, SUM(delta)::int AS on_hand
  FROM stock_ledger
  GROUP BY product_id
) oh ON oh.product_id = p.id
LEFT JOIN (
  SELECT i.product_id, SUM(i.quantity)::int AS units_sold
  FROM sale_order_item i
  JOIN sale_order o ON o.id = i.sale_order_id
  WHERE o.status IN ('paid','handed_over','delivered')
  GROUP BY i.product_id
) sold ON sold.product_id = p.id
ORDER BY (p.name ~ '^[0-9a-f]{8}$') DESC, on_hand DESC;

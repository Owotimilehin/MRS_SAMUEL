-- Task 7 (post-deploy): confirm Payaza's REAL fee/settlement field names.
--
-- Run this against the PRODUCTION DB after the first real card order is paid
-- following deploy of migration 0063. It prints the verbatim JSON Payaza
-- returned (captured into payment.raw_breakdown by the enriched parser) plus
-- the derived columns, so you can see exactly which keys carry the fee and the
-- settled amount.
--
--   psql "$DATABASE_URL" -f scripts/payaza-fee-fields-check.sql
--
-- What to look for in raw_breakdown->'data':
--   * the FEE key — parser currently reads: fee, charge, transaction_fee, processor_fee
--   * the SETTLEMENT key — parser currently reads: settlement_amount, amount_settled
-- If Payaza uses a different key, add it to parsePayazaBody() in
-- apps/api/src/payments/payaza.ts (the num(d.<key>) ?? ... chains) so `net_ngn`
-- becomes exact instead of falling back to gross>=total.

SELECT
  so.order_number,
  so.total_ngn         AS product_total,
  p.gross_ngn          AS customer_paid,
  p.fee_ngn            AS payaza_fee,
  p.net_ngn            AS net_settled,
  so.fee_shortfall_ngn AS shortfall,
  p.processor_reference,
  p.paid_at,
  jsonb_pretty(p.raw_breakdown) AS payaza_raw
FROM payment p
JOIN sale_order so ON so.id = p.sale_order_id
WHERE p.processor = 'payaza'
  AND p.raw_breakdown IS NOT NULL
ORDER BY p.paid_at DESC NULLS LAST
LIMIT 5;

-- READ ONLY. Explains a branch's "System expected cash" figure on a daily close.
-- It mirrors packages/domain/src/daily-close.ts:expectedCashForDay() exactly, so
-- the rows it lists are precisely what sums into the number the cashier sees.
--
-- Use it when the close shows expected cash but "no sale was made" on the POS:
-- the most common culprits are an ONLINE "pay-on-delivery" / WHATSAPP cash order
-- attributed to the branch, or a leftover test/seed order.
--
--   psql "$DATABASE_URL" \
--     -v branch_id="'<branch-uuid>'" \
--     -v bdate="'2026-06-14'" \
--     -f scripts/diagnose-expected-cash.sql
--
-- NOTE on the day window: the app computes [start, end) from the SERVER timezone
-- (UTC in prod), not Africa/Lagos (WAT, UTC+1). A sale rung up just after WAT
-- midnight can therefore land in the previous UTC day. The third query surfaces
-- any order within ±90 min of the window edges so you can spot boundary bleed.

\echo '== 1. Cash orders counted INTO expected cash (matches expectedCashForDay) =='
SELECT
  o.order_number,
  o.channel,
  o.status,
  o.total_ngn,
  o.created_at_local                                   AS created_utc,
  o.created_at_local AT TIME ZONE 'Africa/Lagos'       AS created_wat,
  o.external_reference,
  o.id
FROM sale_order o
WHERE o.branch_id = :branch_id
  AND o.payment_method = 'cash'
  AND o.status IN ('paid','handed_over','delivered')
  AND o.created_at_local >= (:bdate)::timestamptz
  AND o.created_at_local <  ((:bdate)::date + 1)::timestamptz
ORDER BY o.created_at_local;

\echo '== 2. Totals: gross cash sales, cash refunds, and the net expected figure =='
WITH gross AS (
  SELECT COALESCE(SUM(total_ngn), 0)::int AS cash_sales
  FROM sale_order
  WHERE branch_id = :branch_id AND payment_method = 'cash'
    AND status IN ('paid','handed_over','delivered')
    AND created_at_local >= (:bdate)::timestamptz
    AND created_at_local <  ((:bdate)::date + 1)::timestamptz
), refunds AS (
  SELECT COALESCE(SUM(refund_amount_ngn), 0)::int AS cash_refunds
  FROM sale_return
  WHERE branch_id = :branch_id AND refund_method = 'cash'
    AND status = 'completed'
    AND created_at >= (:bdate)::timestamptz
    AND created_at <  ((:bdate)::date + 1)::timestamptz
)
SELECT
  g.cash_sales,
  r.cash_refunds,
  (g.cash_sales - r.cash_refunds) AS expected_cash_ngn
FROM gross g, refunds r;

\echo '== 3. Channel breakdown — reveals non-POS cash (online / whatsapp) at a glance =='
SELECT
  channel,
  COUNT(*)                  AS orders,
  SUM(total_ngn)::int       AS cash_ngn
FROM sale_order
WHERE branch_id = :branch_id AND payment_method = 'cash'
  AND status IN ('paid','handed_over','delivered')
  AND created_at_local >= (:bdate)::timestamptz
  AND created_at_local <  ((:bdate)::date + 1)::timestamptz
GROUP BY channel
ORDER BY cash_ngn DESC;

\echo '== 4. Boundary bleed — cash orders within 90 min of either day edge (UTC vs WAT) =='
SELECT
  o.order_number,
  o.channel,
  o.status,
  o.total_ngn,
  o.created_at_local                              AS created_utc,
  o.created_at_local AT TIME ZONE 'Africa/Lagos'  AS created_wat
FROM sale_order o
WHERE o.branch_id = :branch_id
  AND o.payment_method = 'cash'
  AND o.status IN ('paid','handed_over','delivered')
  AND (
    o.created_at_local BETWEEN (:bdate)::timestamptz - interval '90 min'
                           AND (:bdate)::timestamptz + interval '90 min'
    OR o.created_at_local BETWEEN ((:bdate)::date + 1)::timestamptz - interval '90 min'
                              AND ((:bdate)::date + 1)::timestamptz + interval '90 min'
  )
ORDER BY o.created_at_local;

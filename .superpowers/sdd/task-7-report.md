# Task 7 Report: Needs-attention bucket in review inbox

## Status: COMPLETE ✅

## TDD RED → GREEN

### RED
Wrote `apps/api/test/integration/review.test.ts` first. Seeded:
1. Online order with `status='reconcile_needed'` + a payment row (`amountNgn=4800`)
2. Cancelled online order with `refundOwedNgn=3000` (no payment row)
3. Walk-up order with `status='reconcile_needed'` (should NOT appear)

Initial run → FAIL: `expected false to be true` at `Array.isArray(attention)` (field did not exist yet).

### GREEN
Implemented in `apps/api/src/routes/review.ts`:
- Added `and`, `inArray`, `desc` imports from drizzle-orm; added `payment` import from @ms/db
- Query: `saleOrder` WHERE `channel='online'` AND (`status='reconcile_needed'` OR `refundOwedNgn IS NOT NULL`)
- Secondary query: latest `payment.amountNgn` per order (via DESC sort + first-seen-wins Map)
- Mapped result to `{ id, order_number, status, total_ngn, refund_owed_ngn, reported_ngn }` snake_case shape
- Added `payment_attention` to the `data` object alongside `transfer_variances` / `return_approvals`

Test re-run → PASS (1/1) in ~47s.

## Typecheck
`npx tsc --noEmit` (filtering shipbubble-live pre-existing errors) → clean, no output.

## Test assertions verified
- `reconcileItem.status` = `'reconcile_needed'`, `total_ngn` = 5000, `refund_owed_ngn` = null, `reported_ngn` = 4800 ✅
- `refundItem.status` = `'cancelled'`, `total_ngn` = 3000, `refund_owed_ngn` = 3000, `reported_ngn` = null ✅
- Walk-up `reconcile_needed` order NOT in `payment_attention` ✅

## Files changed
- `apps/api/src/routes/review.ts` — added payment_attention query + field
- `apps/api/test/integration/review.test.ts` — new integration test (created)

## Concerns
- None. The `inArray` short-circuit (skip payment query when no flagged orders) avoids empty-IN errors.
- `reported_ngn` uses latest-by-createdAt payment row. If multiple payment attempts exist, only the most recent is used — consistent with the reconciliation use-case.

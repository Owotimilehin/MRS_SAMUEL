# Gracious "made-to-order" checkout confirmation

**Date:** 2026-06-23
**Status:** Approved (design)

## Problem

When a customer places an online order for something the branch is out of stock
on (or a `preorder_only` size), the backend silently flags the order as a
preorder, still takes payment, and the customer gets no heads-up. They only
discover it's made-to-order later. We want a friendly, reassuring confirmation
*before* payment — without touching the order/payment/reservation/preorder model
or the Payaza money path.

This is the safe, customer-facing slice of the shelved
`worktree-online-storefront-stock` branch. The risky parts of that branch
(dropping preorder columns, deleting preorder routes, removing `pos.preorder`,
the no-reservation rewrite, `webhooks-payaza.ts` changes, catalog `available_now`
exposure) are explicitly **out of scope**.

## Behavior

- The backend already computes `orderIsPreorder` at order-create time. It is
  `true` when any line is out of stock at the branch OR the variant is
  `preorder_only`. This is the single source of truth — the modal matches it
  exactly, so the message is always truthful (no client/server drift).
- In-stock orders (`is_preorder: false`): unchanged — straight to Payaza.
- Made-to-order orders (`is_preorder: true`): show a gracious modal before
  launching Payaza:
  - **Continue to payment** → launch Payaza (existing path).
  - **Go back** → dismiss, leave the cart intact, let the customer adjust/retry.
    The created-but-unpaid order is abandoned exactly as an abandoned checkout is
    today (non-preorder reservation expires; preorder simply sits unpaid).

## Changes

### 1. API (additive)
`POST /v1/online-orders` create response `data` gains `is_preorder: boolean`,
read from `created.order.isPreorder`. No other change to the route. No migration.

### 2. Customer plumbing
Thread `is_preorder` through the `placeOrder` server-fn result and its type
(`apps/customer/src/lib/api/server-fns.ts` + types).

### 3. Customer checkout
- Port `GraciousContactModal.tsx` from the shelved branch verbatim
  (self-contained: framer-motion overlay, "Continue to payment" / "Go back").
- In `checkout.tsx` `submit()`: after `placeOrderFn` resolves, if
  `res.is_preorder === true` and the customer has not already confirmed, stash
  the result and show the modal instead of immediately launching Payaza.
- `confirmedPreorder` guard so the existing idempotency-retry loop never
  re-shows the modal once the customer has chosen Continue.

## Out of scope (explicitly NOT changed)
- Preorder columns / routes / `pos.preorder` capability
- Stock reservation / deduction / Payaza reconciliation
- Catalog `available_now` exposure, product-page badges

## Testing
- **API:** online-order create returns `is_preorder: true` for an out-of-stock
  line and for a `preorder_only` line; `false` for an in-stock line.
- **Customer:** the `placeOrder` result carries `is_preorder` through (server-fn
  /mapper level), and the checkout gates the Payaza launch on it (modal shown
  when true; Payaza launched only on Continue).

## Risk
Low. One additive API field, one new self-contained component, and a gate in the
checkout submit path. Money path, reservations, and preorder behavior are
untouched. Worst case if the flag is wrong: a redundant or missing reassurance
popup — never a payment or stock error.

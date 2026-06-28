# Preorder rules (storefront vs. till)

A "preorder" is one `sale_order` row with `is_preorder = true`. It is **prepaid
but stock is NOT deducted until fulfilment** — the deduction happens in
`fulfilPreorderTx` (`apps/api/src/routes/preorder-shared.ts`), which re-checks
branch stock and throws `preorder_unfulfillable` if the stock isn't there yet.
Workflow is genuinely make-to-order: order in → produce toward it → fulfil.

## ⚠️ The asymmetry: `preorder_only` means different things per channel

The two create paths treat the variant flag `preorder_only` **differently on
purpose**. Do NOT "unify" them — doing so breaks instant counter sales.

| Trigger                          | Storefront (`public-orders.ts`) | Till / POS (`sales.ts`) |
|----------------------------------|:-------------------------------:|:-----------------------:|
| Variant is `preorder_only`       | always a preorder               | **ignored**             |
| Line out of stock at branch      | becomes a preorder              | becomes a preorder      |
| Cashier toggles `is_preorder`    | n/a                             | forces preorder (needs `scheduled_delivery_at`) |

**Why the till ignores `preorder_only`:** `preorder_only` is a *storefront* rule
(e.g. the 330ml size is online-preorder-only). At the counter the customer is
physically present, so an **in-stock** 330ml must sell instantly as a normal
walk-up sale rather than being forced into the preorder queue. See the comment
block at `sales.ts` around the `immediateHandover` check.

## Access control

- **Owner/admin queue** — `preorders.ts`, gated `orders.manage`, all branches.
- **Till queue** — `branch-preorders.ts` at `/v1/branches/:branchId/preorders`,
  gated `pos.sell`/`pos.preorder` **plus `requireBranchScope()`** so a till only
  sees and fulfils its own branch. `fulfilPreorderTx` also re-checks the order
  belongs to the path branch (independent in-handler guard → 404 on mismatch).
- A preorder-only role (`pos.preorder` without `pos.sell`) is hard-blocked from
  ringing stock-consuming sales at both create and pay.

## Lifecycle

```
confirmed --pay--> paid --fulfil--> handed_over (counter) / out_for_delivery
 (no stock         (still NO         (stock deducted HERE, in fulfilPreorderTx)
  reservation)      stock move)
```

A paid preorder is **never** auto-cancelled by the worker
(`expire-unpaid-orders.ts` only touches unpaid `confirmed` online orders).

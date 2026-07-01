# Payaza fee-aware reconciliation & per-order money breakdown

**Date:** 2026-07-01
**Status:** Design — awaiting user review

## Problem

Every online (Payaza) order shows "reconciliation needed," and the owner cannot see
the money breakdown Payaza reports.

Root cause, confirmed in code: the owner has configured Payaza so the **customer pays
the transaction fee on top of the product price**. Payaza therefore charges the
customer `product total + fee`, reports that fee-inclusive amount as `amount_received`,
and **always deducts its fee** from the settlement. Our reconciliation
(`apps/api/src/payments/reconcile.ts:46`) demands *exact* equality:

```ts
confirmed.amountNgn !== o.totalNgn   // → status = "reconcile_needed"
```

Since the reported amount is fee-inclusive (`total + fee`) and our stored `totalNgn`
is the bare product total, they never match, so **every** order trips reconciliation.
The extra data Payaza returns (the fee, the net settled) is parsed away
(`apps/api/src/payments/payaza.ts:144` reads only `amount_received`).

## The money model (owner's terms)

Worked example: a can of juice is **₦3,500**, Payaza's transaction fee is **₦100**.

- **Product total (`totalNgn`) = ₦3,500** — the only part that is the business's.
- **Transaction fee = ₦100** — **Payaza decides this per transaction**; it is not fixed
  and must never be hardcoded. The customer is expected to add it on top.
- **Expected charge = ₦3,600.** But ₦100 was never the business's money.
- Payaza **always deducts its fee** (₦100) regardless of what the customer actually paid.
- **What lands in the account = (amount customer paid) − (Payaza fee) = NET.**

The order is genuinely "paid in full" only when **NET ≥ product total (₦3,500)**.

| Customer paid | Payaza fee | Net to business | Outcome |
|---|---|---|---|
| ₦3,600 | ₦100 | ₦3,500 | Paid cleanly (net = total) |
| ₦3,700 | ₦100 | ₦3,600 | Paid, +₦100 credit (net > total) |
| ₦3,500 | ₦100 | ₦3,400 | **Shortfall ₦100** — customer omitted the fee |
| ₦3,000 | ₦100 | ₦2,900 | **Shortfall ₦600** — customer underpaid |

The **only** way the business loses money is a customer paying **less than expected**;
because Payaza deducts exactly the fee it charged, there is no fee-mismatch loss.

## Design

### The one rule that changes

Reconcile on **NET vs product total**, not gross vs product total.

```
net = amountCustomerPaid − payazaFee
if net ≥ totalNgn − TOLERANCE  → mark PAID cleanly
else                           → reconcile_needed + record shortfall + alert
```

`TOLERANCE` is a small kobo-rounding allowance (e.g. ₦1) to absorb Payaza's rounding;
final value set during implementation from real transaction data.

### Part 1 — Capture Payaza's full money breakdown

Extend `PayazaTransactionStatus` and `verifyPayazaTransaction`
(`apps/api/src/payments/payaza.ts`) to read, in addition to today's `amount_received`:

- the **fee** Payaza charged/deducted (field name TBD from real data — candidates:
  `fee`, `charge`, `transaction_fee`, `vat`),
- the **net / settlement** amount if Payaza reports one directly,
- the **raw response JSON**, retained verbatim so nothing Payaza sends is lost and the
  owner can always see the source-of-truth breakdown.

Derivation rules (robust to missing fields):
- `gross` = `amount_received` (what the customer paid).
- `fee`   = Payaza's reported fee field, if present.
- `net`   = Payaza's settlement field if present, else `gross − fee` if `fee` present,
  else `null` (see fallback).

**Fallback (no fee field in Payaza's data):** reconcile on `gross ≥ totalNgn` instead of
`net ≥ totalNgn`. This still eliminates the false positives; it only loses precise
underpayment detection. **Implementation step 0** is to inspect one real paid
transaction (e.g. `SO-2026-00380`) and confirm which fields Payaza actually returns,
which decides net-based vs gross-based reconciliation.

### Part 2 — Persist the breakdown

Add to the `payment` row (`packages/db/src/schema/payment.ts`) — one migration:

- `fee_ngn` (integer, nullable) — Payaza's transaction fee for this charge.
- `gross_ngn` (integer, nullable) — total the customer's card was charged.
- `net_ngn` (integer, nullable) — amount settled to the business (`gross − fee`).
- `raw_breakdown` (jsonb, nullable) — verbatim Payaza money fields.

`amount_ngn` keeps its current meaning — the business's **revenue figure = product
total** — so existing revenue reports that sum `payment.amount_ngn` are unaffected.
The new `gross_ngn` / `fee_ngn` columns are for reconciliation and display **only**;
they are never summed into any revenue or analytics figure (see "Accounting &
analytics boundary" below).

Add to `sale_order` (`packages/db/src/schema/sale-order.ts`):

- `fee_shortfall_ngn` (integer, nullable) — `totalNgn − net` when positive; the amount
  the business was shorted on this order. `NULL`/0 means paid in full.

### Part 3 — Fee-aware reconciliation

In `applyPayazaConfirmation` (`apps/api/src/payments/reconcile.ts`), replace the strict
`amountNgn !== totalNgn` mismatch gate with the NET rule:

1. Compute `gross`, `fee`, `net` from the enriched `PayazaTransactionStatus`.
2. **`net ≥ totalNgn − TOLERANCE`** → proceed to mark paid (existing CAS flip,
   stock ledger, reservation clear). Write the payment row with the captured
   `fee_ngn` / `gross_ngn` / `net_ngn` / `raw_breakdown`; `amount_ngn = totalNgn`.
   Set `sale_order.fee_shortfall_ngn = NULL`.
3. **`net < totalNgn − TOLERANCE`** → this is a genuine underpayment. Keep the existing
   `confirmed → reconcile_needed` CAS + alert, but the alert now carries the shortfall
   (`total`, `gross`, `fee`, `net`, `shortfall`). Set
   `sale_order.fee_shortfall_ngn = totalNgn − net`. Emit `sale.fee_shortfall`
   (renamed/enriched from today's `sale.amount_mismatch`).

The `opts.acceptReportedAmount` path (owner "accept anyway" from the review screen)
still lets the owner force-accept a shorted order; it records the shortfall for the
record but marks paid.

Underpayment behaviour is per the owner's choice: **real shortfalls still flag**;
fee-inclusive/overpaid orders pass through cleanly.

### Part 4 — Order-detail money breakdown (owner + branch)

On `apps/admin/src/routes/owner/order-detail.tsx` (and the branch order-detail),
replace the current bare Subtotal/Delivery/Total block with the full picture for card
orders, sourced from the enriched payment row via the order-detail API
(`apps/api/src/routes/sales.ts` order detail, which already exposes `reportedNgn`):

```
Subtotal              ₦3,000
Delivery              ₦500
─────────────────────────────
Product total         ₦3,500     ← this is yours
Payaza fee            ₦100        ← Payaza's, added to the customer
Customer paid (gross) ₦3,600
Net settled to you    ₦3,500
─────────────────────────────
Shortfall             —           (or e.g. ₦100 in red when net < total)
Payaza reference      P-C-2026…
```

For non-card / walk-in orders the block stays as today (no fee section).

### Part 5 — Checkout unchanged

No change to `buildPayazaCheckoutConfig` or `public-orders.ts`: Payaza already adds the
fee to the customer per the owner's Payaza dashboard setting, so the customer is charged
`total + fee` without us computing it. We only *read and reconcile* what Payaza does.

### Part 6 — Surface shortfalls in review & reporting

- The owner **review** screen (`apps/admin/src/routes/owner/review.tsx`,
  `apps/api/src/routes/review.ts`) already lists reconcile-flagged orders; show the
  shortfall amount and the gross/fee/net breakdown there, not just a bare mismatch.
- `sale_order.fee_shortfall_ngn` gives a simple sum for a "fee losses" figure in the
  owner money/variance report. Payment-fee shortfalls are a **money** loss and are kept
  on the order, distinct from the stock-based `variance_loss` table.

### Part 7 — Accounting & analytics boundary (only the business's money counts)

**Hard rule: only the business's money enters accounting and analytics.** The Payaza
transaction fee, and the fee-inclusive gross the customer paid, are **never** counted as
revenue, sales, or income anywhere.

- **Revenue / sales / dashboards / daily-close / reports** recognize the **product
  total** (`sale_order.totalNgn` = subtotal + delivery), i.e. the business's money —
  exactly what `payment.amount_ngn` already sums to today. Nothing changes in these
  aggregations; enrichment does not leak the fee into them.
- **`gross_ngn` and `fee_ngn` are display/reconciliation-only** and are excluded from
  every SUM/count used for money analytics.
- **Shortfall handling for "only what I got":** when a customer underpays, the business
  actually received less than the product total. That gap lives in
  `sale_order.fee_shortfall_ngn` and is reported as a **loss** that offsets recognized
  revenue in the money/variance report — so the owner's *net* accounting reflects the
  real amount received (`total − shortfall`), never an inflated figure. The clean case
  (net ≥ total) recognizes the full product total with no offset.

Net effect: analytics answer "what did the business earn" using only the business's
money; Payaza's fee is visible on the order for transparency but sits entirely outside
the revenue numbers.

## Out of scope

- Changing who bears the fee (owner has already set customer-pays in Payaza).
- Refund flows for overpayment/credit (net > total is recorded, not auto-refunded).
- Subscription-charge fee capture (same enrichment could apply later; not now).

## Testing

- **Unit** (`apps/api/test/unit/reconcile.test.ts`): net ≥ total → paid; net < total →
  reconcile_needed + shortfall; missing-fee fallback → gross ≥ total; tolerance edge;
  idempotent replay; `acceptReportedAmount` forces paid and records shortfall.
- **Payaza parser** (new/extended): parse a real-shaped transaction-query body with fee
  + settlement fields; parse a body missing the fee field (fallback path); kobo/naira
  units.
- **Integration** (`apps/api/test/integration/payments-admin.test.ts`,
  `online-order.test.ts`): webhook confirm with fee-inclusive amount → order paid, no
  reconcile; underpaid amount → reconcile_needed with shortfall.
- **Order-journey / detail**: breakdown renders fee/gross/net/shortfall for a card order.

## Implementation order

0. Inspect one real paid transaction; confirm Payaza's fee/settlement field names →
   fixes net-based vs gross-based reconciliation and `TOLERANCE`.
1. Migration: payment fee/gross/net/raw columns + `sale_order.fee_shortfall_ngn`.
2. Enrich `payaza.ts` parser + `PayazaTransactionStatus`.
3. Fee-aware `reconcile.ts` + enriched alert event.
4. Order-detail API + owner/branch breakdown UI.
5. Review screen shortfall display + report sum.
6. Tests throughout (TDD).

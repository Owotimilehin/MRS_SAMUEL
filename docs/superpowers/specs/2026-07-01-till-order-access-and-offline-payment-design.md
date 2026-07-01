# Till order access, payment follow-up & offline payment

**Date:** 2026-07-01
**Status:** Design — awaiting user review

## Problem

An online order that is also a preorder (real example: **SO-2026-00666**, customer
Samuel Johnson, scheduled 2026-07-01 08:00) does **not appear on the till** at
`/branch/preorders` or `/branch/online-orders`, so the staff who actually attend to
the order cannot see or act on it.

Root cause, confirmed in code — the till's two order feeds hard-filter to **paid**
orders, and the till role lacks the owner's order capabilities:

- `listOpenPreorders` (`apps/api/src/routes/preorder-shared.ts:23`) requires
  `isPreorder = true AND status = 'paid' AND producedAt IS NULL`.
- `/online-orders/active` (`apps/api/src/routes/online-orders-queue.ts:22`) requires
  `status IN ('paid','out_for_delivery')`.
- `branch_staff` capabilities (`packages/shared/src/permissions.ts:107`) are
  `pos.sell, pos.preorder, shift_open.submit, sales.view, transfers.receive` — no
  `orders.view` / `orders.manage`. The **owner** sees every order state.

SO-2026-00666 is stuck at `status = 'reconcile_needed'`, `payment_status = 'pending'`,
with **no `payment` row and no external reference** — so it is filtered out of every
till view. (It reached `reconcile_needed` under the older deployed reconciliation code;
prod is on migration 62, the fee-aware migration 0063 is not yet deployed.)

## Goals

1. The till sees **all** live order states, like the owner — full visibility for the
   staff attending the order.
2. The till can **follow up on payment** itself (re-check Payaza) without the owner.
3. Payment states are **honest**: "customer never paid" must not masquerade as
   "reconciliation needed."
4. Handle **the balance arriving by a non-Payaza means** (bank transfer / cash): staff
   can record that payment and mark the order paid.
5. Staff can never **hand out product that is not paid for** — fulfilment stays
   paid-gated.

## Non-goals

- Force-accepting a **mismatched Payaza amount** stays **owner-only**
  (`orders.accept_payment`) — it overrides the amount-equality guard.
- No change to the Payaza money model itself (that is the separate
  `2026-07-01-payaza-fee-aware-reconciliation-design.md`, on which the precise meaning
  of `reconcile_needed` = "money in but short" depends). This spec is complementary and
  assumes that model.

## Design

### 1. Till sees all live order states

Widen the online-orders queue feed:

- `online-orders-queue.ts` `ACTIVE_STATUSES`: `['paid','out_for_delivery']` →
  `['confirmed','reconcile_needed','paid','out_for_delivery']`. Still branch-scoped via
  the existing `requireBranchScope`.
- The till Online tab (`apps/admin/src/routes/branch/online-orders.tsx`) splits rows
  into an **"Awaiting payment"** group (`confirmed`, `reconcile_needed`) and the normal
  ready-to-make worklist (`paid`, `out_for_delivery`), so an unpaid order is never
  mistaken for a fulfillable one.
- The **new-order chime / nav badge count keeps counting `paid` arrivals only**
  (`buildActiveCounts` / the badge query), so notifications do not fire on an unpaid
  checkout. Only the *list* widens.

Preorder queue: `listOpenPreorders` **stays paid-only** — that queue is explicitly the
"ready to make" worklist and its fulfil action deducts stock. Unpaid preorders surface
in the widened Online tab's "Awaiting payment" group instead.

### 2. Till can follow up on payment

- Grant `branch_staff` two capabilities in `permissions.ts` `BRANCH_STAFF_CAPS`:
  `orders.view`, `orders.manage`. (Admin and manager already hold these.)
- Add a **"Re-check payment"** button to the till online-order-detail
  (`apps/admin/src/routes/branch/online-order-detail.tsx`) that calls the existing
  `POST /v1/online-orders/:id/recheck` (gated `orders.manage`). No new endpoint.

### 3. Re-check resolves `reconcile_needed` honestly

Today `recheck` → `verifyAndReconcile` → `applyPayazaConfirmation`, whose guard is
`if (o.status !== 'confirmed') return already_processed` — so a `reconcile_needed`
order is untouched by a re-check and lingers forever.

Change: allow a re-check to act on a `reconcile_needed` order the same way `accept`
already nudges it (`payments-admin.ts:105`) — re-verify against Payaza and:

| Payaza result | Outcome |
|---|---|
| Completed, **net ≥ total** | → `paid` (normal paid side-effects run) |
| Completed, **net < total** | stays `reconcile_needed` (genuine money-in-but-short) |
| **Not completed / no money** | **no automatic change** — see §5 |

Crucially, a Payaza "not completed" result does **not** auto-cancel: the balance may
have arrived by transfer that staff have not recorded yet (§4). Re-check simply reports
"Payaza shows no completed payment for this order." Resolving to Unpaid is the
deliberate action in §5. The existing 60-minute auto-expiry on *fresh* `confirmed`
orders (`expire-unpaid-orders.ts`) is unchanged and only ever touches `confirmed`.

### 4. Record payment received (offline) — till staff + owner

The customer may pay the whole amount, or top up a shortfall, by **bank transfer or
cash** — outside Payaza. There is no path for this today (even owner `accept` records
the money as `processor: payaza, method: card`).

New endpoint `POST /v1/online-orders/:id/record-payment`, gated `orders.manage` (so
`branch_staff`, admin, manager, owner all qualify):

- **Body:** `{ method: 'transfer' | 'cash', amount_ngn?: number }`. `amount_ngn`
  defaults to the order's outstanding balance (`totalNgn − already-recorded payments`).
  Both `transfer` and `cash` are already valid `payment_method` enum values — **no
  migration**.
- **Allowed from:** `status IN ('confirmed','reconcile_needed')`. CAS-guarded flip to
  `paid` (`WHERE status IN (...) RETURNING`) so concurrent presses / a racing Payaza
  webhook cannot double-pay or double-deduct stock.
- **Effects (mirror `applyPayazaConfirmation`'s paid branch):**
  - Insert a `payment` row: real `method`, `processor: 'manual'`, `amountNgn` = recorded
    amount, `collectedByUserId` = the acting staff, `paidAt = now`. Never labelled
    Payaza.
  - Set `status='paid', paymentStatus='paid'`; clear `feeShortfallNgn` when present.
  - Non-preorder: write the sale `stockLedger` rows and delete `stockReservation`.
    Preorder: no stock movement (deferred to fulfilment) — joins the preorder queue.
  - Emit the same paid outbox event (`sale.paid_online` / `sale.preorder_paid`) so the
    owner is notified on Telegram, plus a distinct audit action
    `sale_order.record_offline_payment` capturing method + amount + who.
- **Idempotent:** replaying against an already-`paid` order returns without a second
  payment or deduction.

Till UI: a **"Record payment received"** control on the online-order-detail (method
picker transfer/cash, amount defaulting to the balance) beside "Re-check payment".

### 5. Resolve to Unpaid — deliberate, never automatic

When staff have confirmed no money landed on **Payaza or by transfer**, they cancel the
order as unpaid. This must **not** reuse `cancel-refund` — that endpoint always sets
`refund_owed_ngn = totalNgn`, which for a never-paid order would fabricate a refund
liability the business does not owe. Instead add a dedicated **`cancel-unpaid`** action
(gated `orders.manage`) that only acts on `confirmed` / `reconcile_needed` orders: sets
`status = 'cancelled'`, `cancel_reason = 'payment_not_received'`, releases the stock
reservation, and leaves `refund_owed_ngn` NULL. Surfaced everywhere as **"Unpaid — no
payment received."** No new status, no migration (chosen over a new `unpaid` status to
stay light and match the existing 60-min auto-expiry resolution, which likewise cancels
with no refund). Paid orders that need cancelling still go through `cancel-refund`.

`reconcile_needed` is thereby reserved strictly for "money in but short."

### 6. Fulfilment stays paid-gated (unchanged)

Produce / hand-over / deliver / `fulfilPreorderTx` already require `status = 'paid'`.
The till can now *see* an unpaid order and act on its **payment**, but cannot produce or
hand over product until the order is actually paid (by Payaza or recorded offline).

## Data model

No migration. Verified on prod (2026-07-01): `payment.processor` is `text` (so
`'manual'` needs no schema change), `payment.method` is the `payment_method` enum which
already includes `transfer` and `cash`, `payment.collected_by_user_id` (uuid) exists,
and `sale_order.cancel_reason` is free text.

## Testing

- Widened online queue still branch-scoped; a second branch's `confirmed` order is not
  visible.
- Badge/chime count unchanged (paid-only) after the list widens.
- `branch_staff` **can** call `recheck` and `record-payment`; **cannot** call
  `accept` (owner-only) — 403.
- `record-payment` from `confirmed` → `paid` with a `transfer` payment row, stock
  deducted (non-preorder) / preorder queued (preorder), Telegram event emitted.
- `record-payment` from `reconcile_needed` (shortfall) topping up → `paid`, shortfall
  cleared.
- `record-payment` idempotent: second call is a no-op (no second payment / deduction).
- `recheck` on `reconcile_needed`: Payaza Completed-full → paid; Completed-short →
  stays reconcile_needed; not-completed → unchanged (no auto-cancel).
- Cancel with `payment_not_received` releases reservation and leaves the queues.

## Immediate follow-up (out of band, not code)

SO-2026-00666 is due 08:00 today. Once shipped, staff Re-check it (Payaza will show no
payment) and either Record a transfer if Samuel paid by bank, or cancel it as Unpaid.
Optionally verify it against live Payaza now to know before the slot.

# Payaza Payment Reliability & Reconciliation — Design

**Date:** 2026-06-22
**Status:** Approved (brainstorm), pending spec review → implementation plan

## Problem

Online card payments are now live on Payaza. An order only flips `confirmed → paid`
when Payaza calls our webhook (`/v1/webhooks/payaza`) and we re-query the
transaction. This creates three gaps:

1. **Lost payments.** If Payaza completes a charge but never calls the webhook
   (dashboard misconfig, transient failure), the order stays `confirmed`, the
   30-minute reservation expires, stock is released — the customer paid but the
   order is silently dropped. The tracking page does **not** re-query Payaza, so
   nothing recovers it.
2. **Unresolvable mismatches.** When Payaza reports a different amount than the
   order total, the order is parked in `reconcile_needed` — but it is not in the
   owner "Needs review" inbox and the order page shows no action buttons
   (`canCancel` is gated to `confirmed`/`paid`). There is no way to accept,
   cancel, or refund it in-app.
3. **No refund path.** Payaza exposes no confirmed server-side refund API, so a
   bad-payment cancellation has nowhere to record that a manual refund is owed.

Observability for the webhook itself was already fixed separately (commit
`a931f38`: structured logging on every webhook outcome).

## Goals

- **No completed payment is ever lost**, even if the webhook never fires.
- The owner can **resolve** `reconcile_needed` and bad-payment orders in-app:
  re-check, accept, or cancel-with-refund-owed.
- One **single, tested money path** shared by webhook, cron, on-view re-verify,
  and admin actions.

## Non-goals

- Automatic Payaza refunds (the API is unconfirmed) — we record "refund owed"
  and the owner refunds manually in the Payaza dashboard.
- **Customer-initiated refund requests and fulfilled-order refunds (Phase 2).**
  `cancel-refund` / `refund_owed_ngn` here covers ONLY paid-but-**unfulfilled**
  orders (cancel + restore stock). A refund for an already-**delivered** order is
  a *return*, which the existing `sale_return` / `returns.ts` system already
  handles (disposition restock/waste, shelf-life return window, over-return
  guard, store-credit/refund method, status → `refunded`). The `cancel-refund`
  endpoint therefore rejects terminal/fulfilled statuses (409) by design — it
  must never become a parallel returns path. A customer-facing "request a refund"
  affordance that feeds these owner-approved flows is a separate Phase 2.
- Recurring-subscription reconciliation (separate, still mock-only).
- A full payments dashboard / transaction explorer (deferred).

## Decisions (from brainstorm)

- Reliability: **cron sweep + on-view re-verify** (defense in depth).
- Admin UI: **Needs-attention queue + order-page actions** (not a full dashboard).
- Refunds: **cancel + "refund owed" record** (manual refund in Payaza dashboard).

---

## Architecture

### Component 1 — Shared reconcile core
**New file:** `apps/api/src/payments/reconcile.ts`

Extracts the money-logic currently inline in `webhooks-payaza.ts` so every caller
shares one path.

```ts
export type ReconcileOutcome =
  | { kind: "order_not_found" }
  | { kind: "already_processed"; status: string }
  | { kind: "not_completed"; payazaStatus: string }
  | { kind: "amount_mismatch"; expectedNgn: number; reportedNgn: number }
  | { kind: "paid"; orderNumber: string; amountNgn: number; isPreorder: boolean };

/** Apply an already-fetched Payaza confirmation to an order, in a tx.
 *  Idempotent: only acts when order.status === "confirmed". This is the ONLY
 *  place an online order is marked paid / parked for reconcile. */
export async function applyPayazaConfirmation(
  tx: DbTx,
  order: SaleOrderRow,
  confirmed: PayazaTransactionStatus,
): Promise<ReconcileOutcome>;

/** Re-query Payaza for an order number, then apply. Used by cron, on-view
 *  re-verify, and the admin "Re-check" button. Opens its own tx. */
export async function verifyAndReconcile(
  db: DbClient,
  orderNumber: string,
): Promise<ReconcileOutcome>;
```

Behavior (unchanged from today's webhook, just relocated): amount-guard →
`reconcile_needed` + `sale.amount_mismatch` event; else (preorder skips stock)
ledger out stock, delete reservation, insert `payment`, set `paid`/`paymentStatus
paid`, emit `sale.preorder_paid`/`sale.paid_online`, optional `delivery.request`
when `AUTO_DISPATCH_DELIVERY` is on.

**`webhooks-payaza.ts` refactor:** keep the inbound logging, JSON/reference
parsing, `SUB_` routing, and the verify call; replace the inline transaction body
with `applyPayazaConfirmation`. The per-outcome logging maps from
`ReconcileOutcome`.

### Component 2 — Reliability backbone

**2a. Worker sweep** — new `apps/worker/src/jobs/payaza-reconcile.ts`
```ts
export async function sweepStuckPayazaOrders(
  db: DbClient,
  now?: Date,
): Promise<number>; // returns count reconciled
```
Selects online orders where `status = 'confirmed'`, `channel = 'online'`, a
stock reservation exists with `expires_at > now` (still live — no point chasing
expired holds), and `created_at < now - 90s` (give the webhook first crack).
Calls `verifyAndReconcile` per order. On a `paid` outcome that the webhook missed,
also emits `sale.reconciled_paid` (so the owner knows the safety net fired).

Wired into the worker main loop (`apps/worker/src/index.ts`) on its own
`PAYAZA_RECONCILE_INTERVAL_MS` timer (default **120_000 = 2 min**), mirroring the
delivery-watchdog pattern. 2-min cadence comfortably beats the 30-min hold.

**2b. On-view re-verify** — `apps/api/src/routes/public-orders.ts` (tracking GET)
Before building the tracking response, if the order is `channel = 'online'`,
`status = 'confirmed'`, and its reservation is still live, call
`verifyAndReconcile(db, orderNumber)` once, then re-read the order. A returning
customer sees the order resolve immediately. Best-effort: a thrown Payaza error
is caught and logged; the page still renders the current state. No new client
code — the existing payment-hold/paid rendering reacts to the updated status.

### Component 3 — Admin reconciliation

**3a. Refund-owed column** — migration `00NN_refund_owed.sql`
Add nullable `refund_owed_ngn integer` to `sale_order` (drizzle schema + journal
entry, rebuild `@ms/db`). Set on cancel-refund, cleared (→ null) on "mark
refunded". No other columns — `cancelReason`/`cancelledByUserId` already exist.

**3b. Admin endpoints** — new `apps/api/src/routes/payments-admin.ts`
Mounted under `/v1/online-orders`, `requireAuth()` + `requireCapability("orders.manage")`.
- `POST /:id/recheck` → `verifyAndReconcile`; returns `{ status, outcome }`.
- `POST /:id/accept` → **owner-only** (`requireCapability("orders.accept_payment")`,
  a new owner-default capability). Forces a `reconcile_needed` order to paid by
  calling `applyPayazaConfirmation` with Payaza's reported amount treated as
  authoritative (records the real `payment.amountNgn`). Emits `sale.paid_online`.
- `POST /:id/cancel-refund` → body `{ reason }`. Cancels (reuses the cancel
  ledger-restore logic), sets `refund_owed_ngn = total_ngn` (or the
  Payaza-reported amount if known), emits `sale.refund_owed`, writes audit.
- `POST /:id/mark-refunded` → owner-only, sets `refund_owed_ngn = null`, audit.

These are **online-channel only** (guard `channel === "online"`); till sales keep
using `sales.ts`.

**3c. Needs-review inbox** — `apps/api/src/routes/review.ts`
Add `payment_attention`: online orders where `status = 'reconcile_needed'` OR
`refund_owed_ngn IS NOT NULL`, each with order number, total, Payaza-reported
amount (from the last `sale.amount_mismatch` payload / payment row), and state.
The admin Needs-review page renders this bucket with a nav **count badge**.

**3d. Admin order-detail UI** — `apps/admin/src/routes/.../order-detail.tsx`
For an online order in `confirmed`/`reconcile_needed`/`refund_owed`, render an
action panel (built with the **frontend-design** skill):
- Status pill incl. `reconcile_needed` and a "Refund owed ₦X" badge.
- **Expected ₦X vs Payaza-reported ₦Y** comparison row when mismatched.
- Buttons with confirm dialogs: **Re-check payment**, **Accept as paid**
  (owner), **Cancel & mark refund owed**, **Mark refunded** (owner).
- Optimistic disabled/loading states; success re-fetches the order.

### Component 4 — Notifications
New `outboxEvent` types + Telegram lines in `apps/worker/src/outbox.ts`:
- `sale.refund_owed` → owner: "💸 Refund owed — {order} ₦{amount}. Refund in the
  Payaza dashboard, then mark refunded." + link.
- `sale.reconciled_paid` → owner: "✅ Recovered payment — {order} marked paid by
  reconcile sweep (webhook had not fired)." + link.

---

## Data flow

```
Payaza popup completes
   │
   ├─(a) webhook  ───────────┐
   ├─(b) cron sweep (≤2 min) ─┼──► verifyAndReconcile ─► applyPayazaConfirmation
   ├─(c) on-view re-verify ──┤        (re-query Payaza)        │ (idempotent on
   └─(d) admin Re-check ─────┘                                 │  status=confirmed)
                                                               ▼
                       Completed + amount matches → PAID (ledger, payment, events)
                       Completed + amount differs → reconcile_needed (+ alert)
                       not Completed               → no-op
```
Idempotency: whichever path wins first flips `confirmed → paid`; the rest see a
non-`confirmed` status and no-op.

## Error handling
- `verifyAndReconcile` Payaza errors (401/5xx): cron logs + continues to next
  order; on-view catches + renders current state; webhook throws → 500 (Payaza
  retries); admin Re-check returns a 502-style "couldn't reach Payaza, try again".
- `accept` on a non-`reconcile_needed`/non-`confirmed` order → 409.
- `cancel-refund` on a terminal order (delivered/handed_over/cancelled) → 409.
- All admin mutations write an audit-log entry (→ Telegram via existing pipeline).

## Capabilities
- `orders.manage` — existing; gates recheck + cancel-refund.
- `orders.accept_payment` — **new**, owner default only (force-accept + mark
  refunded). Added to `packages/shared/permissions.ts`.

## Testing
- **Unit** (`reconcile.test.ts`): `applyPayazaConfirmation` idempotent (already
  paid → no-op), amount-mismatch → `reconcile_needed`, match → paid, preorder
  skips stock.
- **Unit** (sweep): selects only live-reservation confirmed online orders; skips
  expired/paid.
- **Integration**: webhook still works via shared core (regression);
  `recheck`/`accept`/`cancel-refund`/`mark-refunded` happy + auth + 409 paths;
  on-view re-verify flips a confirmed order when Payaza says Completed (mocked).
- **Manual**: complete one real ₦ payment; confirm webhook PAID log; then a
  webhook-suppressed order recovered by the sweep within 2 min.

## Files
- New: `apps/api/src/payments/reconcile.ts`, `apps/api/src/routes/payments-admin.ts`,
  `apps/worker/src/jobs/payaza-reconcile.ts`,
  `packages/db/migrations/00NN_refund_owed.sql`, tests.
- Modified: `webhooks-payaza.ts`, `public-orders.ts` (tracking GET), `review.ts`,
  `outbox.ts`, worker `index.ts`, `permissions.ts`, db schema `sale-order.ts`,
  admin `order-detail.tsx` + Needs-review page + nav badge.
```

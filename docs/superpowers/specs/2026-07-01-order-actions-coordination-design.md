# Online Order Actions Coordination + Delivery Robustness

**Date:** 2026-07-01
**Status:** Approved design
**Scope:** `apps/admin` owner + branch online-order detail pages; `apps/api` delivery layer + webhook; `apps/worker` delivery watchdog.

## Problem

The owner order-detail page (`apps/admin/src/routes/owner/order-detail.tsx`) renders every action button per-card with almost no state-gating. On a fully-paid, Payaza-confirmed order the admin still sees "Re-check payment", "Accept as paid", and "Cancel & refund" — actions that make no sense once money has settled. WhatsApp appears twice (Customer card + Delivery card). Destructive actions sit at the same visual weight as routine ones. There is no single "what do I do next" focal point.

Separately, **delivery drives order status** through two loosely-coordinated writers, and the delivery path is fragile:

- **Manual advance** — `PATCH /:id/advance` (`apps/api/src/routes/sales.ts:565`): `paid → out_for_delivery → delivered` (delivery) or `paid → handed_over → delivered` (pickup).
- **Shipbubble webhook** — `apps/api/src/routes/webhooks-bolt.ts`: rider `picked_up`/`in_transit` → order `out_for_delivery`; rider `delivered` → order `delivered` + emits `delivery.completed`. Rider `failed`/`cancelled` emits an event but **does not change order status** → the order sits at `out_for_delivery` forever.

Robustness gaps:

1. **Failed/cancelled rides strand the order** with no surfaced recovery. "Force delivered" is the only escape and is wrong for a failed ride.
2. **No reconciliation if the webhook never fires.** Payments self-heal (2-min sweep + on-view re-verify + recheck); delivery has only a `searching_rider` watchdog and no status polling. The Shipbubble webhook parser previously dropped every event silently — this path has a track record of silent failure.
3. **"Force delivered"** is a quiet subtle button doing load-bearing work with no guardrail.

## Goals

- Exactly one primary "next step" CTA, always the true current bottleneck.
- Every other action visible only when valid for the current state.
- Destructive actions visually separated into a danger zone.
- No duplicate actions.
- Delivery cannot silently strand an order — failed rides surface loudly; stalled deliveries are detected; a poller reconciles status when webhooks go silent.

## Non-goals

- No change to the payments reconcile money-path.
- No change to checkout / customer tracking.
- Cancellation of an order **after dispatch** is out of scope (handled via the returns/manual flow).

## Design

### A. Shared action resolver (`apps/admin/src/lib/order-actions.ts`)

A pure, unit-tested `deriveOrderActions(order)` — the single brain both owner and branch detail pages consume, so they never drift (same pattern as the existing `nextFulfilAction`). It supersedes ad-hoc per-card button rendering.

```
interface OrderActions {
  primary: ActionButton | null;      // the one CTA, or null when terminal
  secondary: ActionButton[];         // contextual normal-weight actions
  danger: ActionButton[];            // destructive, rendered in a separate zone
}
```

**Primary CTA priority** (first match wins — always the bottleneck):

1. Payment unsettled (`confirmed` / `reconcile_needed`) → **↻ Re-check payment**
2. Ride `failed` / `cancelled` and order not `delivered` → **↻ Re-book rider**
3. `paid` + preorder + unproduced (`producedAt == null`) → **Fulfil & produce**
4. `paid` + delivery order + no active ride → **Book rider** (manual "Mark out for delivery" available as secondary)
5. `paid` + pickup order → **Mark ready for pickup**
6. `out_for_delivery` → **Mark delivered**; `handed_over` → **Mark collected**
7. `delivered` / `cancelled` → `primary = null`

`nextFulfilAction` is folded into this resolver (kept as an internal helper or inlined; its tests migrate).

### B. Payment card (state-gated)

- **Settled** (`paid` or any later status): read-only line — "Paid ₦X · Payaza". No Re-check, no Accept-as-paid. **(core ask)**
- **Unsettled** (`confirmed` / `reconcile_needed`): Re-check is the primary CTA at the top of the sidebar; **Accept as paid** appears here as a *secondary* override (behind Re-check); amount-mismatch row shown when `reportedNgn !== totalNgn`.
- **Refund owed** (`refundOwedNgn > 0`, any status): danger badge + "Mark refunded" (requires `orders.accept_payment`).

### C. Delivery card (robust, driven by `delivery.status`)

- Address editor — hidden once `delivered` / `cancelled`.
- Rider lifecycle:
  - no ride → **Book rider** / Get delivery options
  - `searching_rider` → "Finding a rider…"
  - `assigned` / `picked_up` / `in_transit` → live rider panel + Track; manual advance suppressed (status is webhook/poller-driven)
  - **`failed` / `cancelled`** → red banner "Delivery failed: {reason}" + **Re-book** (this is the primary CTA)
  - `delivered` → done
- **Stalled banner**: order `out_for_delivery` AND latest rider update older than `STALE_DELIVERY_HOURS` → "Delivery may be stalled" + Track / Re-book / Force delivered.
- **WhatsApp customer** removed from this card; Customer card is the single canonical place.

### D. Danger zone (visually separated)

- **Cancel & mark refund owed** — available only pre-dispatch (`confirmed` / `reconcile_needed` / `paid`). After dispatch, cancellation is a returns/manual matter (not on this page). *(decision: no cancel after dispatch)*

### E. Backend robustness

1. **Extract `applyDeliveryStatus(tx, delivery, order, normalized)`** into a shared module (e.g. `apps/api/src/delivery/apply-status.ts`) from the webhook body (`webhooks-bolt.ts:88-155`): applies the delivery-row patch, mirrors status onto `sale_order`, and emits `delivery.completed` / failure events. Idempotent and terminal-safe. Used by **both** the webhook and the new poller — single source of truth (mirrors payments' `reconcile.ts`).
2. **Add `getStatus(externalRef): Promise<NormalizedWebhook | null>` to `DeliveryProvider`** (`apps/api/src/delivery/provider.ts`). Implement for shipbubble-live (tracking/status API), mock providers (returns stored state), bolt, and manual (no-op / null).
3. **Extend the watchdog into a reconciler** (`apps/worker/src/jobs/delivery-watchdog.ts`): in addition to the existing `searching_rider` retry/escalate, select active deliveries (`assigned`/`picked_up`/`in_transit`/`out_for_delivery` and orders at `out_for_delivery`) whose last update is older than a stale threshold, call `getStatus`, and run `applyDeliveryStatus`. Idempotent; convergence with a later webhook is a no-op. Skips providers whose `getStatus` returns null (e.g. manual).
4. **Failed-ride handling**: order status is **not** auto-reverted. The frontend resolver derives "Re-book" from `delivery.status ∈ {failed, cancelled}` while the order is not `delivered`, so a dead ride surfaces loudly instead of stranding. *(decision: surface, don't revert)*

### F. Testing

- **Unit** (`order-actions.test.ts`): full matrix of order-status × delivery-status × (preorder|produced) × (delivery|pickup) → asserts primary/secondary/danger sets. Migrate existing `order-fulfil-action.test.ts` cases.
- **Unit** (`apply-status.test.ts`): each rider transition, idempotency (re-applying the same status is a no-op), terminal safety.
- **Integration**: poller reconciles a delivery stuck at `out_for_delivery` whose webhook never fired (fake provider `getStatus` returns `delivered`) → order becomes `delivered`, `delivery.completed` emitted once. Webhook-then-poller (or poller-then-webhook) produces exactly one completion.

## Files touched

- `apps/admin/src/lib/order-actions.ts` (new) + `.test.ts` (new)
- `apps/admin/src/lib/order-fulfil-action.ts` (folded in / removed)
- `apps/admin/src/routes/owner/order-detail.tsx` (consume resolver, danger zone, gated cards)
- `apps/admin/src/routes/branch/online-order-detail.tsx` (same resolver)
- `apps/api/src/delivery/provider.ts` (`getStatus` on interface)
- `apps/api/src/delivery/apply-status.ts` (new, extracted) + `.test.ts`
- `apps/api/src/delivery/shipbubble-live.ts`, `bolt-*.ts`, mocks, `manual` (`getStatus`)
- `apps/api/src/routes/webhooks-bolt.ts` (call shared `applyDeliveryStatus`)
- `apps/worker/src/jobs/delivery-watchdog.ts` (add status-reconcile pass)

## Open decisions (defaults chosen)

1. **No cancel after dispatch** — cancellation leaves this page once a ride is out; use returns/manual.
2. **Failed ride surfaces Re-book without reverting order status.**
3. `STALE_DELIVERY_HOURS` threshold — to be set during implementation (proposed: 2h for `out_for_delivery`, minutes-scale already handled for `searching_rider`).

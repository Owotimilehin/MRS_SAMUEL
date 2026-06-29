# Order-detail UX overhaul (owner + branch)

Date: 2026-06-29
Status: approved, implementing

## Problem

The admin order-detail page (`apps/admin/src/routes/owner/order-detail.tsx` and its
branch twin `branch/online-order-detail.tsx`) has a confusing status/fulfilment area:

- The order's status is shown in **three** places that can disagree: the `StatHero`
  chip (raw text e.g. `out_for_delivery`), the card-header pill, and the "Payment
  status" section pill.
- There are **two** payment cards ("Payment: method" and "Payment status").
- Fulfilment is a stack of buttons with shifting labels and **no timeline** — the
  owner can't see at a glance where the order is in its journey. (The customer
  `/track` page has a clean step timeline; the owner page has nothing like it.)
- Internal jargon (`out_for_delivery`, `handed_over`, `reconcile_needed`) leaks into
  the UI.
- The delivery address is **read-only** — there is no way for the owner to enter a
  better/cleaner address before booking a rider.

## Goals

1. One clear status source: a compact journey timeline, owner-facing.
2. Merge the duplicate payment cards.
3. Make the delivery address editable, and have edits flow into rider booking.
4. Apply the same redesign to both the owner and branch detail pages (shared
   components, no drift).

## Design

### New right-column layout (both pages)

1. **Status & fulfilment card** (headline) — built around a compact journey timeline
   (`Placed → Paid → Preparing/Scheduled → Out for delivery → Delivered`, with a
   pickup variant `… → Ready → Collected`). Shows done/current/upcoming states, a
   "Scheduled for …" line, and special banners (payment hold / reconcile / cancelled
   / preorder). The single primary next-action button sits under the timeline, plus
   the rider-live note, force-delivered fallback, and existing `DeliveryStatusPanel`.
2. **Payment card** (online only) — merged: method + status pill + expected-vs-reported
   mismatch + refund-owed badge + payment actions (recheck / accept / cancel-refund /
   mark-refunded). Branch staff (no payment caps) see method + status only.
3. **Customer card** — unchanged (name / phone / alt / email / WhatsApp).
4. **Delivery card** — now editable: an `✎ Edit` toggle reveals an inline form
   (address textarea + state field) that saves via a new endpoint. Below it, the
   existing booking flow (get options / pick courier / booked rider / cancel ride).

`StatHero` chips: the "Status" chip becomes the friendly journey label (current step)
instead of the raw status string.

### Status source of truth

A small pure helper `deriveOrderJourney(order)` in `apps/admin/src/lib/order-journey.ts`,
unit-tested, mirrors the customer `/track` logic but consumes the admin `Sale` shape.
Returns ordered steps with `done | current | upcoming` state, the current step label,
the fulfilment track (delivery vs pickup), and a `special` flag
(`none | payment_hold | reconcile | cancelled`). Rendered by a new
`apps/admin/src/components/OrderJourney.tsx`. Used by both admin detail pages.

The customer page and its `apps/customer/src/lib/order-journey.ts` are intentionally
left untouched (an admin-side helper is lower risk than refactoring across apps).

### Editable delivery address (backend)

New endpoint in `apps/api/src/routes/sales.ts`:

```
PATCH /branches/:branchId/sales/:id/delivery-address
  guard: requireBranchScope() + requireAnyCapability("orders.manage", "pos.sell")
  body:  { address: string (1..500), state?: string | null }
  effect: update saleOrder.deliveryAddressFormatted + deliveryState (+ updatedAt)
  audit:  "sale.edit_delivery_address" with before -> after
  reject: channel === "walkup" (409); status in [delivered, cancelled] (409)
```

The rider-booking flow (`delivery-admin.ts`) already reads
`o.deliveryAddressFormatted` and `o.deliveryState` first (falling back to the
customer default address), so an edited address flows into "Get delivery options" /
booking automatically — no extra wiring.

Access: matches who already advances fulfilment and books riders — owner/admin/manager
(`orders.manage`) and branch staff with `pos.sell`.

## Out of scope

- No map/geocoder — plain address text + state (exactly what Shipbubble's validator
  consumes today).
- No change to the customer `/track` page or `apps/customer/src/lib/order-journey.ts`.
- No change to the money/reconcile path or the advance/cancel endpoints.

## Tests

- Unit: `deriveOrderJourney` across delivery vs pickup × paid / out_for_delivery /
  delivered / scheduled / preorder / confirmed / reconcile / cancelled.
- Integration: the new PATCH endpoint (auth gate; field update; audit row; walkup
  rejected; terminal status rejected).

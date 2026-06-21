# Customer Order-Tracking — Design

**Date:** 2026-06-21
**Phase:** 1 of 4 (Delivery/Online UX program)
**Status:** Draft for review

## Context

This is Phase 1 of a four-phase program to close UI gaps in the online + delivery
flow. The program decomposes into:

- **Phase 0 — Shared status taxonomy** (folded into Phase 1; first consumer is the
  customer screen)
- **Phase 1 — Customer order-tracking** ← this spec
- **Phase 2 — Owner delivery ops console**
- **Phase 3 — Branch fulfilment board**

Each phase gets its own spec → plan → implementation cycle.

### The delivery reality (drives the whole design)

The system has **three delivery paths** depending on order type:

1. **Live rider** — in-Lagos, immediate, in-stock orders auto-dispatch a Shipbubble/Bolt
   rider; status arrives via webhooks (`webhooks-bolt.ts`).
2. **Scheduled** — `scheduledDeliveryAt` set; dispatch bypassed, fulfilled manually.
3. **Coordinated** — outside Lagos (or live-courier disabled by flag); fee ₦0, the
   business arranges delivery and contacts the customer (WhatsApp).

Plus a **preorder overlay** (`isPreorder`): made-to-order, stock deducted at fulfilment.

The design is **hybrid**: the tracking screen renders a live rider stepper *when a rider
was actually dispatched*, and honest human-promise states otherwise. This matches both
current prod (live-courier flag OFF → mostly coordinated) and the future (flag ON →
live rider) with no rework.

## Problem — gaps this phase fixes

| Gap | Description |
|-----|-------------|
| C1 | Tracking page is a flat status string — no timeline, no "what's next" |
| C2 | No real "Track my order" entry point; relies on localStorage + URL |
| C3 | Abandoned Payaza popup leaves a silent 30-min reservation; no countdown/resume |
| C4 | "No delivery charge applied" is ambiguous — doesn't say *how* they receive it |
| X1 | Status pills re-implemented per screen; no canonical taxonomy |

**Out of scope (separate "checkout polish" pass):** structured address/autocomplete
(C5), basket preorder lead-time badge (C6). These are checkout-side, not post-purchase.

## Approach

**Chosen: order-status model.** A single pure function `deriveJourney(order)` returns the
track and an ordered list of steps with their state and timestamps. The UI only renders
steps — it contains no branching logic about scheduled vs rider vs coordinated. This is
the Phase 0 taxonomy seed; Phases 2 and 3 reuse the same model.

Rejected: per-screen bespoke variants (drifts, unmaintainable) and pure status pills
(can't express the three tracks or "what's next").

## The status model (Phase 0)

`apps/customer/src/lib/order-journey.ts` — pure, no I/O, unit-tested.

```ts
type Track = "live" | "scheduled" | "coordinated";
type StepState = "done" | "current" | "upcoming";
interface Step { key: string; label: string; state: StepState; at?: string /* iso */ }
interface Journey {
  track: Track;
  steps: Step[];
  currentStep: Step;
  methodLabel: string;     // honest "how you'll receive it" line (C4)
  isPreorder: boolean;
}
function deriveJourney(order: TrackingOrder): Journey;
```

**Track selection (in priority order):**

1. `deliveryState` outside Lagos **or** no rider was dispatched and not scheduled → `coordinated`
2. `scheduledDeliveryAt` present → `scheduled`
3. a `delivery` (rider) object exists → `live`
4. fallback → `coordinated`

**Steps per track** (customer language; `isPreorder` relabels "Preparing" → "In production 🥤"):

```
live:        Placed → Paid → Preparing → On the way [rider] → Delivered
scheduled:   Placed → Paid → Scheduled for {window} → Out for delivery → Delivered
coordinated: Placed → Paid → Arranging + WhatsApp → On the way → Delivered
```

**Step state** is computed from order fields:
- Placed: done once order exists
- Paid: done when `payment_status == paid` (`paid_at`)
- Preparing/Scheduled/Arranging: current after paid until next milestone
- On the way / Out for delivery: done/current from `out_for_delivery_at` or delivery status
- Delivered: done when `status == delivered` (`delivered_at`)

**Special statuses** (not steps — banner treatments):
- `confirmed` (unpaid) → payment-hold banner (C3)
- `reconcile_needed` → calm "we're confirming your payment" banner (never alarm)
- `cancelled` → cancelled banner + reorder

## API changes

### `GET /v1/orders/:orderNumber?phone=…` (in `public-orders.ts`)

Still phone-gated; mismatch returns the same `not_found` 404 (anti-enumeration). Add to
the response `data`:

| Field | Source |
|-------|--------|
| `items[]` `{ name, size_ml, quantity, unit_price_ngn, line_total_ngn }` | `saleOrderItem ⋈ product ⋈ productVariant` |
| `is_preorder` | `saleOrder.isPreorder` |
| `fulfilled_at` | `saleOrder.fulfilledAt` |
| `paid_at` | latest `payment.paidAt` for the order |
| `out_for_delivery_at` | `saleOrder.outForDeliveryAt` |
| `delivered_at` | `deliveryOrder.deliveredAt` (already joined) |
| `reservation_expires_at` | `min(stockReservation.expiresAt)` — only when `status==confirmed` && not preorder |
| `resume_payment` `{ reference, payaza }` | rebuilt via `buildPayazaCheckoutConfig` from the customer row — only when `status==confirmed` |
| `support_whatsapp` `{ url, number }` | `env.SUPPORT_WHATSAPP` + a prefilled `wa.me` template incl. order number |

`resume_payment` is only built and returned for unpaid orders, and only after the phone
check passes, so it exposes nothing an attacker could use.

### New env var

`SUPPORT_WHATSAPP` — the business WhatsApp number in international format (e.g.
`+2348012345678`). Used to build `wa.me` deep links with a prefilled "Hi, about order
#NNNN" message. Optional; when unset the WhatsApp button is hidden and the help card
falls back to existing contact info.

No DB migration — all timestamp columns already exist on `sale_order` / `delivery_order`
/ `payment`.

## Components (customer app)

Mobile-first; reuse storefront tokens (`--brand` deep green, `--brand-orange`,
`--cream`, `font-display`, `rounded-[1.5rem]`, framer-motion). Respect
`prefers-reduced-motion` (no pulsing when set).

| File | Responsibility |
|------|----------------|
| `src/lib/order-journey.ts` | Pure `deriveJourney` (Phase 0 taxonomy). No I/O. |
| `src/hooks/useCountdown.ts` | Ticks to a target ISO; returns `mm:ss` + `expired`. |
| `src/components/OrderTimeline.tsx` | Renders `Step[]` — vertical (mobile) / horizontal (desktop); `<ol>` with `aria-current` on the current step. |
| `src/components/RiderCard.tsx` | Track-A only: name, vehicle, masked phone (tap-to-call), ETA, "Track live" link. |
| `src/components/PaymentHoldBanner.tsx` | Countdown + "Complete payment" (relaunches Payaza via `resume_payment`); expired → reorder. |
| `src/components/OrderSummaryCard.tsx` | Line items + subtotal/delivery/total. Reusable. |
| `src/routes/order.$orderNumber.tsx` | Rewritten tracking page; consumes `deriveJourney`; polls every ~20s while non-terminal; `aria-live` status region. |
| `src/routes/track.tsx` | Lookup form: order number + phone → `/order/{n}?phone=…`. |
| Nav + footer | Add "Track order" link (replaces dead Account icon in Nav per storefront audit). |

## Data flow

```
checkout → POST /orders → Payaza popup
   ├─ paid (webhook flips order) → redirect /order/{n}?paid=1  (phone from localStorage)
   └─ popup dismissed → order stays 'confirmed'

/order/{n}?phone → server fn → GET /v1/orders/{n}?phone
   → deriveJourney(order) → render timeline + cards
   → poll every 20s until status terminal (delivered/cancelled)
   → if confirmed: PaymentHoldBanner uses resume_payment to relaunch launchPayazaCheckout

/track (lookup) → navigate to /order/{n}?phone=…
```

## States (exhaustive)

| State | Treatment |
|-------|-----------|
| loading | Skeleton: hero + 5-step timeline shimmer + card skeletons |
| `confirmed` + hold valid | Payment-hold banner with live countdown + "Complete payment" |
| `confirmed` + hold expired/swept | "Hold released — items returned. [Reorder]" |
| `reconcile_needed` | Calm: "We're confirming your payment — we'll message you." No alarm. |
| `paid` / preparing / OTW / `delivered` | Track-appropriate timeline + cards |
| `cancelled` | "This order was cancelled." + [Reorder] |
| not found / phone mismatch | Single honest line (matches API anti-enumeration 404) |
| network error | Retry button; keep last good data |

Accessibility: timeline is an ordered list, current step `aria-current="step"`; poll
updates announced via `aria-live="polite"`.

## Testing

- **Unit (`order-journey.test.ts`)** — table-driven over every combination: live /
  scheduled / coordinated / preorder overlay / confirmed / reconcile_needed / cancelled /
  delivered. Asserts track, step states, current step, methodLabel.
- **Unit (`useCountdown.test.ts`)** — counts down, flips `expired`.
- **API (`online-order` integration)** — tracking GET returns the new fields; `resume_payment`
  present only when `confirmed`; phone mismatch → 404; `reservation_expires_at` only for
  unpaid non-preorder.
- **Component (optional)** — render each track's timeline; held-payment banner countdown.

## Risks / notes

- Polling at 20s is light; stop on terminal status and on tab-hidden (Page Visibility) to
  avoid waste.
- `resume_payment` rebuild needs the customer email/name/phone — all on the `customer`
  row already resolved at order time.
- Live rider track is only exercised when `AUTO_DISPATCH_DELIVERY` is on; until then the
  `live` branch is dormant but fully built and tested via fixtures.
```
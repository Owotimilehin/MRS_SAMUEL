# Online-order fulfilment lifecycle + customer stock visibility

**Date:** 2026-06-24
**Status:** Approved for implementation
**Base:** origin/master `c055a8b`

## Problem

Seven related gaps reported by the owner:

1. Customers can't see available stock, so the store gives no buying signal and no
   "we can make more" reassurance.
2. Online sales from the storefront are not obvious to the owner — they only appear
   as an "awaiting fulfilment" filter and get lost between till sales.
3. The till gives no indication that a new online order arrived.
4. Delivery is broken on the order page: full delivery functionality is missing and
   branch staff can do nothing with an online order.
5. There is no way to complete an order and move it from "awaiting fulfilment" to
   actually delivered.
6. Cancelling an online order should not leave it counting as a sale.
7. The dashboard shows "Online orders today 14 / 72 awaiting fulfilment" — the
   awaiting number accumulates forever and is dishonest.

## Root causes (verified in code)

- The `sale_status` enum already has the full lifecycle
  (`confirmed → paid → handed_over → out_for_delivery → delivered`, plus
  `cancelled / failed / reconcile_needed`). Nothing **drives** a paid online order
  through it — only preorders have a `/fulfil` action.
- `/reports/overview` `online_pending` counts **all-time**
  `confirmed/paid/handed_over/out_for_delivery` online orders. It includes
  abandoned unpaid `confirmed` checkouts and never-completed orders, so it grows
  without bound (the "72").
- Branch staff have **no online-order detail page** at all (only till-sale,
  return, and preorder detail) — so they literally cannot act (#4).
- Owner order-detail has cancel-refund + ride booking, but **no** fulfilment
  lifecycle actions.
- `delivery_order` already models the full rider journey
  (`searching_rider, assigned, picked_up, in_transit, delivered, failed,
  cancelled` + rider name/phone/vehicle + tracking URL + timestamps) and the
  Shipbubble webhook maps every state — but **none of it is surfaced in any UI**.
- A walk-up till sale runs `confirmed → paid` and **stops at `paid`** (a
  non-terminal status). The `/hand-over` endpoint exists but the offline POS never
  calls it, so counter sales sit at "Paid" forever, reading as unfinished.
- Public catalog exposes only `preorder_only` per variant — no stock count (#1).

## Design decisions (locked with owner)

- **#1 stock:** show the **exact available count** per size when in stock, plus a
  graceful "Made to order — we can prepare more for you" line when
  `preorder_only` or `available <= 0`. Low-stock "order now" nudge at
  **`available <= 5`**.
- **#5 completion:** **channel-aware lifecycle**.
  Delivery: `paid → out_for_delivery → delivered`.
  Pickup: `paid → handed_over` (Ready) `→ delivered` (Collected).
- **#6 cancel:** unpaid `confirmed` orders **auto-expire** (worker sweep) after the
  payment window; paid orders are **soft-cancelled** (kept for refund/audit, already
  excluded from sales counts). No hard-delete. **Auto-cancel unpaid at 60 min**
  (hold is 30 min).
- **#2/#3 visibility:** prominent **count badge + dedicated Online Orders queue**
  on owner **and** till, an **on-screen toast/banner** on a newly-detected order,
  and a **chime at the till**.
- **#4 branch powers:** branch/till staff get **full branch-scoped fulfilment** on
  an online order (view, book/cancel ride, advance status) — no refunds, no
  cross-branch.
- **Rev A (rider states):** surface the full `delivery_order` rider journey in a
  **Delivery status panel** on owner + branch order-detail and customer tracking.
- **Rev B (till close-out):** counter / immediate-handover channels auto-advance to
  a **terminal "Completed" (`handed_over`)** state atomically inside `/pay`, so a
  normal till sale conclusively ends its cycle and never lingers at `paid`.
- **Chowdeck pickup removed** from channel selectors and counter-channel logic.
  The `chowdeck_pickup` enum value is **kept** (no destructive Postgres enum
  migration; legacy rows stay valid) but is no longer offered in the UI.

## How Shipbubble state drives the cycle (confirmed mapping)

`apps/api/src/routes/webhooks-bolt.ts` already mirrors the delivery webhook onto the
sale, forward-only and partial:

| Shipbubble raw | `delivery_status` | sale_order effect |
| --- | --- | --- |
| `pending` | `searching_rider` | none (stays `paid`) — "Finding a rider…" |
| `confirmed` / `acknowledged` | `assigned` | none — "Rider assigned" (+ rider info) |
| `picked_up` / `pickup` | `picked_up` | `paid → out_for_delivery` |
| `in_transit` | `in_transit` | `paid → out_for_delivery` |
| `completed` / `delivered` | `delivered` | `→ delivered` (from paid/out_for_delivery) |
| `cancelled` / `canceled` | `cancelled` | none — stays `paid`, emits ops event |
| `failed` / `returned` | `failed` | none — stays `paid`, emits ops event |

**Two tracks, one drives the other.** `delivery_order.status` is the granular rider
journey (updated every webhook); `sale_order.status` is the coarse queue state the
webhook collapses it into.

**Manual advance must not fight the webhook** — it is booking-aware:

| Situation | Who drives the cycle |
| --- | --- |
| Delivery booked via Shipbubble | **Webhook drives.** Staff watch the rider panel. Manual = a fallback "force delivered" + a **"Re-book rider"** action when `cancelled`/`failed`. |
| Delivery, no ride booked (manual / WhatsApp / outside-Lagos ₦0) | **Staff advance** `out_for_delivery → delivered`. |
| Pickup | **Staff advance** Ready (`handed_over`) → Collected (`delivered`). No rider track. |

The current real gap: `cancelled`/`failed` silently leave the order at `paid` with
nothing shown. The design surfaces it loudly (rider panel + re-book action, and it
feeds the same attention signal as a new order).

## Components

### API (`apps/api`)
- `public-catalog.ts` — add per-variant `available` (per-variant `availableAtBranch`
  against the online-default branch) to the catalog response.
- New `online-orders.ts` (or extend the existing online-orders routes):
  - `GET /online-orders/active` + `GET /online-orders/active-count?since=` — the
    queue feed + the badge/toast/chime delta. Owner = all branches; branch =
    `requireBranchScope`.
  - `PATCH /online-orders/:id/advance` — capability-gated, branch-scoped, channel-
    aware legal transitions only; sets `fulfilledAt` / `outForDeliveryAt` /
    timestamps. Rejects illegal transitions (409). For a live Shipbubble booking,
    only the fallback "force delivered" + re-book are allowed.
- `sales.ts` `/pay` — for counter channels (`walkup`, in-store `whatsapp`)
  atomically set status to `handed_over` (terminal "Completed") in the same
  transaction. Drop `chowdeck_pickup` from counter logic + the channel zod enum
  offered (value retained in DB enum).
- `reports.ts` `/overview` — redefine `online_pending` to **paid, non-preorder,
  not-yet-delivered/cancelled** online orders only (drop `confirmed`). Surface as a
  live work queue, not a daily figure.
- Delivery rider state already flows via `webhooks-bolt.ts`; add a `cancelled` /
  `failed` ops event consumer / attention bucket so staff are alerted to re-book.

### Worker (`apps/worker`)
- New (or extend) sweep job: mark `confirmed` online orders whose
  reservation/payment window passed **60 min** as `cancelled` (reason
  `payment_expired`) and release any hold. Reuse the existing reservation expiry +
  unpaid-reminder plumbing.

### Admin (`apps/admin`)
- **Owner:** Online Orders queue route + nav badge; order-detail gains the
  channel-aware **advance buttons** and the **Delivery status panel** (rider
  journey). Keep existing ride book/cancel + cancel-refund.
- **Branch:** new `branch/online-order-detail.tsx` + branch Online Orders queue +
  nav badge; full branch-scoped fulfilment (view, book/cancel ride, advance,
  delivery panel). New-order **toast** + **chime** (poll-driven; degrades offline).
- Remove the `chowdeck_pickup` option from `branch/sell.tsx` and related channel
  types/labels.

### Customer (`apps/customer`)
- Product/catalog UI: per-size **exact count + made-to-order** display.
- Order tracking page: add the **Delivery status panel** (rider journey + tracking
  link), reading the enriched tracking API.

## Data flow

1. Customer browses → catalog shows per-size available count / made-to-order.
2. Customer checks out → `confirmed` (+30-min hold). Unpaid after 60 min →
   worker auto-cancels (`payment_expired`), leaves no sale.
3. Payment confirmed → `paid`. Counter sales (walk-up) instead terminate at
   `handed_over` ("Completed") right at `/pay`.
4. New paid online order → appears in the Online Orders queue; badge increments;
   toast + chime fire at the till; owner dashboard badge updates.
5. Staff fulfil:
   - Delivery + Shipbubble ride: book ride → webhook advances
     `out_for_delivery → delivered`; rider panel shows the journey; cancelled/failed
     surfaces a re-book action.
   - Delivery, no ride / Pickup: staff click advance buttons.
6. `delivered` (or `cancelled`) drops the order out of `online_pending`; the
   dashboard count drains to reality.

## Error handling

- `advance` enforces legal transitions server-side (409 on illegal), branch scope
  (`requireBranchScope`), and capability gates. Idempotent re-clicks are no-ops.
- Webhook stays idempotent (existing terminal-status guard).
- Auto-cancel sweep is idempotent and only touches unpaid `confirmed` past the
  window; never touches a paid order.
- Poll-driven toast/chime degrade gracefully when the till is offline.

## Testing

- API integration: per-variant catalog `available`; `advance` legal + illegal
  transitions + branch-scope + capability; counter sale terminates at
  `handed_over`; corrected `online_pending`; auto-cancel sweep (unpaid expired →
  cancelled, paid untouched).
- Domain/unit: Shipbubble status mapping already covered; add coverage for the
  re-book / cancelled-failed surfacing if logic is added in domain.
- Manual: 🔴 PWA hard-refresh on tills after deploy; not eyeball-tested until a real
  online order + real Shipbubble booking confirm end-to-end.

## Out of scope

- Customer-initiated refunds / fulfilled-order refunds (existing Phase-2 returns).
- Real-time push (websockets) — polling is sufficient for this volume.
- Dropping the `chowdeck_pickup` enum value from Postgres.

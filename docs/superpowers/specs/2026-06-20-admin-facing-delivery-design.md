# Admin-facing delivery + WhatsApp arrangement — design

**Date:** 2026-06-20
**Status:** Approved (pending spec review)

## Problem

Today the **customer** drives delivery at checkout: the storefront calls Shipbubble
for live courier rates (Lagos + "deliver now" only), the customer picks a courier,
pays the quoted fee, and a `delivery.request` outbox event makes the worker
auto-book the ride. This is fragile — it depends on a funded Shipbubble wallet at
the moment of checkout, exposes raw courier pricing to the customer, and gives the
business no control over which ride is booked.

The business wants the opposite model: **the customer never sees couriers or a
delivery fee.** They just get told they'll be contacted on WhatsApp. The **admin**
then opens the order, books the ride in-app using the details the customer already
provided, and relays the rider's number to the customer over WhatsApp.

## Goals

1. Customer checkout collects delivery details but shows **no courier options and
   no delivery fee** — a calm "we'll contact you on WhatsApp" notice instead.
2. The admin **online-order detail page** becomes a full-fledged delivery
   workstation: fetch live courier options, pick one, book the ride, see the
   rider's number + tracking, and one-click WhatsApp the customer.
3. The existing customer-driven live-quote flow and worker auto-dispatch are **set
   aside, not deleted** — gated behind flags (default off) so the old behavior is
   recoverable by flipping a flag.
4. Fix the Shipbubble webhook parser bug discovered in the audit so rider
   status/number actually flow back.

## Non-goals (Phase 2)

- **Automated server-sent WhatsApp** (WhatsApp Business API via Meta Cloud API or
  Twilio). We have no credentials today. The admin sends the message themselves via
  a pre-filled `wa.me` deep link. Documented here for a later phase.
- Charging the customer any delivery fee online. Delivery cost is settled with the
  customer on WhatsApp out-of-band.

## Approach

**Admin books via a two-step in-app flow (chosen over one-click cheapest):** the
order page fetches live Shipbubble rates, lists couriers with fee + ETA, the admin
picks one and confirms, then we create the label. Because the customer settles the
cost on WhatsApp, the admin must *see the price before booking* — so showing
options and picking is the right fit, not silently auto-picking the cheapest.

## Design

### 1. Feature flags (set the old path aside)

Two flags, both default **off**, preserve the legacy code paths without deleting them:

- **`LIVE_COURIER_QUOTES`** (customer app, build-time constant, default `false`):
  when off, the checkout renders the new "we'll WhatsApp you" notice and skips the
  live-quote effect; when on, the old courier picker returns. Implemented as a
  single exported constant so flipping it restores the prior UI verbatim.
- **`AUTO_DISPATCH_DELIVERY`** (API env, default `false`): gates the
  `delivery.request` outbox emission in `webhooks-payaza.ts` and
  `preorder-shared.ts`. When off, paying for an order no longer auto-books a ride.
  The worker's `dispatchDeliveryFromEvent` stays untouched in the codebase.

### 2. Customer checkout (`apps/customer/src/routes/checkout.tsx`)

- Guard the live-quote `useEffect`, the courier option list, and the fee math
  behind `LIVE_COURIER_QUOTES`. When off:
  - `deliveryFee` is always `0`; `total = subtotal`.
  - `placeOrder` sends `delivery_fee_ngn: 0` and omits `delivery_quote_id`.
  - The "Delivery" section renders one notice: **"We'll contact you on WhatsApp to
    arrange delivery and confirm the cost."**
- **Keep** address, delivery state, phone, name, and the preorder day/window picker
  (`scheduled_delivery_at`) — production timing still matters and these are the
  details the admin books with.
- The "Deliver now / live courier today" toggle is hidden when the flag is off; the
  scheduling UI for preorders remains.

### 3. API — stop auto-dispatch + new admin endpoints

**Stop auto-dispatch:** wrap the `delivery.request` emission in both
`webhooks-payaza.ts` and `preorder-shared.ts` with the `AUTO_DISPATCH_DELIVERY`
check. Update the affected integration tests in `online-order.test.ts` to assert
the event is **not** emitted when the flag is off (and still emitted when on).

**New admin endpoints** (mounted under the existing branch-scoped sales routes;
owner/admin capability; online channel only; reject walk-up/POS orders):

- `GET  /branches/:branchId/sales/:saleId/delivery/options`
  Runs `ShipbubbleClient.quote()` (validate receiver + fetch_rates) using the
  order's stored dropoff address, delivery state, customer name/phone. Returns
  `{ quote_token, validated_address, options: [{ id, courier_name, fee_ngn,
  eta_minutes }] }`. `id` encodes `requestToken::courierId::serviceCode`.
- `POST /branches/:branchId/sales/:saleId/delivery/book`  body `{ option_id }`
  Calls `dispatchByReceiverCode` (or `dispatch`) to create the label, inserts a
  `delivery_order` row (provider `shipbubble`, externalRef, actual fee, tracking,
  rider info if already present), sets `sale_order.deliveryProviderRef`. Idempotent:
  409 if a non-cancelled `delivery_order` already exists for the sale.
- `POST /branches/:branchId/sales/:saleId/delivery/cancel`
  Cancels the label via `cancelLabel` and marks the `delivery_order` cancelled.

**Sale-detail response:** add `customerName` and `customerPhone` (from the joined
`customer` row) to the `/branches/:branchId/sales/:saleId` payload so the order page
can build the WhatsApp link. Extend the returned `delivery` object to include
`riderPhone`, `actualFeeNgn`, and `provider: "shipbubble"`.

These endpoints reuse the existing `getDeliveryProvider()` / `ShipbubbleClient`; no
new client code.

### 4. Admin order page (`apps/admin/src/routes/owner/order-detail.tsx`)

Rework the Delivery card into the booking workstation:

- **No delivery yet:** a **"Get delivery options"** button → calls the options
  endpoint → renders couriers (name · fee · ETA) as selectable rows → **"Book
  ride"** opens a `ConfirmModal` showing the chosen fee (it debits the Shipbubble
  wallet) → on confirm, calls the book endpoint and refreshes.
- **Booked:** show status, rider name/phone, actual fee, **"Track →"** link, and a
  **"WhatsApp customer"** button → `https://wa.me/<normalized customer phone>` with
  a pre-filled message containing the rider name + number + tracking link. Also a
  **"Cancel ride"** action (before pickup).
- Replace the stale "Bolt not dispatched — arrange manually" banner. Keep the
  existing "mark delivered" path if present.
- Phone normalization for `wa.me`: strip non-digits; convert leading `0` to `234`.

### 5. Webhook parser fix (`packages/domain/src/shipbubble.ts`)

- `parseShipbubbleWebhook`: read **root-level** `order_id` and `status` (the docs'
  literal payload places them at the top level, not under `data`). Keep `data.*` as
  a fallback. Without this, every webhook returns null and rider status never
  advances past "searching_rider".
- Extend it to extract rider **name/phone** from `courier.rider_info` (and/or
  `courier.name`/`courier.phone`) so the API webhook handler can persist
  `riderName`/`riderPhone` on the `delivery_order`, auto-updating the order page.
- Add a unit test asserting a root-level `shipment.status.changed` payload (with
  rider info) parses correctly, and that the old nested shape still parses via the
  fallback.

### 6. Data model

No migration required. `delivery_order` already has `provider` (incl.
`shipbubble`), `riderName`, `riderPhone`, `actualFeeNgn`, `trackingUrl`, `status`,
and the full status-timestamp set. We reuse them.

## Error handling

- Options/book endpoints surface Shipbubble failures (no couriers for route,
  insufficient wallet, invalid address) as a `BusinessError` with a readable
  message the admin sees inline. Booking never partially commits — the
  `delivery_order` row is inserted only after the label call succeeds.
- Booking is idempotent (409 on existing live delivery) to prevent double-charging
  the wallet on a double-click.
- If the customer has no phone/address on the order, the options button is disabled
  with an explanatory note (admin must collect details and arrange fully manually).

## Testing

- API integration: options endpoint returns couriers for a valid online order;
  book endpoint creates a `delivery_order` + is idempotent; auto-dispatch is gated
  by `AUTO_DISPATCH_DELIVERY` (off → no event, on → event). Uses the mock provider.
- Domain unit: webhook parser root-level + rider-info extraction + nested fallback.
- Manual: customer checkout shows the WhatsApp notice and ₦0 delivery; admin books
  a ride end-to-end against Shipbubble sandbox; WhatsApp button opens a correct
  pre-filled `wa.me` link.

## Rollout

- Deploy with `LIVE_COURIER_QUOTES=false` and `AUTO_DISPATCH_DELIVERY=false`.
- Requires a funded Shipbubble wallet and `SHIPBUBBLE_WEBHOOK_SECRET` set for live
  booking + status callbacks.
- 🔴 PWA hard-refresh for existing admin sessions to load the new order page.

## Open items / future

- Phase 2: automated WhatsApp via Business API (needs credentials + approved
  template + customer opt-in).
- Decide whether to record the (out-of-band) delivery fee the admin quotes the
  customer back onto the order for reporting — deferred.

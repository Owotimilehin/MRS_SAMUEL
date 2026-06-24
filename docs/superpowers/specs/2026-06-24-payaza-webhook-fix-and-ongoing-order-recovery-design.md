# Payaza webhook fix + ongoing-order browser recovery — Design

Date: 2026-06-24
Status: Approved (pending written-spec review)

## Context

Live end-to-end test on prod (order `SO-2026-00380`, real ₦4,500 GTBank
transfer) surfaced two payment-reliability bugs and one product gap:

1. **Webhook reads the wrong reference.** Payaza's callback carries *both* its
   own `transaction_reference` (`P-C-…`) and our `merchant_transaction_reference`
   (`SO-…`). The handler reads `data.transaction_reference` first, so it verifies
   by Payaza's internal id. Payaza's verify endpoint searches by **merchant**
   reference, so it answers "Transaction not found" → the webhook no-ops on every
   real payment. The order only got confirmed by a fallback path (on-view
   re-verify), which is why the webhook logged `PENDING` and there was no
   `order marked PAID` line. Proven directly: querying Payaza by `P-C-…` = 400
   not found; by `SO-2026-00380` = `Completed`, `amount_received 4500`.

2. **Reconcile sweep recovers too few orders.** The deployed sweep only
   re-checks `confirmed` orders that still hold a **live stock reservation**,
   silently skipping (a) preorders (which never reserve stock) and (b) orders
   whose hold lapsed before recovery. A corrected version (drop the reservation
   gate, bound by a 48h lookback window) already exists uncommitted in the
   working tree.

3. **"Lost tab" recovery gap.** At checkout, phone is always captured but email
   is optional, and the only outbound channels are email (customer) and Telegram
   (owner). A phone-only customer who loses their tab gets no notification and
   cannot recall their order number (the `/track` lookup needs order number +
   phone). The user chose **no new provider (SMS/WhatsApp)**; instead persist the
   ongoing order in the browser and surface it, clearing it once the order is
   complete.

## Goals

- Make the Payaza webhook confirm real payments on its own (primary path), not
  only via fallbacks.
- Make the reconcile sweep recover every genuinely-paid stuck order, including
  preorders and lapsed-hold orders.
- Let a customer who closed their tab find and resume/track an in-progress order
  from any page of the storefront, on the same browser, with zero new infra.

## Non-goals

- No SMS / WhatsApp / push provider (explicitly deferred).
- No customer accounts/login for guests; identity stays "possession of
  (order number + matching phone)".
- No cross-device recovery (localStorage is per browser-profile by design).

---

## Fix 1 — Webhook merchant-reference extraction

**File:** `apps/api/src/routes/webhooks-payaza.ts`

Change reference extraction to prefer the **merchant** reference (our order
number), which is what `verifyPayazaTransaction` queries Payaza by:

```
const reference =
  p.data?.merchant_transaction_reference ??
  p.data?.merchant_reference ??
  p.merchant_transaction_reference ??
  p.merchant_reference ??
  // legacy/fallback shapes
  p.data?.transaction_reference ?? p.data?.reference ??
  p.transaction_reference ?? p.reference;
```

- `SUB_<id>` subscription routing is unchanged (those references are our own
  merchant references already).
- The handler still treats the callback as a wake-up only and re-verifies
  server-to-server; no money decision trusts the body.

**Testing (TDD, red→green):** add a unit/integration test that POSTs the **real
captured Payaza callback shape** — containing both `transaction_reference`
(`P-C-…`) and `merchant_transaction_reference` (`SO-…`) — and asserts the handler
verifies by, and marks paid, the `SO-…` order. Keep an assertion that a
body with only Payaza's internal ref does not confirm a wrong/absent order.

**Acceptance:** a real payment's webhook call alone flips the order to `paid` and
emits `sale.paid_online` (verified by the `order marked PAID` log line), with no
dependence on the customer viewing tracking.

---

## Fix 2 — Reconcile sweep covers preorders + lapsed holds

**File:** `apps/worker/src/jobs/payaza-reconcile.ts` (corrected version already in
working tree)

- Remove the `exists(stockReservation …)` gate.
- Bound candidates by time only: `confirmed` AND `created_at < now-90s` AND
  `created_at > now-48h`.
- Sweep continues to re-fire the webhook by **order number** over HTTP (single
  money path stays in the webhook/`applyPayazaConfirmation`).

**Testing:** run the updated `apps/worker/test/payaza-reconcile.test.ts` (covers
preorder recovery + lapsed-hold recovery + the 48h bound). Commit with Fix 1.

**Note:** Also fold in the already-uncommitted hygiene changes that are part of
the same working tree and inert on prod (removal of the dormant Mock/fake-success
shim in `payaza.ts` / `customer/lib/payaza.ts` / `api/types.ts`, and the
`mrssamueljuice.com` → `mrssamuel.com` fallback URL fix in `outbox.ts`). They
carry no behavior change on prod (live key set; `PUBLIC_*_URL` env set) but
remove a latent fake-success path and a wrong-domain fallback.

---

## Feature 3 — Ongoing-order browser banner (self-clearing)

A client-only component surfaced in the customer site layout.

### Identity & trust model
- Storage is `localStorage`, already written at checkout as
  `ms_track_<orderNumber> = { phone }` (`checkout.tsx`). Per browser-profile +
  origin — never shared across devices/browsers.
- The banner never trusts storage to render: for each entry it calls the
  existing `trackOrder({ orderNumber, phone })`, and the API enforces
  `phonesMatch(order.phone, phone)`. It can only show an order whose real phone
  matches the stored one; a forged/mismatched entry fails and is pruned.
- Scope is therefore "orders placed from this browser," each independently
  re-authorized server-side.

### Behaviour
- On client mount: enumerate `localStorage` keys with prefix `ms_track_`, parse
  `{ phone }`, and fetch each order's tracking status.
- Render a compact pill per **active** order:
  `🧃 <orderNumber> · <status label> · Track →` linking to
  `/order/<orderNumber>`. For an unpaid/awaiting-payment order the CTA reads
  `Resume payment →` (rescues the lost-tab-mid-payment case).
- **Minimal info only** in the pill: order number + status label. No name,
  address, or items.
- **Frictionless auto-open:** tapping a pill opens `/order/<orderNumber>`, which
  already auto-loads from the stored phone (no re-entry). (Chosen over a last-4
  confirm; the personal-phone case is dominant and matches existing `/order`
  behaviour.)
- A manual **"✕ Done"** dismisses a pill (removes its key).
- Polls while mounted, reusing the order page's existing interval cadence.
- SSR-safe: renders nothing on the server; hydrates after client mount with a
  `typeof window` guard.

### Self-clearing rules
Delete the `ms_track_<orderNumber>` key when any of:
- Order reached a **terminal** state — `delivered`, `cancelled`, `refunded`, or
  `fulfilled` (pickup handed over) — i.e. `deriveJourney` reports the journey
  done or specially cancelled.
- The tracking call returns **not found** (stale/forged entry).
- The entry is **older than 48h** (defensive prune for orders that never reach a
  clean terminal state, e.g. abandoned-unpaid that expired). To support this, the
  checkout write is extended to `{ phone, placedAt: <ISO> }`; entries lacking
  `placedAt` are treated as legacy and pruned on first terminal/not-found.

### Files (anticipated)
- `apps/customer/src/components/OngoingOrders.tsx` — the banner/pill component.
- A small helper `apps/customer/src/lib/ongoing-orders.ts` — enumerate, parse,
  prune localStorage entries (pure, unit-testable; `window` injected/guarded).
- `apps/customer/src/routes/checkout.tsx` — extend the stored payload with
  `placedAt`.
- Mount in the customer root layout route.

### Testing
- Unit-test the `ongoing-orders` helper: enumeration, terminal pruning,
  not-found pruning, 48h prune, legacy-entry handling. (No network; pass a fake
  storage + a fake `trackOrder`.)
- Component smoke test: renders pills for active entries, hides on empty, removes
  on terminal.

### Acceptance
- After checkout, closing the tab and reopening any storefront page on the same
  browser shows an "ongoing order" pill linking to live tracking (or resume
  payment if unpaid).
- When the order is delivered (or otherwise terminal), the pill disappears and
  its localStorage entry is gone.
- Two orders from the same browser show two pills; a different browser shows
  none of them.

---

## Sequencing

1. **Fixes 1 + 2 first**, in one commit/deploy — they protect real money now
   (every live payment currently depends on fallbacks). TDD, full test run,
   deploy, verify `order marked PAID` on the next real (or simulated-by-order-
   number) confirmation.
2. **Feature 3** second — customer-frontend only, no backend/migration.

## Risks / tradeoffs

- **Shared-browser exposure:** on a genuinely shared browser, all orders placed
  there are visible to the next user (inherent to no-login + browser scope).
  Mitigated by minimal pill info, terminal auto-clear, and 48h prune; accepted
  given low-sensitivity data and the dominant personal-phone case.
- **Same-browser only:** does not help a customer who switches device; accepted
  per the no-provider decision. SMS/WhatsApp remains a future option that would
  also enable cross-device + proactive push and OTP-gated phone lookup.

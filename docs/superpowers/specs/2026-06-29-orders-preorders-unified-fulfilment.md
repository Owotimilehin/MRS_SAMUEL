# Unified online-order / preorder fulfilment + till nav consolidation

Date: 2026-06-29
Status: approved (design), not yet implemented

## Problem

One `sale_order` row can be **both an online order and a preorder**. Today it is
attended to through two disconnected screens whose list queries and fulfil actions
do not reconcile, so fulfilling it once does not mark it fulfilled everywhere.

| | Preorders page | Online orders page |
|---|---|---|
| List query | `is_preorder ∧ status='paid' ∧ fulfilled_at IS NULL` | `channel∈(online,phone) ∧ status∈(paid, out_for_delivery)` — ignores `is_preorder` **and** `fulfilled_at` |
| Action | "Fulfil" → deduct stock, stamp `fulfilled_at`; for online/phone it deliberately leaves `status='paid'` | detail → "Advance": `paid → out_for_delivery/handed_over → delivered`; does not touch stock |

Concretely: fulfilling an online preorder on the Preorders page deducts stock and sets
`fulfilled_at`, so it leaves the Preorders list — **but its status stays `paid`, so it is
still on the Online orders list, looking identical to before.** There is no on-screen
signal the produce step happened, and to actually clear it the operator must open the
order and "Advance" it — a second action on a second screen. This is the reported
"I can't fulfil it in one go; I fulfilled the preorder but it was still active on the
online order page." The same code/endpoints back both the till (branch) and owner
screens, so the bug exists identically in both.

### Root causes

1. **Overloaded `fulfilled_at`.** It means "stock produced/deducted" when set by the
   preorder fulfil, but "delivered/complete" when set by `advance`. One column, two
   meanings, so no query can reliably separate "preorder awaiting production" from
   "produced, awaiting handover/delivery."
2. **Online queue is not stage-aware.** `/online-orders/active` keys only off
   `status`, ignoring `is_preorder` and any produced state, so a produced preorder is
   indistinguishable from an unproduced one.
3. **Two parallel actions, no shared lifecycle.** "Fulfil" (preorder) and "Advance"
   (online) write different fields and never reference each other.

### Stock-deduction timing (confirmed in code — the basis of the model)

| Order type | Order placed | Payment confirmed (`reconcile.ts`) | Fulfil / produce |
|---|---|---|---|
| Online, in-stock (not preorder) | stock **reserved** (`stockReservation`) | stock **deducted** (`stockLedger -qty`), reservation released | — (no produce step) |
| Online preorder | nothing reserved (made to order) | payment captured, **stock untouched** (`if (!o.isPreorder)`) | stock **deducted** (`preorder-shared.ts`) |
| Walk-up / counter | — | — | deducted at sale |

So an in-stock online order's stock is already gone by the time it is paid; a
preorder's stock is not touched until "Fulfil". The Fulfil/produce step **is** the
preorder's stock-deduction moment.

## Goals

1. One coherent lifecycle for an online order regardless of preorder status; both the
   Online lens and the Preorder lens read/write the same server state.
2. Fulfilling once is reconciled everywhere — a produced preorder never re-appears as
   "awaiting production" in either lens.
3. The order detail page drives the whole flow top-to-bottom in one place
   (produce → hand over / out for delivery → delivered).
4. Apply identically to till (branch) and owner via shared logic/components — no drift.
5. (Part 2) Declutter the till nav from 13 items to 7 by merging related pages.

## Non-goals

- No change to the money / Payaza reconcile path, refund flow, or order-creation
  reservation logic (already correct for preorders).
- No new status enum value — stage is *derived* from existing status + `produced_at`,
  avoiding a churn of every status pill / enum consumer.
- No change to the customer `/track` page or `apps/customer/src/lib/order-journey.ts`.
- No change to counter (walk-up / whatsapp) preorder behaviour beyond also stamping
  the new produced timestamp.

## The unified lifecycle

```
In-stock online order:
  paid ───────────────────────────► Hand over / Out for delivery ──► Delivered ✅
  (stock already deducted at payment)

Delivery preorder (has delivery address / fee / ride):
  paid ──► [Fulfil = produce] ──────► Out for delivery ──► Delivered ✅
           (stock deducted here;       (now identical to an in-stock delivery order;
            produced_at set;            never shows "Awaiting production" again)
            status stays paid)

Pickup preorder (no delivery — incl. counter walkup/whatsapp, customer collects):
  paid ──► [Fulfil = produce + hand over] ──► done ✅
           (stock deducted + status → handed_over in one tap)
```

A preorder is simply a normal online order with an **extra "produce" step at the
front**, because its stock was not reserved up front. After produce a delivery
preorder *becomes* a normal ready delivery order; a pickup preorder is complete.

**Pickup vs delivery** is determined exactly as `advance` already determines it: an
order is *delivery* if it has a `delivery_address_formatted`, a `delivery_state`, a
`delivery_fee_ngn > 0`, or a `delivery_order` row; otherwise it is *pickup*. (Counter
channels walkup/whatsapp are naturally pickup, preserving today's behaviour, but the
rule is now the fulfilment type — not the channel.)

## Part 1 — Lifecycle + queue reconciliation

### Data model (one migration)

Add to `packages/db/src/schema/sale-order.ts` and a new migration:

```
produced_at          timestamptz NULL
produced_by_user_id  uuid NULL  (FK app_user, like fulfilled_by_user_id / recorded_by)
```

Stage is derived (no stored stage column):

| Derived stage | Condition |
|---|---|
| Awaiting production | `is_preorder ∧ produced_at IS NULL` (status `paid`) |
| Ready — hand over / dispatch | status `paid` ∧ (`¬is_preorder` ∨ `produced_at IS NOT NULL`) |
| Out for delivery | status `out_for_delivery` |
| Handed over / Delivered (done) | status `handed_over` / `delivered` |
| Pending pay / Cancelled | status `confirmed` / `cancelled` (unchanged) |

Migration also adds/adjusts an index supporting the production-queue filter, e.g.
`(is_preorder, produced_at)` or extends the existing `idx_sale_order_preorder_status`.

### API changes

1. **`apps/api/src/routes/preorder-shared.ts`**
   - `fulfilPreorderTx`: set `produced_at = now` and `produced_by_user_id = auth.userId`.
     Decide by **fulfilment type** (delivery vs pickup), not channel:
     - *Pickup* (no delivery address/state/fee/ride — incl. counter walkup/whatsapp):
       `status → handed_over` **and** set `fulfilled_at` (complete — customer collects).
     - *Delivery*: keep `status = paid` (now correctly "Ready"), and **do not** set
       `fulfilled_at` (that now means delivered, set later by `advance`).
     Stock deduction unchanged. Use the same delivery-vs-pickup predicate as `advance`.
   - `listOpenPreorders`: filter on **`produced_at IS NULL`** (was `fulfilled_at IS NULL`).
2. **`apps/api/src/routes/online-orders-queue.ts`** (`/active` and `/active-count`)
   - Select `produced_at`; return it plus a derived `stage` string in the row payload.
   - `/active-count` keeps counting all active online orders (badge semantics
     unchanged), but the per-row `stage` lets the UI label each correctly.
3. **`apps/api/src/routes/sales.ts` — `/:id/advance`**
   - Guard: if `o.isPreorder ∧ o.producedAt == null`, reject with
     `409 "Produce this preorder before handing it over."` Prevents dispatching
     un-made juice. After produce, advance behaves exactly as today.
4. **Reconcile / public-orders** — no change.

### Both lenses, same actions

- Online order **detail** page (branch + owner): the single primary button is
  stage-driven —
  - `is_preorder ∧ ¬produced` → **"Fulfil & produce"** → calls the produce endpoint
    (the same `PATCH /branches/:branchId/preorders/:id/fulfil` used by the Preorders
    list).
  - produced (or non-preorder) `paid` → **"Hand over"** / **"Mark out for delivery"**
    (existing `advance`).
  - then **"Mark delivered"** (existing `advance`).
- Preorders **list** (branch + owner): the existing "Fulfil" action is unchanged but
  now sets `produced_at`; because the online queue keys off `produced_at`, the order's
  label there updates automatically — the two lenses reconcile with no extra wiring.

### UI changes (shared, no drift)

- `apps/admin/src/lib/order-journey.ts` (`deriveOrderJourney`) — make the
  "Preparing/Produced" step done/current based on `produced_at` (was inferred from
  status only); add `produced_at` to the admin `Sale` shape it consumes. Unit-tested.
- `apps/admin/src/routes/branch/online-order-detail.tsx` and
  `apps/admin/src/routes/owner/order-detail.tsx` — stage-driven primary action incl.
  "Fulfil & produce"; share a small helper for the action/label decision so both pages
  stay in lockstep.
- `apps/admin/src/routes/branch/online-orders.tsx` and
  `apps/admin/src/routes/owner/online-orders.tsx` — replace the flat
  `statusPill + Preorder pill` with the derived stage label.
- `apps/admin/src/routes/branch/preorders.tsx` and `apps/admin/src/routes/owner/preorders.tsx`
  — copy/labels clarify this is the production worklist; behaviour keyed off produced
  state.
- Sales list (`apps/admin/src/routes/branch/sales.tsx`) — use the same stage labels so
  a produced/active order is never mislabeled.

### Tests (Part 1)

- Unit: `deriveOrderJourney` across `produced_at` × {preorder, non-preorder} ×
  {delivery, pickup} × each status, asserting step states + current label.
- Integration:
  - Delivery preorder produce → `produced_at` set, stock ledger `-qty` rows written,
    `status` stays `paid`, `fulfilled_at` still null, order absent from
    `listOpenPreorders`, present on `/online-orders/active` flagged produced/"Ready".
  - `advance` on an unproduced preorder → 409; after produce → succeeds
    (`paid → out_for_delivery`).
  - Pickup preorder produce (both an online no-delivery order and a counter walkup
    order) → `status='handed_over'`, `produced_at` and `fulfilled_at` both set, order
    absent from both lenses' active queues.
  - Reconciliation: a produced online preorder is gone from the Preorders lens and
    correctly staged in the Online lens (the reported bug, now fixed).

## Part 2 — Till nav consolidation (13 → 7)

Independent of Part 1; implement as a second phase. Reduces
`apps/admin/src/components/BranchShell.tsx` `NAV` from 13 flat items to 7 by merging
related pages, each opening a page with a small tab strip. **Routes and URLs are
unchanged** — consolidation is additive (a shared tab strip + a shorter nav array),
matching the existing "each page owns its `BranchShell`" pattern.

| Nav item | Cap to show | Tabs / sub-pages |
|---|---|---|
| 🥤 Sell | `pos.preorder` | (single page) |
| 🏠 Today | `sales.view` | Overview · Sales (`/branch` + `/branch/sales`) |
| 🛒 Orders | `sales.view` ∨ `pos.preorder` | Online · Preorders — combined attention badge |
| 📊 Stock | always | On hand · Incoming (`/branch/stock` + `/branch/transfers`) — Incoming count badge |
| ↩️ Returns | `returns.create` | (single page) |
| 🗂️ Shift | any of start/end/history caps | Start *or* End (by shift state) · History |
| 📱 Device | always | Device · Sync queue (`/branch/device` + `/branch/queue`) |

### Mechanics

- **`<BranchTabs items={…} />`** — new shared component rendered just under each grouped
  page's header. Links to sibling routes, marks the active tab from the current path,
  and **hides tabs the operator lacks the cap for**. Pure item-filtering helper is
  unit-tested.
- **Nav parent visibility + active state** — a parent shows if the user can reach any
  of its tabs; it is highlighted active whenever the current path is any route in its
  group (prefix match, not just exact `to`).
- **Smart Shift** — the Shift nav target resolves on current shift state: no open shift
  → lands on Start; open shift → lands on End. Tab strip is contextual
  (`[Start, History]` when closed, `[End, History]` when open); History always present.
- **Badges** —
  - Orders badge = online-order signal count **+** preorder count, summed into one pill.
  - Stock badge = count of incoming transfers in `dispatched`/`in_transit`/`arrived`
    ("to receive"), polled on the same 60s + on-focus cadence already used for
    preorders; pill shown when > 0. (Explicitly requested.)

### Tests (Part 2)

- Unit: nav-collapse + cap-aware parent visibility; prefix-based active matching;
  combined-Orders-badge math; `<BranchTabs>` cap-filtering helper.

## Implementation order

1. Part 1 (the reported bug) — migration → API → shared journey/detail → list labels →
   tests.
2. Part 2 (nav declutter) — `<BranchTabs>` + shell nav + badges + smart Shift → tests.

## Deployment notes (project-specific)

- Migration numbering: latest applied is around `0059`; pick the next free number and
  verify the journal `when` timestamp is **above** the prior watermark (a low timestamp
  is silently skipped — prior shift-lifecycle outage).
- After deploy, tills/PWA need a hard refresh to load the new bundle.
- Eyeball-test with a **real** online preorder end-to-end (produce → online lens shows
  "Ready" → hand over/deliver → gone) before calling it done — prior preorder work was
  shipped without a real-order test.

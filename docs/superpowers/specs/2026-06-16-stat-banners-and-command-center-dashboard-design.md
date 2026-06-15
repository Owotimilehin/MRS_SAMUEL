# Stat banners + command-center dashboard — design

Date: 2026-06-16
Status: Approved for planning
Surface: `apps/admin` (owner, branch, factory routes) + one new `apps/api` reports endpoint

## Goal

Give every admin page an informative header banner carrying 2–4 **live stat chips**
(the look already shipped on Products), and turn the owner Dashboard into a real
at-a-glance **command center** (stock alerts, orders/preorders, today-vs-yesterday,
money & growth).

This is a UI/visibility feature. It introduces no new write paths and no schema
changes. It reads data the app already exposes, plus one consolidated read endpoint
for the dashboard.

## Non-goals

- No new business logic, mutations, or migrations.
- No redesign of existing tables/cards below the banner — banners are additive.
- No banner on the POS/Sell register (`branch/sell.tsx`) — kept lean for selling.
- No forced stats on Settings / Device pages — they get a plain title hero or nothing.

---

## Part 1 — Shared `StatHero` component

Products and Dashboard currently hand-roll the `.juice-hero` markup. Before rolling
it onto ~30 pages, extract a single reusable component so there is one banner to
maintain.

**File:** `apps/admin/src/components/StatHero.tsx`

```tsx
interface StatChip {
  label: string;            // "Low-stock SKUs"
  value: string | number;   // already formatted (use ngn() for money)
  tone?: "default" | "good" | "warn" | "danger"; // chip accent
}

interface StatHeroProps {
  eyebrow: string;          // "Catalogue"
  title: string;            // "Inventory"
  sub: string;              // one-line description
  chips?: StatChip[];       // 0–4; >4 is a lint-level smell, keep it scannable
  bottleSlug?: string;      // optional floating bottle (dashboard-style) instead of chips
  loading?: boolean;        // show skeleton chips while data resolves
}
```

Rules:
- Renders the existing `.juice-hero` / `.juice-hero__body` / `.hero-chip` markup —
  **no new CSS** beyond a small `tone` modifier on `.hero-chip` (amber/red border +
  value color), added once to `index.css`.
- `bottleSlug` and `chips` are mutually exclusive in the aside (bottle = dashboard,
  chips = everything else). If both given, chips win.
- `loading` renders chips as shimmer placeholders so the banner doesn't pop in.
- Products and Dashboard are refactored onto `StatHero` with **zero visual change**
  (snapshot the rendered look before/after).

**Tone semantics (consistent across all pages):**
- `danger` — needs action now (low stock, overdue, pending refund).
- `warn` — watch it (expiring soon, awaiting review, variance present).
- `good` — healthy / all clear.
- `default` — neutral count or money.

Chips switch tone by threshold (e.g. `lowStock > 0 ? "danger" : "good"`).

---

## Part 2 — Per-page stat banners

Every page below gets `<StatHero>`. **Source** marks where each chip's numbers come
from:
- **derived** — computed client-side from data the page already fetches (no API change).
- **+count** — page must fetch one extra lightweight number/list it doesn't today.

### Owner pages

| Route | Chips | Source |
|---|---|---|
| `dashboard` | command center (see Part 3) | new endpoint |
| `products` | Flavours · Regular · Special · Punch | derived (shipped) |
| `product-detail` | Sizes · Lowest price · In stock · Status | derived |
| `inventory` | Cans on hand · Low-stock SKUs · Expiring ≤48h · Stock value ₦ | derived |
| `orders` | Pending · Awaiting fulfilment · Delivered today · Refunded | derived |
| `order-detail` | Items · Total ₦ · Status · Channel | derived |
| `preorders` | Open · Cans reserved · Ready to convert · Overdue | derived |
| `packaging` | Bags in queue · Assembled today · Materials low | derived / +count |
| `customers` | Total · New this month · Repeat buyers · Subscribed | derived |
| `customer-detail` | Orders · Lifetime ₦ · Last order · Subscription | derived |
| `leads` | New · Contacted · Converted · This week | derived |
| `subscriptions` | Active · Paused · MRR ₦ · Due this week | derived |
| `bundles` | Active bundles · Avg discount · Items covered | derived |
| `closes` | In range · With variance · Net variance ₦ · Awaiting review | derived |
| `close-detail` | Expected ₦ · Counted ₦ · Variance ₦ · Status | derived |
| `returns` | Pending approval · Approved · Refunded ₦ · This month | derived |
| `return-detail` | Items · Refund ₦ · Reason · Status | derived |
| `transfers` (owner + root) | In transit · To receive · Completed · Flagged | derived |
| `transfer-detail` | Cans · From → To · Status · Variance | derived |
| `adjustments` | In range · Net delta cans · Top reason · By you | derived |
| `vendors` | Vendors · Active · Spend this month ₦ | derived / +count |
| `factories` | Factories · Active runs · Output today | derived / +count |
| `branches` | Branches · Active · Top by net · Devices online | derived / +count |
| `branch-detail` | Net (range) ₦ · Orders · Stock value ₦ · Devices | derived |
| `devices` | Registered · Online · Offline · Last sync | derived |
| `zones` | Zones · Active · Branches covered | derived |
| `users` | Users · By role (owner/admin/…) · Active · Pending invites | derived |
| `audit-log` | Events today · Writes · Logins · Distinct actors | derived |
| `blog` | Posts · Published · Drafts | derived |
| `bookkeeping` | Revenue ₦ · Expenses ₦ · Profit ₦ · Margin % | derived (uses `/reports/pnl`) |
| `review` | Items to review · Transfer variances · Return approvals | derived |
| `settings` | plain title hero, no chips | n/a |

### Branch pages

| Route | Chips | Source |
|---|---|---|
| `home` | Today's sales ₦ · Orders · Cans left · Close status | derived / +count |
| `sales` | Today ₦ · This week ₦ · Avg ticket ₦ · Refunds | derived |
| `sale-detail` | Items · Total ₦ · Payment · Status | derived |
| `stock` | On hand · Low · Expiring ≤48h · Last transfer | derived |
| `queue` | In queue · Preparing · Ready | derived |
| `closes` | This month · With variance · Last variance ₦ | derived |
| `close` | Expected ₦ · Counted ₦ · Variance ₦ | derived |
| `returns` | Pending · Approved · This month | derived |
| `transfers` | Incoming · To receive · Received today | derived |
| `return-detail` | Items · Refund ₦ · Status | derived |
| `device` | plain title hero, no chips | n/a |
| `sell` | **no banner** (POS register) | skipped |

### Factory pages

| Route | Chips | Source |
|---|---|---|
| `inventory` | Materials · Low · Finished goods · Value ₦ | derived |
| `production-runs` | Active runs · Output today · Planned · Yield % | derived / +count |
| `run-detail` | Planned · Produced · Yield % · Status | derived |

> The handful of `+count` chips that need data a page doesn't already load will be
> implemented by widening that page's existing fetch (e.g. add a `?count=` or reuse a
> list length), never by a heavyweight new query. Each is called out in the plan.

---

## Part 3 — Command-center dashboard

Above the existing Revenue/Top-products/Variances cards, add four chip groups driven
by **one** new endpoint so the dashboard stays a single fast load.

### New endpoint: `GET /v1/reports/overview`

Returns everything the four groups need:

```jsonc
{
  "data": {
    "stock": { "low_stock_skus": 4, "expiring_48h": 2 },
    "fulfilment": { "orders_pending": 6, "preorders_open": 3, "bags_queue": 5 },
    "today": { "net_ngn": 184000, "yesterday_net_ngn": 152000, "wtd_net_ngn": 920000 },
    "growth": {
      "month_revenue_ngn": 4200000,
      "month_expenses_ngn": 1800000,
      "month_profit_ngn": 2400000,
      "active_subscriptions": 12,
      "mrr_ngn": 360000,
      "new_leads": 7
    }
  }
}
```

- Reuses existing query logic where it exists (`/reports/pnl` math for month money,
  `/reports/branch-stock` + per-flavour floor for low stock, `daily_close`/`sale_order`
  for today vs yesterday). Each sub-object is an independent SQL block; if one fails it
  returns zeros for that block rather than 500-ing the whole dashboard.
- Capability: same gate as the existing dashboard reports (owner/admin reporting read).

### Dashboard layout (top → bottom)

1. `StatHero` (unchanged — bottle + Net/Gross/Refunds/Needs-review stats stay).
2. **Stock alerts** strip — Low-stock (`danger` if >0) · Expiring ≤48h (`warn`) →
   links to Inventory. Hidden/`good` when all clear.
3. **Orders & preorders** strip — Pending orders · Preorders open · Bags queue →
   links to Orders / Preorders / Packaging.
4. **Today vs yesterday** strip — Today net · ▲/▼ % vs yesterday (color by sign) ·
   Week-to-date.
5. **Money & growth** strip — Month profit · Active subs / MRR · New leads.
6. Existing Branch performance / Top products / Recent variances (unchanged).

Strips 2–5 are small `Stat`-style cards reusing the existing `Stat` component and
grid, so they match the cards already on the page.

---

## Data & error handling

- Per-page derived chips never add a request; they compute from loaded state with
  safe fallbacks (`0`, `—`) while `loading`.
- The dashboard makes its existing calls **plus** one `/reports/overview` call.
- `/reports/overview` degrades per-block (zeros on sub-query failure) and the UI shows
  `—` for a block that errored, never a broken page.
- Money formatted with `ngn()`; counts are plain integers; percentages rounded to whole.

## Testing

- **API:** unit/integration test for `/reports/overview` — shape, zeros-on-empty-DB,
  per-block isolation (one bad block doesn't fail the response). Add to existing
  reports test file.
- **Admin:** `StatHero` renders chips + tones; Products/Dashboard snapshot unchanged
  after refactor. Spot-render 3–4 representative pages (Inventory, Orders, a branch
  page) asserting chips appear with derived values.
- Quality gates: 0 lint errors, clean typecheck, existing suites stay green
  (per `reference_quality_gates`).

## Rollout / sequencing

Single build ("everything in one go"), but landed in a reviewable order:
1. `StatHero` component + CSS tone modifier + refactor Products/Dashboard (no visual change).
2. `/reports/overview` endpoint + tests.
3. Dashboard command-center strips.
4. Owner pages sweep.
5. Branch + factory pages sweep.
6. One responsive pass (phone/tablet/desktop) — banners already collapse via existing
   `.juice-hero` media queries; verify chip wrap at <768px and <420px.

## Open implementation notes (resolved defaults)

- Low-stock definition: balance below the **per-flavour floor** (enforcement still
  per-flavour per `project_per_size_stock`); expiring uses batch/shelf data already in
  inventory reads.
- "Today" uses `nowLagos()` business date semantics, consistent with closes/worker.
- Detail-page chips read the entity already loaded by the page; no extra fetch.

# Admin Analytics page — business performance deep-dive

**Date:** 2026-06-16
**Status:** Approved (design); ready for implementation plan
**Scope:** `apps/admin` (new page + nav) and `apps/api` (one new report endpoint).
No DB schema changes.

## Problem

The admin Dashboard is a quick daily glance (range revenue totals, top products,
recent variances). There is no dedicated place to *analyse* the business —
revenue trends over time, channel/branch mix, product performance, and profit &
loss — in one themed view. The owner wants a dedicated **Analytics** page.

## Goals

1. A single owner-facing Analytics page covering business performance: revenue &
   orders trend, channel & branch mix, product performance, and P&L.
2. Proper interactive charts (Recharts) styled in the Juice Skin.
3. Reuse existing report endpoints; add the minimum new backend (one endpoint).
4. Graceful empty states (the dev DB is currently all zeros).

## Non-goals

- Operations analytics (stock turnover, production vs sales, delivery, preorder
  pipeline) — explicitly out of scope for this page.
- No new DB tables/migrations. No changes to the existing Dashboard beyond adding
  the nav link.
- No gross-margin/COGS metric at arbitrary range level (COGS isn't tracked);
  margin appears only inside the monthly P&L section.

## Existing material

- **Report endpoints** (`apps/api/src/routes/reports.ts`, all gated by
  `reports.view`):
  - `GET /reports/revenue?from&to` → rows by `(branch_id, channel)` with
    `gross_ngn, refunds_ngn, net_ngn, orders`.
  - `GET /reports/top-products?from&to&limit` → `product_id, product_name,
    quantity, revenue_ngn`.
  - `GET /reports/pnl?month=YYYY-MM` → `revenue_ngn, refunds_ngn,
    net_revenue_ngn, expenses_total_ngn, expenses_by_category[], net_ngn`.
  - (`/variances`, `/branch-stock` exist but are not used by this page.)
- **Products** — `GET /products` returns `category` per product (for category mix).
- **Admin Juice Skin** — `FlavourMedia`, `flavour-visuals`, `.juice-hero`,
  `.glass-card`, droplet `.stat-card`, `.l-split` responsive helpers, green
  button standard. See `[[project_admin_juice_skin]]`.
- **Nav** — `apps/admin/src/components/Shell.tsx` `NAV_OWNER`.

## Architecture (Approach A)

### New API endpoint — `GET /reports/timeseries`

- Query: `from`, `to` (default last 30d), `interval=day|week` (default `day`).
- Returns `{ data: [{ date: string, gross_ngn: number, net_ngn: number, orders: number }] }`,
  one row per bucket, ascending by date, **zero-filled** for empty buckets so the
  chart has a continuous x-axis.
- Same status filter as `/revenue` (`paid`,`handed_over`,`delivered`), bucketed on
  `created_at_local::date`; refunds subtracted per bucket for `net_ngn`.
- Lives in `reports.ts`, gated by `reports.view`. Gets a vitest test in
  `apps/api` (rows bucket correctly; empty range → empty/zero-filled).

### New admin route — `/owner/analytics`

- Registered in the router; nav link added to `NAV_OWNER` (icon `TrendingUp`),
  placed right after Dashboard, gated by `reports.view`.
- The route component owns two pieces of state: a **range** (`from`,`to` via
  presets 7d/30d/90d/custom) for sections 1–4, and a **month** for the P&L
  section. It fetches in parallel and passes data down to chart components.

### Page sections (all Juice Skin themed)

1. **KPI band** — `.juice-hero` + droplet `.stat-card`s: Net revenue, Orders,
   Avg order value (`net/orders`), Refund rate (`refunds/gross`), each with a
   small sparkline (from timeseries).
2. **Revenue & orders trend** — composed area (net revenue) + line (orders) over
   the range. Day buckets; auto-request `interval=week` past ~60 days.
3. **Channel & branch mix** — donut of revenue by channel + horizontal bars
   comparing branches. Both derived client-side from `/reports/revenue` (sum by
   `channel`, sum by `branch_id`; branch names from `/branches`).
4. **Product performance** — top sellers list with bottles (`FlavourMedia`,
   slug derived from name) + revenue-by-category donut (join `/top-products`
   `product_id` → `/products` `category`).
5. **Profit & loss** — month selector; revenue-vs-expenses summary, expense-by-
   category donut, and net, from `/reports/pnl`. Reuses the existing CSV export.

### Components (focused units)

- `routes/owner/analytics.tsx` — orchestration + layout + range/month controls.
- `components/charts/` — small themed chart wrappers, each one purpose:
  `TrendChart`, `ChannelDonut`, `BranchBars`, `CategoryDonut`, `PnlChart`,
  plus `Sparkline`.
- `lib/analytics-theme.ts` — shared Recharts theming: brand color sequence
  (greens/orange/gold), axis/grid styles, a droplet-styled tooltip renderer,
  and number/₦ formatters. Single source so all charts look consistent.
- Each chart takes already-shaped data as props (no fetching inside charts) so
  it can be reasoned about and reused independently.

### Data flow

Route fetches in parallel for the active range: `timeseries`, `revenue`,
`top-products`, `products`, `branches`; and `pnl` for the active month. Channel
mix, branch comparison, and category mix are derived from those responses (pure
functions in `lib/analytics-derive.ts`, unit-testable). Charts receive derived
data.

### Error & empty handling

- Each card renders an empty state (themed `.empty`) when its slice has no data —
  required because the current dev DB has zero sales.
- Fetch errors surface a per-page toast; individual cards degrade to empty rather
  than crashing the page.

### Responsiveness

Reuse `.l-split` patterns: the two-up rows (channel|branch, products|category)
stack below ~900px; charts use Recharts `ResponsiveContainer`. KPI cards use the
existing auto-fit grid.

## Dependencies

- Add `recharts` to `apps/admin` (~50KB gz). React 18.3 compatible.

## Risks

- **Bundle size** — Recharts adds weight; mitigated by it being a route-level
  chunk (admin is already code-split per route).
- **Empty dev data** — mitigated by zero-filled timeseries + empty states; the
  visual mock will use sample data to show the intended look.
- **Timezone bucketing** — use `created_at_local` (already WAT-local) like the
  other reports, so buckets match the rest of admin.

## Success criteria

- `/owner/analytics` shows all five sections, themed, with working interactive
  charts and a range + month control.
- New `/reports/timeseries` endpoint returns correct zero-filled buckets; has a
  passing API test.
- Empty states render cleanly on zero data; typecheck + lint + build clean;
  existing API tests stay green.

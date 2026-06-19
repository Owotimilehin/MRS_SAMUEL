# Dashboard Financials Refactor — Design

**Date:** 2026-06-19
**Status:** Approved (design); ready for implementation planning

## Problem

The owner wants to know **how much the business made in a single day**, on a real basis:

> Daily profit = day's revenue − per-unit cost of the bottles sold − per-unit cost of the bags handed out − the day's operating expenses.

Today the dashboard mixes bookkeeping-style figures (monthly profit, gross/net over an arbitrary range) with operational signals, and **all of it is visible to admins and managers** because everything is gated by `reports.view`, which all three roles hold. There is no per-unit cost of goods — bottle and bag costs only ever appear as *bulk purchase* expenses, which distorts any per-day picture.

This refactor:

1. Adds a **per-day financial view for the owner only**, with packaging treated as a **per-unit** cost (FIFO) rather than a bulk purchase.
2. Splits the dashboard into a **financial face (owner)** and an **operational face (admin/manager)**.
3. Adds the operational signals the owner asked for (cans sold per size, total units, unfulfilled orders, low stock in factory *and* branch, pending transfers).
4. Moves monthly/gross/net profit reporting to the **bookkeeping page**, which already hosts the monthly P&L.

## Scope

**In scope:**

- New owner-only capability `finance.view`.
- New `GET /reports/daily` endpoint (FIFO packaging cost + day expenses + revenue + unit breakdowns).
- Restructure `GET /reports/overview` to be operational-only and add factory/branch low-stock split, pending transfers, units sold today, units by size.
- Dashboard split into financial (owner) and operational (admin/manager) faces.
- Remove the "Month profit" stat from the dashboard; gate the bookkeeping P&L tab behind `finance.view`.
- Owner-controlled "which expense categories count toward daily profit" toggle, persisted in `localStorage` and passed to the API.

**Out of scope (YAGNI):**

- Costing raw materials / juice per unit. **Only bottles and bags** are treated as per-unit costs for this scope; everything else stays as recorded business expenses.
- A server-side settings table. The category toggle is a personal view filter, persisted client-side like `receipt-settings`.
- Batch-expiry / `expiring_48h` (no data source exists; stays 0 as today).
- Any change to how bottles are physically consumed at production or how the stock ledger works. FIFO here is **costing-only**.

## Cost model — FIFO packaging costing

### Cost layers

Each `packaging_purchase` row is a cost layer for one `packaging_material`:
`(purchase_date, quantity, unit_cost_ngn)`, ordered by `purchase_date` then `id`.

### Consumption units

- **Bottles:** each sold can/bottle consumes one bottle of its variant's `bottle_material_id`. Units come from `sale_order_item` joined to `product_variant` (only orders in `paid`/`handed_over`/`delivered`, matching the existing revenue status filter), grouped by `bottle_material_id`.
- **Bags:** units come from `sale_order_packaging.quantity`, grouped by `packaging_material_id` (kind `bag`), joined to the same set of qualifying sale orders.

### Allocation (per material, for a target business date D)

1. `prior_units` = units consumed strictly **before** D.
2. `day_units` = units consumed **on** D.
3. Walk the ordered cost layers, skipping the first `prior_units` (the queue offset), then allocate `day_units` across the remaining layer capacity, summing `allocated × layer.unit_cost_ngn`.
4. If the layers are exhausted before `day_units` is satisfied, the remaining units are costed at the **most-recent purchase `unit_cost_ngn`** for that material (the "pick up the last recorded unit price" rule). If a material has *no* purchases at all, its cost contribution is 0 (and is surfaced as a caveat — see Error handling).

`packaging_cost_ngn` for the day = Σ over all bottle materials + Σ over all bag materials.

### Where it runs

Server-side in `/reports/daily`. Fetch the per-material ordered purchase layers and the per-material prior/day consumption counts, then do the allocation in TypeScript (clear, testable, and the layer counts are small). Pure function `allocateFifo(layers, priorUnits, dayUnits) -> { cost_ngn, exhausted_units }` so it is unit-testable in isolation.

## Daily expenses

- Source: `business_expense` rows where `expense_date = D` and `deleted_at IS NULL`.
- The `packaging` category is **always excluded** (bottle/bag bulk purchases are counted per-unit instead — including them would double-count).
- All other categories are included **only if** present in the owner's selected set, passed as a query param (e.g. `?expense_categories=raw_materials,utilities,transport,other_with_note`).
- Default selected set when none is stored: **all non-packaging categories** (so the figure is conservative/complete out of the box). The owner narrows it from there.

## API

### `GET /reports/daily` — owner/finance only

- Middleware: `requireAuth()` + `requireCapability("finance.view")`.
- Query params:
  - `date` (YYYY-MM-DD, default today in Lagos terms, consistent with existing `created_at_local::date` usage).
  - `expense_categories` (comma-separated `business_expense_category` codes; `packaging` ignored if passed; defaults to all non-packaging).
- Response `data`:
  ```jsonc
  {
    "date": "2026-06-19",
    "revenue_ngn": 0,           // gross sales for the day, paid/handed_over/delivered
    "refunds_ngn": 0,           // completed refunds dated that day
    "net_revenue_ngn": 0,       // revenue - refunds
    "packaging_cost_ngn": 0,    // FIFO bottles + bags
    "packaging_cost_bottles_ngn": 0,
    "packaging_cost_bags_ngn": 0,
    "expenses_ngn": 0,          // included categories only, excl. packaging
    "expenses_by_category": [{ "category_code": "...", "label": "...", "amount_ngn": 0 }],
    "daily_profit_ngn": 0,      // net_revenue - packaging_cost - expenses
    "total_units": 0,           // total cans/bottles sold that day
    "units_by_size": [{ "size_ml": 330, "units": 0 }],
    "caveats": ["..."]          // e.g. "No purchase history for Small bag — costed at 0"
  }
  ```

### `GET /reports/overview` — restructured, operational-only (`reports.view`)

Remove the money-bearing fields (`today.*`, `growth.*`). New shape:

```jsonc
{
  "stock": { "low_stock_factory": 0, "low_stock_branch": 0, "expiring_48h": 0 },
  "fulfilment": { "orders_pending": 0, "preorders_open": 0, "bags_queue": 0, "pending_transfers": 0 },
  "today": { "total_units": 0, "units_by_size": [{ "size_ml": 330, "units": 0 }] }
}
```

- `low_stock_factory`: `stock_ledger` `location_type='factory'`, balance `BETWEEN 1 AND 10` (same threshold as branch for now).
- `low_stock_branch`: existing branch low-stock query (renamed from `low_stock_skus`).
- `pending_transfers`: `stock_transfer` with `status IN ('dispatched','in_transit','arrived')`.
- `today.total_units` / `units_by_size`: units sold today from `sale_order_item` × `product_variant.size_ml`.

Each sub-query keeps the existing `block()` wrapper so one failure yields zeros, not a 500.

## Frontend

### Capability + auth

Add `finance.view` to `CAPABILITIES` in `packages/shared/src/permissions.ts`. Do **not** add it to `ADMIN_CAPS` or `MANAGER_CAPS` — owner gets it via `[...CAPABILITIES]`. Same owner-only pattern as `packaging.adjust`.

### Dashboard (`apps/admin/src/routes/owner/dashboard.tsx`)

Two faces, switched on `can("finance.view")`:

- **Owner (finance) face:**
  - A **single-day date picker** (default today) — replaces the from/to range for the financial block.
  - Financial strip: **Net revenue · Packaging cost · Daily expenses · Daily profit** (profit toned good/bad).
  - **Cans sold per size** (small table/row) + **total units**.
  - An **expense-category filter** control (checkboxes) whose selection persists in `localStorage` (pattern from `receipt-settings`) and is sent to `/reports/daily`.
  - Operational signals strip (shared, see below).
  - Existing branch-performance / top-products / variances tables remain for the owner (range-based, fed by existing `/reports/revenue` etc.).

- **Admin / Manager (operational) face:**
  - Operational signals strip only.
  - No revenue, cost, profit, or variance money. Branch-performance and variances tables (money) are hidden; top-products may show quantity but **not** revenue.

- **Operational signals strip (shared):** Total units sold today · Unfulfilled orders (`orders_pending`, with `preorders_open` hint) · Low stock — factory · Low stock — branch · Pending transfers · Needs review.

The "Month profit" stat currently on the dashboard is **removed**.

### Expense-category toggle persistence

New `apps/admin/src/lib/finance-settings.ts` mirroring `receipt-settings.ts`: get/set an array of included `business_expense_category` codes in `localStorage`, default = all non-packaging codes. The dashboard reads it, renders checkboxes, and appends `expense_categories` to the `/reports/daily` request.

### Bookkeeping (`apps/admin/src/routes/owner/bookkeeping.tsx`)

- The **P&L tab** (monthly net/gross/profit) is gated behind `finance.view` (hidden otherwise).
- This is where monthly profit/net/gross now lives exclusively (it already does). No new monthly math required — just the gate plus removal of the dashboard month-profit stat.

## Error handling

- `/reports/daily` sub-computations should fail soft where reasonable; a missing purchase history for a material yields a 0 cost contribution plus a `caveats` entry rather than an error.
- Invalid `date` → 400 (same `validation_failed` shape as `/pnl`'s month check).
- `/reports/overview` retains per-block `block()` fallbacks.
- The dashboard must not let one forbidden/failed widget blank the page (existing pattern: optional fetches `.catch(() => null)`).

## Testing

- **Unit:** `allocateFifo()` — empty layers, single layer, spanning multiple layers, exact-boundary consumption, queue exhausted → fallback to latest price, prior-units offset past several layers.
- **Integration (`apps/api/test/integration/`):**
  - `reports-daily.test.ts`: seed purchases at two prices + sales across the boundary; assert `packaging_cost_*`, expense inclusion/exclusion (packaging always out, toggled categories), `daily_profit_ngn`, `units_by_size`. Assert `finance.view` is required (403 for admin/manager).
  - Extend/replace `reports-overview.test.ts`: factory vs branch low-stock split, `pending_transfers`, `units_by_size`; assert money fields are gone.
- **Permissions:** assert `finance.view` ∈ owner defaults and ∉ admin/manager defaults.

## Migration

None required. `finance.view` is a code-level capability (no DB column). No new tables. (`packaging.adjust` set the precedent for adding an owner-only capability without a migration.)

## Rollout notes

- Admin is a PWA — existing sessions need a hard refresh to pick up the new bundle and the changed `/reports/overview` shape. The dashboard should tolerate the old shape gracefully during the brief window (treat missing fields as 0).
- The desktop app should be resynced after this ships.

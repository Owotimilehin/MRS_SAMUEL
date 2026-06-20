# Detailed Daily Financials Cards — Design

**Date:** 2026-06-20
**Status:** Approved, pending implementation plan
**Branch:** feat/daily-financials-detail (off master ff80fa6)

## Problem

The owner dashboard's "Daily financials" block (live on master) shows four flat stat
tiles — Net revenue, Packaging cost (with a "Bottles X · Bags Y" hint), Daily expenses,
Daily profit — plus a units-only "Cans by size" line. It does not show revenue per size,
revenue per flavour type, per-material packaging cost, or how profit is composed. The owner
wants each of the three money figures broken down so the numbers tell their own story.

The `/reports/daily` endpoint (`apps/api/src/routes/reports.ts`, `r.get("/daily")`, gated by
`finance.view`) already computes: net revenue, FIFO packaging cost (bottles + bags totals),
expenses by category, daily profit, and units by size. The sale line-item table
(`sale_order_item`) stores `quantity`, `unit_price_ngn`, and `line_total_ngn`, and `product`
carries a `category` enum (`regular`, `special`, `punch`) — so the breakdowns are derivable
from existing data with no schema change.

## Goal

Replace the flat block with three detailed cards — Net revenue, Packaging cost, Profit —
each with a total header and an itemised breakdown, today-only, gated by `finance.view`.

## Decisions (locked with owner)

1. **Net revenue layout:** nested **size → flavour type**. Each can size is a section with its
   own subtotal; within it, one line per flavour type showing units × effective unit price =
   subtotal.
2. **Revenue basis:** actual recorded sales — sum `line_total_ngn` and `quantity`; effective
   unit price = revenue ÷ units (a blended average, labelled "avg", because price lives per
   flavour+size variant and a size/type group can span flavours/prices).
3. **Categories:** `regular`, `special`, and `punch` each shown as their own line.
4. **Profit card:** waterfall (net revenue − packaging − expenses = profit) plus margin %.

## Non-goals (scope guard)

- Today-only (the existing date picker still applies). No date-range breakdown.
- No new tables or migrations. The FIFO allocator, expense selection, and the net-revenue
  total are unchanged — we only *expose* breakdowns the line-item data already supports.
- Money reconciliation total (net revenue) keeps its current definition.

## Design

### Card 1 — Net revenue (nested size → type, reconciled)

Header = net revenue (exact, unchanged definition). Body groups by `size_ml`, then by
`product.category`, from `sale_order_item` joined to `product_variant` (size) and `product`
(category), over orders with `status IN ('paid','handed_over','delivered')` and
`created_at_local::date = date`. Each line: units (Σ quantity), avg unit price (revenue ÷
units), subtotal (Σ line_total_ngn).

Because the size/type breakdown sums `line_total_ngn` (product sales only) while net revenue is
order `total_ngn` minus refunds, the card reconciles explicitly:

```
Product sales (Σ line_total_ngn, broken down by size→type)
+ Delivery fees   (Σ delivery_fee_ngn for the day; row hidden when 0)
− Refunds         (already computed; row hidden when 0)
= Net revenue     (header)
```

### Card 2 — Packaging cost (per material, grouped bottle/bag)

Header = total packaging cost (FIFO, unchanged). Body lists each material consumed today,
grouped Bottles then Bags, each: units consumed today, effective unit cost (FIFO-allocated
cost ÷ units), subtotal. Existing `costFor` helper is refactored to return per-material detail
(`{ material_id, units, cost_ngn }`) instead of only a running sum; the sum is derived from it.
Existing caveats ("X has no purchase history — costed at ₦0") are preserved.

### Card 3 — Profit (waterfall + margin %)

```
   Net revenue
 − Packaging cost
 − Expenses
 = Profit
   Margin = profit ÷ net revenue (shown as %; "—" when net revenue is 0)
```

Expense-category toggle checkboxes and caveats stay; they continue to feed the Expenses line.

### API additions (`/reports/daily` response `data`)

- `revenue_by_size`: `Array<{ size_ml: number; revenue_ngn: number; units: number;
  rows: Array<{ category: "regular"|"special"|"punch"; units: number; revenue_ngn: number;
  avg_unit_price_ngn: number }> }>` (sorted by size_ml; rows sorted regular, special, punch).
- `product_sales_ngn: number` (Σ line_total_ngn for the day).
- `delivery_fees_ngn: number` (Σ delivery_fee_ngn for the day's counted orders).
- `packaging_breakdown`: `Array<{ material_id: string; name: string; kind: "bottle"|"bag";
  units: number; unit_cost_ngn: number; cost_ngn: number }>`.
- `margin_pct: number | null` (profit ÷ net_revenue; null when net_revenue is 0). May instead
  be computed client-side — implementation plan picks one and is consistent.

All existing fields (`net_revenue_ngn`, `packaging_cost_ngn`, `packaging_cost_bottles_ngn`,
`packaging_cost_bags_ngn`, `expenses_ngn`, `expenses_by_category`, `daily_profit_ngn`,
`total_units`, `units_by_size`, `caveats`, `refunds_ngn`, `revenue_ngn`) remain so nothing
else breaks.

### Frontend

Rewrite the "Daily financials" block in `apps/admin/src/routes/owner/dashboard.tsx` into the
three cards using small presentational sub-components. Same `finance.view` gating, same date
state, same expense-category toggles. The old flat tiles and the "Cans by size" units line are
removed (units now live inside the Net revenue card as the per-line unit counts).

## Testing

- API integration (`apps/api/test/integration/reports-daily.test.ts`): seed sales across two
  sizes and two categories; assert `revenue_by_size` groups correctly (units, revenue, avg
  price), that `product_sales + delivery_fees − refunds == net_revenue_ngn`, and that
  `packaging_breakdown` per-material costs sum to `packaging_cost_ngn`.
- Unit: if `margin_pct` is computed server-side, a small test for the 0-net-revenue guard.

## Backward compatibility

Purely additive on the API (new fields). The dashboard block is rewritten but stays behind the
same capability gate; non-finance users see the operational strip exactly as before.

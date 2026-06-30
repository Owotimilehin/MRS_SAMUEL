# Daily Owner Report — Design

**Date:** 2026-06-30
**Status:** Approved (pending spec review)

## Goal

Give the owner a comprehensive, detailed report of each day's business, delivered
two ways: a short Telegram summary that pings every morning, and a full
**Daily Report** page in the admin app for the complete detail.

Covers the previous (now-complete) day. Fires the next morning so nothing is
still in flight.

## Decisions (from brainstorming)

- **Delivery:** Telegram summary + full admin page (`/owner/daily-report`).
- **Timing:** next morning, fires once Lagos hour ≥ 7, covering the previous day.
- **Sections:** Sales & profit · Per-flavour sales · Stock & shop on-hand.
  (Channels/orders intentionally NOT a headline section; a one-line walk-up vs
  online split is folded into Sales.)
- **Explicit owner asks:** amount sold **per flavour** (full list), and **stock
  left in shop** (current branch on-hand per flavour/size).
- **Architecture:** shared on-demand builder, no new table, no migration.
- **Profit label:** "estimated margin (after goods + logged expenses)" — honest,
  because daily expenses are lumpy (rent/salaries land once a month).

## Architecture

Approach A — one builder is the single source of truth, consumed by both surfaces
so the Telegram numbers and the admin page can never disagree.

```
packages/domain/src/reports/daily-report.ts
   └─ buildDailyReport(db, dateISO) → DailyReport   ◄── single source of truth
        │
        ├── apps/api/src/routes/reports.ts
        │      r.get("/daily-report?date=") → DailyReport JSON   (gated finance.view)
        │            ▲
        │            └── apps/admin/src/routes/owner/daily-report.tsx  (full detail page)
        │
        └── apps/worker/src/jobs/daily-report.ts
               fireDailyReport(db, date) → builds report, sends Telegram summary
                     ▲
                     └── cron.ts: fires when Lagos hour ≥ 7, run_for = yesterday
```

Everything is recomputed from the immutable sales/expense/stock data by date, so
any past day can be viewed. Reuses the existing `/reports/daily` FIFO costing
logic and `/reports/overview` low-stock logic.

## The `DailyReport` data shape

`buildDailyReport(db, dateISO)` returns one typed object. All sales figures are for
`dateISO` (the previous day); stock on-hand is **live at report time** (this morning).

```ts
type DailyReport = {
  date: string;                  // YYYY-MM-DD (the day reported)
  generatedAt: string;           // ISO timestamp

  salesProfit: {
    revenueNgn: number;          // SUM(total_ngn) status in (paid,handed_over,delivered)
    refundsNgn: number;          // completed sale_return that day
    netRevenueNgn: number;       // revenue - refunds
    orderCount: number;
    channelSplit: { walkup: number; online: number }; // order counts
    cogsNgn: number;             // FIFO-costed bottles + bags + straws consumed
    expensesNgn: number;         // business_expense logged that day (excl. packaging)
    estMarginNgn: number;        // netRevenue - cogs - expenses
    compare: {
      priorDay:  { revenueNgn: number; deltaNgn: number; deltaPct: number | null };
      sevenDayAvg: { revenueNgn: number; deltaNgn: number; deltaPct: number | null };
    };
  };

  perFlavour: Array<{            // EVERY flavour sold that day, desc by revenue
    productId: string;
    name: string;
    units: number;
    revenueNgn: number;
  }>;
  unitsBySize: Array<{ sizeMl: number; units: number }>;
  totalUnits: number;

  shopStock: Array<{             // current branch on-hand, per flavour
    productId: string;
    name: string;
    bySize: Array<{ sizeMl: number; balance: number }>;
    totalBalance: number;
    low: boolean;                // any size balance 1..10
    outOfStock: boolean;         // total balance <= 0
  }>;

  operations: {
    lowStockFactory: number;     // distinct (product,variant) balance 1..10 at factory
    pendingTransfers: number;    // stock_transfer in dispatched/in_transit/arrived
    packagingConsumed: Array<{ name: string; kind: string; units: number }>;
    shifts: Array<{              // when shift data exists for the day
      branchName: string;
      openedBy: string | null;
      closedBy: string | null;
      varianceNote: string | null;
    }>;
  };
};
```

### Data sources (all reuse existing tables / patterns)

- **Revenue / refunds:** `sale_order` (status in paid/handed_over/delivered,
  `created_at_local::date = date`) and `sale_return` (completed, that date) —
  same filter as `/reports/daily`.
- **COGS:** reuse the FIFO allocation in `/reports/daily` (bottles via
  `product_variant.bottle_material_id`, bags/straws via `sale_order_packaging`),
  costed against `packaging_purchase` layers.
- **Expenses:** `business_expense` for the date, packaging category excluded
  (already counted per-unit in COGS).
- **Per-flavour sales:** `sale_order_item` joined `product`, grouped by product —
  the existing `/reports/top-products` query with `limit` removed and date pinned.
- **Units by size:** the `/reports/overview` "today" query, generalized to any date.
- **Shop on-hand:** `stock_ledger` `location_type='branch'`, grouped by product +
  variant, SUM(delta) as live balance. Low = any size 1..10.
- **Factory low-stock / pending transfers / packaging consumed:** from
  `/reports/overview` and the `/daily` packaging sums.
- **Comparisons:** prior-day = same query for `date - 1`; 7-day avg = revenue over
  `[date-7, date-1]` ÷ 7. `deltaPct` is `null` when the baseline is 0.

## Telegram summary (the ping)

Short and scannable, leads with Sales & profit, deep-links to the page. Mirrors the
existing monthly P&L digest style and uses `channels.owner()`.

```
☀️ Daily Report · Sun 29 Jun
Revenue:  ₦82,400  (▲ ₦11k vs Sat, ▲ 8% vs 7-day avg)
Refunds:  ₦1,500
Margin:   ₦34,200 (est. after goods + expenses) ✅
Sold:     58 bottles — 650ml ×20, 500ml ×26, 330ml ×12
Top:      Zesty Sunrise, Garden Glow, Crimson Elixir
⚠️ 3 low-stock · 1 pending transfer
👉 admin.mrssamuel.com/owner/daily-report?date=2026-06-29
```

The full per-flavour sold table and full stock-left table are NOT in the message
(too long for a phone) — they live on the page. The summary shows the top 3
flavours by revenue and the low-stock count only.

## Admin page (`/owner/daily-report.tsx`)

- Date picker, defaults to yesterday; reads `?date=` query param.
- Calls `GET /v1/reports/daily-report?date=`.
- Gated by `finance.view` (same as `/reports/daily`).
- Added to the owner nav.
- Three sections, reusing existing admin UI (StatHero / cards / tables):
  1. **Sales & profit** — revenue, refunds, net, COGS, expenses, est. margin,
     order count, walk-up vs online split, vs prior day & 7-day avg.
  2. **Per-flavour sales** — table: every flavour → units + ₦ sold; units-by-size
     totals row.
  3. **Stock & shop on-hand** — table: current shop on-hand per flavour/size with
     low-stock flags; factory low-stock count, pending transfers, packaging
     consumed, shift reconciliation.
- Uses the shared `DataState` / `humanizeError` graceful-error pattern already in
  the admin app.

## Cron wiring (`apps/worker/src/jobs/cron.ts`)

In `runDueCronJobs`, after the recurring-expense block:

```ts
if (lagos.hour >= 7) {
  const yesterday = /* Lagos date - 1, YYYY-MM-DD */;
  if (await claimCronRun(db, "daily_owner_report", yesterday)) {
    await runJob(cronLogger, "daily_report", () => fireDailyReport(db, yesterday));
  }
}
```

Idempotent per day via `cron_run` even though the worker ticks repeatedly.
`shouldFireDailyReportNow(lagos)` = `lagos.hour >= 7` (testable boundary helper,
mirroring `shouldFirePnlDigestNow`).

## Testing

- **Domain** (`buildDailyReport`): seed a day; assert revenue / refunds / COGS /
  est. margin / per-flavour units+revenue / units-by-size / shop on-hand / low
  flags / comparison math (prior-day Δ, 7-day avg, null-pct when baseline 0).
  Plus an empty-day case (no sales) returning zeros and empty arrays gracefully.
- **Worker**: `shouldFireDailyReportNow` hour boundary; `fireDailyReport` composes
  the Telegram text from a known report (top-3 flavours, low-stock count, link).
- **API**: integration test `GET /reports/daily-report` returns the shape and
  enforces `finance.view` (401/403 without it).

## Out of scope (YAGNI / future)

- Persisted `daily_report` snapshot table + browsable archive — recompute-on-demand
  is enough; add later if a history list is wanted.
- Email delivery — Telegram + page chosen.
- Channels/orders as a headline section — folded to a one-line split in Sales.
- Multi-branch breakdown — prod has 1 branch; aggregate now, split when a 2nd
  branch exists.

## Files touched

- **new** `packages/domain/src/reports/daily-report.ts` (+ index export)
- **new** `apps/worker/src/jobs/daily-report.ts`
- **edit** `apps/worker/src/jobs/cron.ts` (register the daily block)
- **edit** `apps/api/src/routes/reports.ts` (add `/daily-report`)
- **new** `apps/admin/src/routes/owner/daily-report.tsx` (+ nav entry)
- **new** domain + worker + api tests

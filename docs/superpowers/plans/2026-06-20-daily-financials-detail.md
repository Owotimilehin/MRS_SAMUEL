# Detailed Daily Financials Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the owner dashboard's four flat daily-financials tiles with three detailed cards — Net revenue (nested size→type, reconciled), Packaging cost (per material), and Profit (waterfall + margin %).

**Architecture:** Additive changes to the existing `GET /v1/reports/daily` handler expose breakdowns the line-item data already supports (revenue by size→category, per-material packaging cost, reconciliation lines, margin). The dashboard block is rewritten to render three cards from those fields. No schema/migration; the FIFO allocator, expense selection, and net-revenue total are unchanged.

**Tech Stack:** Hono + Drizzle (`db.execute` with `sql` template literals), Vitest + Testcontainers (real Postgres), React + TanStack Router (admin PWA).

## Global Constraints

- Today-only; the existing date picker still applies. No date-range breakdown, no new tables/migrations.
- `/reports/daily` is gated by `finance.view`; keep that gate. All existing response fields remain (purely additive).
- Net revenue total keeps its current definition (`SUM(sale_order.total_ngn for paid/handed_over/delivered) − refunds`).
- Revenue basis = actual recorded sales: `SUM(sale_order_item.line_total_ngn)` and `SUM(quantity)`; effective unit price = `Math.round(revenue / units)` (blended "avg", shown with an "avg" label in UI).
- Categories `regular`, `special`, `punch` each get their own line, ordered regular → special → punch.
- Packaging total (`packaging_cost_ngn`, `packaging_cost_bottles_ngn`, `packaging_cost_bags_ngn`) must stay byte-identical to today — the breakdown is derived from the same FIFO allocation, not a re-computation.
- Money formatting via the existing `ngn()` helper; reuse the existing `Stat` component for card headers.

---

### Task 1: API — daily breakdowns (revenue by size→type, packaging per material, reconciliation, margin)

**Files:**
- Modify: `apps/api/src/routes/reports.ts` (the `r.get("/daily", ...)` handler)
- Test: `apps/api/test/integration/reports-daily.test.ts` (add one new `it` block; do NOT change the shared `beforeAll` seed)

**Interfaces:**
- Produces (added to `GET /v1/reports/daily` response `data`):
  - `revenue_by_size: Array<{ size_ml: number; revenue_ngn: number; units: number; rows: Array<{ category: "regular"|"special"|"punch"; units: number; revenue_ngn: number; avg_unit_price_ngn: number }> }>`
  - `product_sales_ngn: number`
  - `delivery_fees_ngn: number`
  - `packaging_breakdown: Array<{ material_id: string; name: string; kind: "bottle"|"bag"; units: number; unit_cost_ngn: number; cost_ngn: number }>`
  - `margin_pct: number | null`
- Consumes: existing `allocateFifo` (`apps/api/src/lib/packaging-cost.ts`), and the handler's existing in-scope maps (`layersByMat`, `fallbackByMat`, `nameById`, `priorBottle`, `priorBag`, `caveats`).

- [ ] **Step 1: Write the failing test (new `it` block)**

In `apps/api/test/integration/reports-daily.test.ts`, add this test inside the `describe` block, after the existing "computes FIFO bottle cost" test. It asserts the new fields against the EXISTING seed (one product "Mango Juice" category `regular`, one 650ml variant, 30 units @ ₦1500 = ₦45,000; 30 bottles FIFO = ₦1400; 12 bags @ ₦25 = ₦300; default expenses transport ₦5000 + salaries ₦8000 = ₦13,000):

```typescript
  it("returns size→type revenue, packaging breakdown, reconciliation, and margin", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/daily?date=${DATE}`, {
      headers: { cookie: ownerCookies },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        net_revenue_ngn: number;
        product_sales_ngn: number;
        delivery_fees_ngn: number;
        refunds_ngn: number;
        daily_profit_ngn: number;
        margin_pct: number | null;
        revenue_by_size: Array<{
          size_ml: number;
          revenue_ngn: number;
          units: number;
          rows: Array<{ category: string; units: number; revenue_ngn: number; avg_unit_price_ngn: number }>;
        }>;
        packaging_breakdown: Array<{
          material_id: string;
          name: string;
          kind: string;
          units: number;
          unit_cost_ngn: number;
          cost_ngn: number;
        }>;
        packaging_cost_ngn: number;
      };
    };

    // revenue_by_size: one size (650ml), one category row (regular)
    expect(data.revenue_by_size).toEqual([
      {
        size_ml: 650,
        revenue_ngn: 45000,
        units: 30,
        rows: [{ category: "regular", units: 30, revenue_ngn: 45000, avg_unit_price_ngn: 1500 }],
      },
    ]);

    // reconciliation: product sales + delivery − refunds == net revenue
    expect(data.product_sales_ngn).toBe(45000);
    expect(data.delivery_fees_ngn).toBe(0);
    expect(data.product_sales_ngn + data.delivery_fees_ngn - data.refunds_ngn).toBe(
      data.net_revenue_ngn,
    );

    // packaging_breakdown: a bottle line (30 @ ~₦47) + a bag line (12 @ ₦25),
    // summing to the unchanged packaging_cost_ngn.
    const bottle = data.packaging_breakdown.find((b) => b.kind === "bottle");
    const bag = data.packaging_breakdown.find((b) => b.kind === "bag");
    expect(bottle).toMatchObject({ units: 30, cost_ngn: 1400, unit_cost_ngn: 47 });
    expect(bag).toMatchObject({ units: 12, cost_ngn: 300, unit_cost_ngn: 25 });
    expect(data.packaging_breakdown.reduce((s, b) => s + b.cost_ngn, 0)).toBe(
      data.packaging_cost_ngn,
    );

    // margin = profit / net revenue, one decimal. profit = 45000 − 1700 − 13000 = 30300.
    expect(data.daily_profit_ngn).toBe(30300);
    expect(data.margin_pct).toBeCloseTo(67.3, 1);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mrs-samuel && pnpm --filter @ms/api test reports-daily`
Expected: FAIL — `revenue_by_size`/`packaging_breakdown`/`product_sales_ngn`/`margin_pct` are `undefined` (the handler doesn't return them yet). (If the testcontainer `beforeAll` hook times out under load, re-run the file alone — known flake, not a real failure.)

- [ ] **Step 3: Add the revenue-by-size→type query**

In `apps/api/src/routes/reports.ts`, inside the `/daily` handler, after the existing `unitsBySize` block (the `sizeRows` query) and before `const netRevenue = ...`, add:

```typescript
    // ── revenue by size → flavour category (actual recorded line totals) ──
    const rbsRows = await db.execute<{
      size_ml: number;
      category: string;
      units: number;
      revenue_ngn: number;
    }>(sql`
      SELECT pv.size_ml AS size_ml, p.category AS category,
             SUM(i.quantity)::int AS units,
             SUM(i.line_total_ngn)::int AS revenue_ngn
      FROM sale_order_item i
      JOIN sale_order o ON o.id = i.sale_order_id
      JOIN product_variant pv ON pv.id = i.variant_id
      JOIN product p ON p.id = i.product_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date = ${date}::date
      GROUP BY pv.size_ml, p.category
      ORDER BY pv.size_ml, p.category
    `);
    const CATEGORY_ORDER: Record<string, number> = { regular: 0, special: 1, punch: 2 };
    const bySizeMap = new Map<
      number,
      {
        size_ml: number;
        revenue_ngn: number;
        units: number;
        rows: Array<{ category: string; units: number; revenue_ngn: number; avg_unit_price_ngn: number }>;
      }
    >();
    for (const r of rbsRows) {
      const size = Number(r.size_ml);
      const units = Number(r.units);
      const rev = Number(r.revenue_ngn);
      const entry = bySizeMap.get(size) ?? { size_ml: size, revenue_ngn: 0, units: 0, rows: [] };
      entry.rows.push({
        category: r.category,
        units,
        revenue_ngn: rev,
        avg_unit_price_ngn: units > 0 ? Math.round(rev / units) : 0,
      });
      entry.revenue_ngn += rev;
      entry.units += units;
      bySizeMap.set(size, entry);
    }
    const revenueBySize = [...bySizeMap.values()]
      .sort((a, b) => a.size_ml - b.size_ml)
      .map((e) => ({
        ...e,
        rows: e.rows.sort(
          (a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9),
        ),
      }));
    const productSales = revenueBySize.reduce((s, e) => s + e.revenue_ngn, 0);

    // ── delivery fees collected on the day's counted orders (reconciliation) ──
    const delivRow = await db.execute<{ fees: number }>(sql`
      SELECT COALESCE(SUM(delivery_fee_ngn), 0)::int AS fees
      FROM sale_order
      WHERE status IN ('paid','handed_over','delivered')
        AND created_at_local::date = ${date}::date
    `);
    const deliveryFees = Number(delivRow[0]?.fees ?? 0);
```

- [ ] **Step 4: Refactor the packaging cost to also emit a per-material breakdown**

Still in the `/daily` handler, replace the existing `costFor` function and the two lines that call it (`const bottlesCost = costFor(bottleDay, priorBottle);` and `const bagsCost = costFor(bagDay, priorBag);`) with a detail-returning version plus derivation:

```typescript
    function costDetail(
      dayRows: Array<{ material_id: string; units: number }>,
      priorMap: Map<string, number>,
    ): Array<{ material_id: string; units: number; cost_ngn: number }> {
      const out: Array<{ material_id: string; units: number; cost_ngn: number }> = [];
      for (const row of dayRows) {
        const layers = layersByMat.get(row.material_id) ?? [];
        const fallback = fallbackByMat.get(row.material_id) ?? 0;
        if (layers.length === 0 && fallback === 0) {
          caveats.push(`${nameById.get(row.material_id) ?? "A material"} has no purchase history — costed at ₦0`);
        }
        const res = allocateFifo(layers, priorMap.get(row.material_id) ?? 0, Number(row.units), fallback);
        out.push({ material_id: row.material_id, units: Number(row.units), cost_ngn: res.costNgn });
      }
      return out;
    }

    const bottleDetail = costDetail(bottleDay, priorBottle);
    const bagDetail = costDetail(bagDay, priorBag);
    const bottlesCost = bottleDetail.reduce((s, r) => s + r.cost_ngn, 0);
    const bagsCost = bagDetail.reduce((s, r) => s + r.cost_ngn, 0);
    const packagingBreakdown = [
      ...bottleDetail.map((r) => ({
        material_id: r.material_id,
        name: nameById.get(r.material_id) ?? "—",
        kind: "bottle" as const,
        units: r.units,
        unit_cost_ngn: r.units > 0 ? Math.round(r.cost_ngn / r.units) : 0,
        cost_ngn: r.cost_ngn,
      })),
      ...bagDetail.map((r) => ({
        material_id: r.material_id,
        name: nameById.get(r.material_id) ?? "—",
        kind: "bag" as const,
        units: r.units,
        unit_cost_ngn: r.units > 0 ? Math.round(r.cost_ngn / r.units) : 0,
        cost_ngn: r.cost_ngn,
      })),
    ];
```

(Leave `const packagingCost = bottlesCost + bagsCost;` and `const dailyProfit = netRevenue - packagingCost - expenses;` exactly as they are — they now consume the derived `bottlesCost`/`bagsCost`.)

- [ ] **Step 5: Add `margin_pct` and the new fields to the response**

Add the margin computation just after `const dailyProfit = ...`:

```typescript
    const marginPct = netRevenue > 0 ? Math.round((dailyProfit / netRevenue) * 1000) / 10 : null;
```

Then in the `return c.json({ data: { ... } })` object, add these keys alongside the existing ones (do not remove any existing key):

```typescript
        product_sales_ngn: productSales,
        delivery_fees_ngn: deliveryFees,
        revenue_by_size: revenueBySize,
        packaging_breakdown: packagingBreakdown,
        margin_pct: marginPct,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd mrs-samuel && pnpm --filter @ms/api test reports-daily`
Expected: PASS (all tests in the file, including the two pre-existing ones, stay green — `packaging_cost_*` totals are unchanged). Re-run the file alone if the testcontainer hook flakes.

- [ ] **Step 7: Build the API to confirm types**

Run: `cd mrs-samuel && pnpm --filter @ms/api build`
Expected: clean (`tsc -b`, exit 0). Note: `apps/api` has no `typecheck` script — `build` is the type gate.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/reports.ts apps/api/test/integration/reports-daily.test.ts
git commit -m "feat(api): daily revenue-by-size/type, packaging breakdown, reconciliation, margin"
```

---

### Task 2: Dashboard — three detailed financial cards

**Files:**
- Modify: `apps/admin/src/routes/owner/dashboard.tsx`

**Interfaces:**
- Consumes the Task 1 response fields via the extended `DailyFinancials` interface.
- Produces: no exports; rewrites the `{showFinance && (<section>…Daily financials…</section>)}` block.

- [ ] **Step 1: Extend the `DailyFinancials` interface**

In `apps/admin/src/routes/owner/dashboard.tsx`, replace the existing `interface DailyFinancials { … }` with (adds the new fields; keeps the old ones the rest of the file may reference):

```typescript
interface RevenueSizeRow {
  category: string;
  units: number;
  revenue_ngn: number;
  avg_unit_price_ngn: number;
}
interface RevenueBySize {
  size_ml: number;
  revenue_ngn: number;
  units: number;
  rows: RevenueSizeRow[];
}
interface PackagingLine {
  material_id: string;
  name: string;
  kind: "bottle" | "bag";
  units: number;
  unit_cost_ngn: number;
  cost_ngn: number;
}
interface DailyFinancials {
  date: string;
  revenue_ngn: number;
  refunds_ngn: number;
  net_revenue_ngn: number;
  product_sales_ngn: number;
  delivery_fees_ngn: number;
  revenue_by_size: RevenueBySize[];
  packaging_cost_ngn: number;
  packaging_cost_bottles_ngn: number;
  packaging_cost_bags_ngn: number;
  packaging_breakdown: PackagingLine[];
  expenses_ngn: number;
  daily_profit_ngn: number;
  margin_pct: number | null;
  total_units: number;
  units_by_size: Array<{ size_ml: number; units: number }>;
  caveats: string[];
}
```

- [ ] **Step 2: Add a category-label helper near the top of the file**

Add below the `slugify`/`today` helpers (module scope):

```typescript
const CATEGORY_LABEL: Record<string, string> = {
  regular: "Regular",
  special: "Special",
  punch: "Punch",
};
```

- [ ] **Step 3: Replace the daily-financials block with the three cards**

Replace the entire `{showFinance && ( <section className="card" style={{ marginBottom: 26 }}> … </section> )}` block (the one whose `<h2>` is "Daily financials", containing the four `<Stat>` tiles, the "Cans by size" line, caveats, and the "Which expenses count?" `<details>`) with:

```tsx
      {showFinance && (
        <section className="card" style={{ marginBottom: 26 }}>
          <header className="card__head">
            <h2 className="t-h2">Daily financials</h2>
            <input
              type="date"
              className="input"
              style={{ width: 160, height: 36 }}
              value={finDate}
              max={today()}
              onChange={(e) => setFinDate(e.target.value)}
            />
          </header>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 16,
            }}
          >
            {/* ── Card 1: Net revenue (nested size → type, reconciled) ── */}
            <div className="card card--soft" style={{ padding: 16 }}>
              <Stat label="Net revenue" value={ngn(daily?.net_revenue_ngn ?? 0)} tone="accent" />
              {daily && daily.revenue_by_size.length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  {daily.revenue_by_size.map((s) => (
                    <div key={s.size_ml} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                        <span>{s.size_ml}ml</span>
                        <span className="tabular-nums">{ngn(s.revenue_ngn)}</span>
                      </div>
                      {s.rows.map((r) => (
                        <div
                          key={r.category}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: 13,
                            color: "var(--ink-soft)",
                            paddingLeft: 12,
                          }}
                        >
                          <span>
                            {CATEGORY_LABEL[r.category] ?? r.category} · {r.units} × {ngn(r.avg_unit_price_ngn)} avg
                          </span>
                          <span className="tabular-nums">{ngn(r.revenue_ngn)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  <div style={{ borderTop: "1px solid var(--line)", marginTop: 8, paddingTop: 8 }}>
                    <ReconLine label="Product sales" value={ngn(daily.product_sales_ngn)} />
                    {daily.delivery_fees_ngn > 0 && (
                      <ReconLine label="+ Delivery fees" value={ngn(daily.delivery_fees_ngn)} />
                    )}
                    {daily.refunds_ngn > 0 && (
                      <ReconLine label="− Refunds" value={ngn(daily.refunds_ngn)} />
                    )}
                    <ReconLine label="= Net revenue" value={ngn(daily.net_revenue_ngn)} strong />
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 12, fontSize: 13, color: "var(--ink-soft)" }}>No sales recorded.</div>
              )}
            </div>

            {/* ── Card 2: Packaging cost (per material, grouped) ── */}
            <div className="card card--soft" style={{ padding: 16 }}>
              <Stat label="Packaging cost" value={ngn(daily?.packaging_cost_ngn ?? 0)} />
              {daily && daily.packaging_breakdown.length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  {(["bottle", "bag"] as const).map((kind) => {
                    const lines = daily.packaging_breakdown.filter((p) => p.kind === kind);
                    if (lines.length === 0) return null;
                    const subtotal = lines.reduce((s, p) => s + p.cost_ngn, 0);
                    return (
                      <div key={kind} style={{ marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                          <span>{kind === "bottle" ? "Bottles" : "Bags"}</span>
                          <span className="tabular-nums">{ngn(subtotal)}</span>
                        </div>
                        {lines.map((p) => (
                          <div
                            key={p.material_id}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: 13,
                              color: "var(--ink-soft)",
                              paddingLeft: 12,
                            }}
                          >
                            <span>
                              {p.name} · {p.units} × {ngn(p.unit_cost_ngn)}
                            </span>
                            <span className="tabular-nums">{ngn(p.cost_ngn)}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ marginTop: 12, fontSize: 13, color: "var(--ink-soft)" }}>No packaging consumed.</div>
              )}
              {daily && daily.caveats.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: "var(--warning)" }}>
                  {daily.caveats.join(" · ")}
                </div>
              )}
            </div>

            {/* ── Card 3: Profit (waterfall + margin %) ── */}
            <div className="card card--soft" style={{ padding: 16 }}>
              <Stat
                label="Daily profit"
                value={ngn(daily?.daily_profit_ngn ?? 0)}
                tone={(daily?.daily_profit_ngn ?? 0) >= 0 ? "good" : "bad"}
              />
              <div style={{ marginTop: 12 }}>
                <ReconLine label="Net revenue" value={ngn(daily?.net_revenue_ngn ?? 0)} />
                <ReconLine label="− Packaging cost" value={ngn(daily?.packaging_cost_ngn ?? 0)} />
                <ReconLine label="− Expenses" value={ngn(daily?.expenses_ngn ?? 0)} />
                <div style={{ borderTop: "1px solid var(--line)", marginTop: 8, paddingTop: 8 }}>
                  <ReconLine label="= Profit" value={ngn(daily?.daily_profit_ngn ?? 0)} strong />
                  <ReconLine
                    label="Margin"
                    value={daily?.margin_pct == null ? "—" : `${daily.margin_pct}%`}
                  />
                </div>
              </div>
            </div>
          </div>

          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>
              Which expenses count?
            </summary>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 10 }}>
              {DAILY_EXPENSE_CATEGORIES.map((cat) => (
                <label key={cat.code} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={includedCats.includes(cat.code)}
                    onChange={() => toggleCat(cat.code)}
                  />
                  {cat.label}
                </label>
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-soft)" }}>
              Bottle &amp; bag purchases are always excluded — they're counted per unit sold.
            </div>
          </details>
        </section>
      )}
```

- [ ] **Step 4: Add the `ReconLine` presentational helper**

Add this near the bottom of the file (module scope, e.g. just before or after the `Stat` usage — anywhere at module level; do NOT nest it inside `DashboardPage`):

```tsx
function ReconLine({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        padding: "3px 0",
        fontSize: strong ? 15 : 13,
        fontWeight: strong ? 800 : 500,
        color: strong ? "var(--ink)" : "var(--ink-soft)",
      }}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck + build the admin app**

Run: `cd mrs-samuel && pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin build`
Expected: both clean. (`apps/admin` has no `lint` script — do not run lint.)

- [ ] **Step 6: Self-check the rendering logic**

Confirm by reading the code: the three cards sit in one responsive grid; the Net revenue card reconciles (Product sales +Delivery −Refunds = Net revenue) with delivery/refund rows hidden when 0; the Packaging card groups Bottles then Bags with per-material `units × unit_cost = cost` and a subtotal each; the Profit card shows the waterfall with margin "—" when `margin_pct` is null; the removed "Cans by size" units line is gone (units now live in the Net revenue card rows). No leftover references to the deleted four-tile layout remain.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/routes/owner/dashboard.tsx
git commit -m "feat(admin): detailed daily financials cards (net revenue, packaging, profit)"
```

---

## Final verification

- [ ] **Run the API daily test + both builds**

Run: `cd mrs-samuel && pnpm --filter @ms/api test reports-daily && pnpm --filter @ms/api build && pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin build`
Expected: test passes (re-run the test file alone if the testcontainer hook flakes), all builds clean.

- [ ] **Manual smoke (real owner login — flag to user):** open the owner dashboard for a day with sales across multiple sizes/categories; confirm the Net revenue card breaks down by size→type and reconciles to the header, the Packaging card lists each material with units × unit cost, and the Profit card shows the waterfall + margin %. Verify a non-finance user still sees only the operational strip (no financials).

## Notes on spec coverage

- Net revenue nested size→type with actual-recorded basis + reconciliation → Task 1 Step 3 + Task 2 Card 1.
- Packaging per-material breakdown → Task 1 Step 4 + Task 2 Card 2.
- Profit waterfall + margin % → Task 1 Step 5 + Task 2 Card 3.
- `finance.view` gating, today-only, additive API, no migration → preserved throughout.

# Dashboard Financials Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner a real per-day profit view (revenue − FIFO per-unit packaging cost − that day's expenses) and split the dashboard into an owner financial face and an admin/manager operational face.

**Architecture:** A new owner-only `finance.view` capability gates a new `GET /reports/daily` endpoint that does the money math; `GET /reports/overview` is restructured to be operational-only (no money) so admin/manager never receive financial figures. FIFO packaging cost is a pure, unit-tested function in `apps/api/src/lib/packaging-cost.ts`. The owner's "which expense categories count" choice persists in `localStorage` (mirroring `receipt-settings`) and rides along as a query param.

**Tech Stack:** Hono + Drizzle (`db.execute(sql\`...\`)` raw SQL), TypeScript, Vitest (`vitest run`) with Testcontainers Postgres for integration; React + TanStack Router admin UI.

## Global Constraints

- **Money is integer NGN** everywhere (`amount_ngn`, `*_ngn` are `integer`). Never floats.
- **Qualifying-sale status filter** (revenue & unit counts): `status IN ('paid','handed_over','delivered')`, dated by `created_at_local::date`. Refunds: `sale_return.status = 'completed'`, dated by `created_at::date`.
- **`packaging` business_expense category is ALWAYS excluded** from daily expenses (counted per-unit instead). Never include it regardless of the category filter.
- **FIFO is costing-only** — it never reads from or writes to `stock_ledger` / `packaging_stock_ledger`. It reads `packaging_purchase` layers and sold-unit counts only.
- **New capability is owner-only:** add `finance.view` to `CAPABILITIES` but NOT to `ADMIN_CAPS` or `MANAGER_CAPS` (owner gets it via `[...CAPABILITIES]`). Same pattern as `packaging.adjust`.
- **No DB migration** in this work. `finance.view` is code-level; no new tables.
- **Dashboard resilience:** an optional/forbidden widget fetch must never blank the page — wrap with `.catch(() => null)` and treat missing fields as `0`, exactly as the current dashboard does for `/review`.
- **Integration test boilerplate:** copy the `beforeAll/afterAll` container+server setup verbatim from `apps/api/test/integration/reports-overview.test.ts` (setupTestDb → seed → `buildApp()` → `serve({ port: 0 })` → `loginAs`). 120_000ms timeout on `beforeAll`.
- Run a single API test file with: `cd apps/api && npx vitest run test/<path>` (or `pnpm --filter @ms/api test` for the whole suite — heavy, prefer single-file).

---

## File Structure

- `packages/shared/src/permissions.ts` — **modify**: add `finance.view` capability (owner-only).
- `apps/api/src/lib/packaging-cost.ts` — **create**: pure `allocateFifo()` FIFO allocator.
- `apps/api/test/unit/packaging-cost.test.ts` — **create**: unit tests for `allocateFifo()`.
- `apps/api/src/routes/reports.ts` — **modify**: add `GET /daily` (finance.view); restructure `GET /overview` (operational-only).
- `apps/api/test/integration/reports-daily.test.ts` — **create**: endpoint + auth + math tests.
- `apps/api/test/integration/reports-overview.test.ts` — **modify**: assert new operational shape, no money fields.
- `apps/admin/src/lib/finance-settings.ts` — **create**: localStorage get/set for included expense categories.
- `apps/admin/src/routes/owner/dashboard.tsx` — **modify**: two faces (finance vs operational), daily financial block, category filter, remove month-profit stat.
- `apps/admin/src/routes/owner/bookkeeping.tsx` — **modify**: gate P&L tab behind `finance.view`.

---

## Task 1: Add the owner-only `finance.view` capability

**Files:**
- Modify: `packages/shared/src/permissions.ts`
- Test: `packages/shared/` (existing shared test file pattern — colocate a new test or extend an existing permissions test)

**Interfaces:**
- Produces: capability string literal `"finance.view"` added to the `CAPABILITIES` tuple. `resolveCapabilities("owner")` includes it; `resolveCapabilities("admin")` and `resolveCapabilities("manager")` do not.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/permissions.finance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveCapabilities, CAPABILITIES } from "./permissions.js";

describe("finance.view capability", () => {
  it("is in the capability catalog", () => {
    expect(CAPABILITIES).toContain("finance.view");
  });
  it("is granted to owner by default", () => {
    expect(resolveCapabilities("owner")).toContain("finance.view");
  });
  it("is NOT granted to admin or manager by default", () => {
    expect(resolveCapabilities("admin")).not.toContain("finance.view");
    expect(resolveCapabilities("manager")).not.toContain("finance.view");
  });
  it("can be granted to a manager via overrides", () => {
    expect(
      resolveCapabilities("manager", { granted: ["finance.view"], revoked: [] }),
    ).toContain("finance.view");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/permissions.finance.test.ts`
Expected: FAIL — `CAPABILITIES` does not contain `"finance.view"`.

- [ ] **Step 3: Add the capability (owner-only)**

In `packages/shared/src/permissions.ts`, add `"finance.view"` to the `CAPABILITIES` tuple (place it next to `"reports.view"`), with a comment matching the `packaging.adjust` precedent:

```ts
  "reports.view",
  // Owner-only by default: the daily-profit financial view (revenue, packaging
  // cost, profit). Deliberately NOT in ADMIN_CAPS/MANAGER_CAPS — admins/managers
  // see operational signals only. Grantable per-user via overrides.
  "finance.view",
```

Do **not** add it to `ADMIN_CAPS` or `MANAGER_CAPS`. (`owner` already gets it via `ROLE_DEFAULTS.owner: [...CAPABILITIES]`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/permissions.finance.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Rebuild shared so dependents see the new type**

Run: `pnpm --filter @ms/shared build`
Expected: clean build (the `Capability` union now includes `"finance.view"`).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/permissions.ts packages/shared/src/permissions.finance.test.ts
git commit -m "feat: add owner-only finance.view capability"
```

---

## Task 2: Pure FIFO packaging-cost allocator

**Files:**
- Create: `apps/api/src/lib/packaging-cost.ts`
- Test: `apps/api/test/unit/packaging-cost.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CostLayer { quantity: number; unitCostNgn: number }
  export interface FifoResult { costNgn: number; unitsFromLayers: number; unitsFallback: number }
  // Allocates `dayUnits` units to FIFO layers AFTER skipping `priorUnits` already
  // consumed. Units beyond all layers are costed at `fallbackUnitCostNgn` (the
  // most-recent purchase price). Layers must be passed oldest-first.
  export function allocateFifo(
    layers: readonly CostLayer[],
    priorUnits: number,
    dayUnits: number,
    fallbackUnitCostNgn: number,
  ): FifoResult
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/unit/packaging-cost.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { allocateFifo } from "../../src/lib/packaging-cost.js";

describe("allocateFifo", () => {
  it("returns zero cost when no units consumed on the day", () => {
    expect(allocateFifo([{ quantity: 100, unitCostNgn: 50 }], 0, 0, 50)).toEqual({
      costNgn: 0,
      unitsFromLayers: 0,
      unitsFallback: 0,
    });
  });

  it("costs all day-units from a single layer", () => {
    // 10 sold today, all from the 50-naira layer
    expect(allocateFifo([{ quantity: 100, unitCostNgn: 50 }], 0, 10, 50)).toEqual({
      costNgn: 500,
      unitsFromLayers: 10,
      unitsFallback: 0,
    });
  });

  it("spans two layers when the first is partially pre-consumed (the owner's '20 left' rule)", () => {
    // layer A: 20 @ 40, layer B: 100 @ 60. 5 already consumed (prior).
    // 30 sold today -> 15 remaining in A @40 + 15 from B @60 = 600 + 900 = 1500
    expect(
      allocateFifo(
        [{ quantity: 20, unitCostNgn: 40 }, { quantity: 100, unitCostNgn: 60 }],
        5,
        30,
        60,
      ),
    ).toEqual({ costNgn: 1500, unitsFromLayers: 30, unitsFallback: 0 });
  });

  it("skips fully-consumed leading layers via priorUnits", () => {
    // layer A: 20 @ 40 fully consumed (prior=20). 10 sold today all from B @60 = 600
    expect(
      allocateFifo(
        [{ quantity: 20, unitCostNgn: 40 }, { quantity: 100, unitCostNgn: 60 }],
        20,
        10,
        60,
      ),
    ).toEqual({ costNgn: 600, unitsFromLayers: 10, unitsFallback: 0 });
  });

  it("falls back to the latest price when layers are exhausted", () => {
    // layer A: 20 @ 40 (total stock 20). prior=15, sell 10 today:
    // 5 from A @40 = 200, 5 beyond stock @ fallback 55 = 275 -> 475
    expect(
      allocateFifo([{ quantity: 20, unitCostNgn: 40 }], 15, 10, 55),
    ).toEqual({ costNgn: 475, unitsFromLayers: 5, unitsFallback: 5 });
  });

  it("uses fallback for every unit when there are no layers at all", () => {
    expect(allocateFifo([], 0, 8, 70)).toEqual({
      costNgn: 560,
      unitsFromLayers: 0,
      unitsFallback: 8,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/unit/packaging-cost.test.ts`
Expected: FAIL — module `../../src/lib/packaging-cost.js` not found.

- [ ] **Step 3: Implement the allocator**

Create `apps/api/src/lib/packaging-cost.ts`:

```ts
/**
 * FIFO costing for packaging consumed by sales. Pure, costing-only — it never
 * touches the physical stock ledger. Layers are purchase lots (oldest first);
 * `priorUnits` is how many units were already consumed before the target day
 * (the queue offset); `dayUnits` is consumed on the day being costed. Units
 * beyond all layer capacity are costed at `fallbackUnitCostNgn` (the most
 * recent purchase price), matching the owner's "pick up the last recorded unit
 * price once stock runs out" rule.
 */
export interface CostLayer {
  quantity: number;
  unitCostNgn: number;
}

export interface FifoResult {
  costNgn: number;
  unitsFromLayers: number;
  unitsFallback: number;
}

export function allocateFifo(
  layers: readonly CostLayer[],
  priorUnits: number,
  dayUnits: number,
  fallbackUnitCostNgn: number,
): FifoResult {
  let skip = Math.max(0, priorUnits);
  let remaining = Math.max(0, dayUnits);
  let costNgn = 0;
  let unitsFromLayers = 0;

  for (const layer of layers) {
    if (remaining === 0) break;
    let avail = layer.quantity;
    // Burn down the prior-consumed offset against this layer first.
    if (skip > 0) {
      const burned = Math.min(skip, avail);
      skip -= burned;
      avail -= burned;
    }
    if (avail === 0) continue;
    const take = Math.min(avail, remaining);
    costNgn += take * layer.unitCostNgn;
    unitsFromLayers += take;
    remaining -= take;
  }

  const unitsFallback = remaining;
  costNgn += unitsFallback * fallbackUnitCostNgn;
  return { costNgn, unitsFromLayers, unitsFallback };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run test/unit/packaging-cost.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/packaging-cost.ts apps/api/test/unit/packaging-cost.test.ts
git commit -m "feat: FIFO packaging-cost allocator (pure, unit-tested)"
```

---

## Task 3: `GET /reports/daily` endpoint (finance.view)

**Files:**
- Modify: `apps/api/src/routes/reports.ts`
- Test: `apps/api/test/integration/reports-daily.test.ts`

**Interfaces:**
- Consumes: `allocateFifo`, `CostLayer` from `../lib/packaging-cost.js` (Task 2); `finance.view` capability (Task 1).
- Produces: `GET /v1/reports/daily?date=YYYY-MM-DD&expense_categories=a,b,c` returning the `data` shape documented below. Gated by `requireCapability("finance.view")`.

**Implementation notes for the endpoint (build inside `reportRoutes`, after `/overview`):**

- The route file mounts `r.use("*", requireAuth(), requireCapability("reports.view"))` globally. Add a **second** capability gate on this route specifically: `r.get("/daily", requireCapability("finance.view"), async (c) => {...})`. (`requireCapability` is per-route middleware; the global one still runs first — owner has both, so fine.)
- `date` default: `new Date().toISOString().slice(0, 10)`. Validate `^\d{4}-\d{2}-\d{2}$` → 400 `validation_failed` (same shape as `/pnl`).
- `expense_categories`: parse comma-separated; intersect with the real category codes; **always drop `packaging`**; if param absent, default to all categories except `packaging`.
- Revenue/refunds for the day: reuse the `/pnl` pattern but single-day (`created_at_local::date = ${date}` for sales; `created_at::date = ${date}` for completed refunds).
- Bottle units per `bottle_material_id`: join `sale_order_item` → `sale_order` (qualifying status, `created_at_local::date = ${date}`) → `product_variant` (`variant_id`), group by `pv.bottle_material_id`, `SUM(quantity)`. Prior bottle units: same but `created_at_local::date < ${date}`.
- Bag units per `packaging_material_id`: `sale_order_packaging` → `sale_order` (qualifying status). Day and prior the same way.
- Purchase layers per material: `SELECT packaging_material_id, quantity, unit_cost_ngn FROM packaging_purchase ORDER BY purchase_date ASC, id ASC`. Fallback unit cost per material: the **last** layer's `unit_cost_ngn` (latest by purchase_date) — reuse the existing `DISTINCT ON (packaging_material_id) ... ORDER BY purchase_date DESC` pattern from `packaging.ts:165`.
- For each material with day-units > 0, call `allocateFifo(layers, prior, day, fallback)`. Sum bottle costs and bag costs separately. If a material has neither layers nor purchases (fallback 0), push a caveat `"<material name> has no purchase history — costed at ₦0"`.
- `units_by_size` / `total_units`: `sale_order_item` × `product_variant.size_ml`, qualifying status, day; group by `size_ml`.
- Compute in JS: `net_revenue_ngn = revenue − refunds`; `packaging_cost_ngn = bottles + bags`; `daily_profit_ngn = net_revenue − packaging_cost − expenses`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/reports-daily.test.ts`. Copy the container/server boilerplate from `reports-overview.test.ts` (Global Constraints). Seed with raw drizzle inserts. Use `seedUser` for an admin to assert the 403.

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("GET /v1/reports/daily", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let ownerCookies: string;
  let adminCookies: string;
  let server: ReturnType<typeof serve>;
  const DATE = "2026-06-19";

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    const db = tdb.db;
    await seedOwner(db);
    await seedUser(db, { email: "admin@example.com", role: "admin" });

    // --- Minimal catalog: 1 factory, 1 branch, 1 product, 1 variant (650ml) ---
    // Insert via db.execute(sql`...`) or drizzle inserts. Capture ids.
    // bottle_material: 650ml glass bottle; bag_material: Small bag.
    // packaging_purchase for the bottle: lot A 20 @ ₦40 (2026-06-01),
    //                                    lot B 100 @ ₦60 (2026-06-10).
    // packaging_purchase for the bag: 100 @ ₦25 (2026-06-05).
    // sale_order (paid, branch, created_at_local 2026-06-19) with:
    //   - sale_order_item: 30 units of the 650ml variant (-> bottle cost)
    //   - sale_order_packaging: 12 bags
    // business_expense on 2026-06-19: transport ₦5000, packaging ₦999999 (must be ignored),
    //   salaries ₦8000.
    // (See plan Task 3 notes for exact column lists; reuse schema from packages/db.)

    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    ownerCookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    adminCookies = await loginAs(baseUrl, "admin@example.com", "userpassword123");
  }, 120_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("forbids admin (no finance.view)", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/daily?date=${DATE}`, {
      headers: { cookie: adminCookies },
    });
    expect(res.status).toBe(403);
  });

  it("computes FIFO bottle cost spanning two purchase lots", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/daily?date=${DATE}`, {
      headers: { cookie: ownerCookies },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { packaging_cost_bottles_ngn: number; packaging_cost_bags_ngn: number; total_units: number; units_by_size: Array<{ size_ml: number; units: number }> } };
    // 30 bottles: 20 @40 + 10 @60 = 800 + 600 = 1400
    expect(data.packaging_cost_bottles_ngn).toBe(1400);
    // 12 bags @25 = 300
    expect(data.packaging_cost_bags_ngn).toBe(300);
    expect(data.total_units).toBe(30);
    expect(data.units_by_size).toEqual([{ size_ml: 650, units: 30 }]);
  });

  it("excludes the packaging category from daily expenses but includes selected ones", async () => {
    const res = await fetch(
      `${baseUrl}/v1/reports/daily?date=${DATE}&expense_categories=transport,salaries`,
      { headers: { cookie: ownerCookies } },
    );
    const { data } = (await res.json()) as { data: { expenses_ngn: number } };
    expect(data.expenses_ngn).toBe(13000); // 5000 + 8000, packaging 999999 ignored
  });

  it("honours the category filter (transport only)", async () => {
    const res = await fetch(
      `${baseUrl}/v1/reports/daily?date=${DATE}&expense_categories=transport`,
      { headers: { cookie: ownerCookies } },
    );
    const { data } = (await res.json()) as { data: { expenses_ngn: number } };
    expect(data.expenses_ngn).toBe(5000);
  });
});
```

> Implementer note: fill the seed block using `tdb.db.insert(...)` from `@ms/db` schema (`factory`, `branch`, `product`, `productVariant`, `packagingMaterial`, `packagingPurchase`, `saleOrder`, `saleOrderItem`, `saleOrderPackaging`, `businessExpense`, `productPrice`). `sale_order_item.product_price_id` is NOT NULL → seed a `productPrice` row and reference it. `sale_order` requires `orderNumber`, `idempotencyKey` (uuid), `subtotalNgn`, `totalNgn`, `paymentMethod`, `createdAtLocal`. Set `status: 'paid'`, `channel: 'walkup'`, `createdAtLocal` to `${DATE}T10:00:00+01:00`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/reports-daily.test.ts`
Expected: FAIL — route returns 404 (not yet defined) / assertions fail.

- [ ] **Step 3: Implement `GET /daily`**

In `apps/api/src/routes/reports.ts`, add the import at top:

```ts
import { allocateFifo, type CostLayer } from "../lib/packaging-cost.js";
```

Add the route after the `/overview` handler (inside `reportRoutes`, before `return r;`):

```ts
  r.get("/daily", requireCapability("finance.view"), async (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json(
        { error: { code: "validation_failed", message: "date must be YYYY-MM-DD" } },
        400,
      );
    }

    const ALL_CATEGORIES = [
      "raw_materials", "packaging", "utilities", "transport", "salaries",
      "rent", "marketing", "equipment", "regulatory", "other_with_note",
    ] as const;
    const LABEL: Record<string, string> = {
      raw_materials: "Raw materials", packaging: "Packaging", utilities: "Utilities",
      transport: "Transport", salaries: "Salaries", rent: "Rent", marketing: "Marketing",
      equipment: "Equipment", regulatory: "Regulatory", other_with_note: "Other",
    };
    const requested = c.req.query("expense_categories");
    // packaging is ALWAYS excluded (counted per-unit). Default = all non-packaging.
    const selected = (requested
      ? requested.split(",").map((s) => s.trim()).filter((s) => ALL_CATEGORIES.includes(s as never))
      : ALL_CATEGORIES.filter((cat) => cat !== "packaging")
    ).filter((cat) => cat !== "packaging");

    // ── revenue + refunds for the day ──
    const revRow = await db.execute<{ revenue_ngn: number; refunds_ngn: number }>(sql`
      SELECT
        COALESCE((SELECT SUM(total_ngn) FROM sale_order
          WHERE status IN ('paid','handed_over','delivered')
            AND created_at_local::date = ${date}::date), 0)::int AS revenue_ngn,
        COALESCE((SELECT SUM(refund_amount_ngn) FROM sale_return
          WHERE status = 'completed' AND created_at::date = ${date}::date), 0)::int AS refunds_ngn
    `);
    const revenue = Number(revRow[0]?.revenue_ngn ?? 0);
    const refunds = Number(revRow[0]?.refunds_ngn ?? 0);

    // ── bottle units (day + prior) per bottle_material_id ──
    const bottleDay = await db.execute<{ material_id: string; units: number }>(sql`
      SELECT pv.bottle_material_id AS material_id, SUM(i.quantity)::int AS units
      FROM sale_order_item i
      JOIN sale_order o ON o.id = i.sale_order_id
      JOIN product_variant pv ON pv.id = i.variant_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date = ${date}::date
        AND pv.bottle_material_id IS NOT NULL
      GROUP BY pv.bottle_material_id
    `);
    const bottlePrior = await db.execute<{ material_id: string; units: number }>(sql`
      SELECT pv.bottle_material_id AS material_id, SUM(i.quantity)::int AS units
      FROM sale_order_item i
      JOIN sale_order o ON o.id = i.sale_order_id
      JOIN product_variant pv ON pv.id = i.variant_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date < ${date}::date
        AND pv.bottle_material_id IS NOT NULL
      GROUP BY pv.bottle_material_id
    `);

    // ── bag units (day + prior) per packaging_material_id ──
    const bagDay = await db.execute<{ material_id: string; units: number }>(sql`
      SELECT sop.packaging_material_id AS material_id, SUM(sop.quantity)::int AS units
      FROM sale_order_packaging sop
      JOIN sale_order o ON o.id = sop.sale_order_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date = ${date}::date
      GROUP BY sop.packaging_material_id
    `);
    const bagPrior = await db.execute<{ material_id: string; units: number }>(sql`
      SELECT sop.packaging_material_id AS material_id, SUM(sop.quantity)::int AS units
      FROM sale_order_packaging sop
      JOIN sale_order o ON o.id = sop.sale_order_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date < ${date}::date
      GROUP BY sop.packaging_material_id
    `);

    // ── purchase layers (oldest first) + latest fallback price + names ──
    const layerRows = await db.execute<{ material_id: string; quantity: number; unit_cost_ngn: number }>(sql`
      SELECT packaging_material_id AS material_id, quantity, unit_cost_ngn
      FROM packaging_purchase
      ORDER BY purchase_date ASC, id ASC
    `);
    const latestRows = await db.execute<{ material_id: string; unit_cost_ngn: number }>(sql`
      SELECT DISTINCT ON (packaging_material_id) packaging_material_id AS material_id, unit_cost_ngn
      FROM packaging_purchase
      ORDER BY packaging_material_id, purchase_date DESC, id DESC
    `);
    const nameRows = await db.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM packaging_material
    `);

    const layersByMat = new Map<string, CostLayer[]>();
    for (const row of layerRows) {
      const list = layersByMat.get(row.material_id) ?? [];
      list.push({ quantity: Number(row.quantity), unitCostNgn: Number(row.unit_cost_ngn) });
      layersByMat.set(row.material_id, list);
    }
    const fallbackByMat = new Map(latestRows.map((r) => [r.material_id, Number(r.unit_cost_ngn)]));
    const nameById = new Map(nameRows.map((r) => [r.id, r.name]));
    const priorBottle = new Map(bottlePrior.map((r) => [r.material_id, Number(r.units)]));
    const priorBag = new Map(bagPrior.map((r) => [r.material_id, Number(r.units)]));
    const caveats: string[] = [];

    function costFor(
      dayRows: Array<{ material_id: string; units: number }>,
      priorMap: Map<string, number>,
    ): number {
      let total = 0;
      for (const row of dayRows) {
        const layers = layersByMat.get(row.material_id) ?? [];
        const fallback = fallbackByMat.get(row.material_id) ?? 0;
        if (layers.length === 0 && fallback === 0) {
          caveats.push(`${nameById.get(row.material_id) ?? "A material"} has no purchase history — costed at ₦0`);
        }
        const res = allocateFifo(layers, priorMap.get(row.material_id) ?? 0, Number(row.units), fallback);
        total += res.costNgn;
      }
      return total;
    }

    const bottlesCost = costFor(bottleDay, priorBottle);
    const bagsCost = costFor(bagDay, priorBag);

    // ── expenses for the day (selected categories, never packaging) ──
    const expRows = await db.execute<{ category_code: string; amount_ngn: number }>(sql`
      SELECT category_code, COALESCE(SUM(amount_ngn), 0)::int AS amount_ngn
      FROM business_expense
      WHERE deleted_at IS NULL
        AND expense_date = ${date}::date
        AND category_code = ANY(${sql.raw(`ARRAY[${selected.map((s) => `'${s}'`).join(",") || "''"}]::business_expense_category[]`)})
      GROUP BY category_code
    `);
    const expensesByCat = expRows.map((r) => ({
      category_code: r.category_code,
      label: LABEL[r.category_code] ?? r.category_code,
      amount_ngn: Number(r.amount_ngn),
    }));
    const expenses = expensesByCat.reduce((s, r) => s + r.amount_ngn, 0);

    // ── units by size ──
    const sizeRows = await db.execute<{ size_ml: number; units: number }>(sql`
      SELECT pv.size_ml, SUM(i.quantity)::int AS units
      FROM sale_order_item i
      JOIN sale_order o ON o.id = i.sale_order_id
      JOIN product_variant pv ON pv.id = i.variant_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date = ${date}::date
      GROUP BY pv.size_ml
      ORDER BY pv.size_ml
    `);
    const unitsBySize = sizeRows.map((r) => ({ size_ml: Number(r.size_ml), units: Number(r.units) }));
    const totalUnits = unitsBySize.reduce((s, r) => s + r.units, 0);

    const netRevenue = revenue - refunds;
    const packagingCost = bottlesCost + bagsCost;
    const dailyProfit = netRevenue - packagingCost - expenses;

    return c.json({
      data: {
        date,
        revenue_ngn: revenue,
        refunds_ngn: refunds,
        net_revenue_ngn: netRevenue,
        packaging_cost_ngn: packagingCost,
        packaging_cost_bottles_ngn: bottlesCost,
        packaging_cost_bags_ngn: bagsCost,
        expenses_ngn: expenses,
        expenses_by_category: expensesByCat,
        daily_profit_ngn: dailyProfit,
        total_units: totalUnits,
        units_by_size: unitsBySize,
        caveats: Array.from(new Set(caveats)),
      },
    });
  });
```

> Note on the `ANY(ARRAY[...])` cast: `selected` is built only from the fixed `ALL_CATEGORIES` allowlist, so the inlined strings are safe (no user-supplied text reaches the SQL). Empty selection yields `ARRAY['']` which matches nothing → ₦0 expenses, which is correct.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run test/integration/reports-daily.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/reports.ts apps/api/test/integration/reports-daily.test.ts
git commit -m "feat: GET /reports/daily owner daily-profit endpoint (FIFO + expenses)"
```

---

## Task 4: Restructure `GET /reports/overview` to operational-only

**Files:**
- Modify: `apps/api/src/routes/reports.ts` (the `/overview` handler)
- Test: `apps/api/test/integration/reports-overview.test.ts`

**Interfaces:**
- Produces new `data` shape:
  ```ts
  {
    stock: { low_stock_factory: number; low_stock_branch: number; expiring_48h: number };
    fulfilment: { orders_pending: number; preorders_open: number; bags_queue: number; pending_transfers: number };
    today: { total_units: number; units_by_size: Array<{ size_ml: number; units: number }> };
  }
  ```
  Money fields (`today.net_ngn` etc., entire `growth` block) are **removed**.

- [ ] **Step 1: Update the failing test**

Replace the shape assertions in `apps/api/test/integration/reports-overview.test.ts` with the new contract. Replace the `json` type and the per-block assertions:

```ts
    const json = (await res.json()) as {
      data: {
        stock: { low_stock_factory: number; low_stock_branch: number; expiring_48h: number };
        fulfilment: { orders_pending: number; preorders_open: number; bags_queue: number; pending_transfers: number };
        today: { total_units: number; units_by_size: Array<{ size_ml: number; units: number }> };
      };
    };
    const { data } = json;

    expect(typeof data.stock.low_stock_factory).toBe("number");
    expect(typeof data.stock.low_stock_branch).toBe("number");
    expect(typeof data.stock.expiring_48h).toBe("number");
    expect(typeof data.fulfilment.orders_pending).toBe("number");
    expect(typeof data.fulfilment.preorders_open).toBe("number");
    expect(typeof data.fulfilment.bags_queue).toBe("number");
    expect(typeof data.fulfilment.pending_transfers).toBe("number");
    expect(typeof data.today.total_units).toBe("number");
    expect(Array.isArray(data.today.units_by_size)).toBe(true);
    // money must NOT leak into the operational overview
    expect((data as Record<string, unknown>).growth).toBeUndefined();
    expect((data.today as Record<string, unknown>).net_ngn).toBeUndefined();
```

Delete any remaining assertions in this file that reference `growth.*`, `today.net_ngn`, `today.yesterday_net_ngn`, `today.wtd_net_ngn`, or `stock.low_stock_skus`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/reports-overview.test.ts`
Expected: FAIL — current handler still returns `growth`/`today.net_ngn` and `stock.low_stock_skus`.

- [ ] **Step 3: Rewrite the `/overview` handler**

Replace the body of `r.get("/overview", ...)` with operational-only blocks. Keep the `block()` helper. Replace the four `Promise.all` blocks and the final `c.json`:

```ts
    const [stockBlock, fulfilmentBlock, todayBlock] = await Promise.all([
      block("stock", async () => {
        const [factory, branch] = await Promise.all([
          db.execute<{ n: number }>(sql`
            SELECT COUNT(*)::int AS n FROM (
              SELECT product_id, variant_id, COALESCE(SUM(delta),0) AS balance
              FROM stock_ledger WHERE location_type = 'factory'
              GROUP BY product_id, variant_id
            ) t WHERE balance BETWEEN 1 AND 10
          `),
          db.execute<{ n: number }>(sql`
            SELECT COUNT(*)::int AS n FROM (
              SELECT product_id, variant_id, COALESCE(SUM(delta),0) AS balance
              FROM stock_ledger WHERE location_type = 'branch'
              GROUP BY product_id, variant_id
            ) t WHERE balance BETWEEN 1 AND 10
          `),
        ]);
        return {
          low_stock_factory: Number(factory[0]?.n ?? 0),
          low_stock_branch: Number(branch[0]?.n ?? 0),
          expiring_48h: 0,
        };
      }, { low_stock_factory: 0, low_stock_branch: 0, expiring_48h: 0 }),

      block("fulfilment", async () => {
        const [pendingRow, preorderRow, bagsRow, transferRow] = await Promise.all([
          db.execute<{ cnt: number }>(sql`
            SELECT COUNT(*)::int AS cnt FROM sale_order
            WHERE is_preorder = false
              AND status IN ('confirmed','paid','handed_over','out_for_delivery')`),
          db.execute<{ cnt: number }>(sql`
            SELECT COUNT(*)::int AS cnt FROM sale_order
            WHERE is_preorder = true
              AND status IN ('confirmed','paid','handed_over','out_for_delivery')`),
          db.execute<{ cnt: number }>(sql`
            SELECT COUNT(DISTINCT sop.sale_order_id)::int AS cnt
            FROM sale_order_packaging sop
            JOIN sale_order so ON so.id = sop.sale_order_id
            WHERE so.status = 'confirmed'`),
          db.execute<{ cnt: number }>(sql`
            SELECT COUNT(*)::int AS cnt FROM stock_transfer
            WHERE status IN ('dispatched','in_transit','arrived')`),
        ]);
        return {
          orders_pending: Number(pendingRow[0]?.cnt ?? 0),
          preorders_open: Number(preorderRow[0]?.cnt ?? 0),
          bags_queue: Number(bagsRow[0]?.cnt ?? 0),
          pending_transfers: Number(transferRow[0]?.cnt ?? 0),
        };
      }, { orders_pending: 0, preorders_open: 0, bags_queue: 0, pending_transfers: 0 }),

      block("today", async () => {
        const rows = await db.execute<{ size_ml: number; units: number }>(sql`
          SELECT pv.size_ml, SUM(i.quantity)::int AS units
          FROM sale_order_item i
          JOIN sale_order o ON o.id = i.sale_order_id
          JOIN product_variant pv ON pv.id = i.variant_id
          WHERE o.status IN ('paid','handed_over','delivered')
            AND o.created_at_local::date = CURRENT_DATE
          GROUP BY pv.size_ml ORDER BY pv.size_ml
        `);
        const units_by_size = rows.map((r) => ({ size_ml: Number(r.size_ml), units: Number(r.units) }));
        return { total_units: units_by_size.reduce((s, r) => s + r.units, 0), units_by_size };
      }, { total_units: 0, units_by_size: [] as Array<{ size_ml: number; units: number }> }),
    ]);

    return c.json({
      data: { stock: stockBlock, fulfilment: fulfilmentBlock, today: todayBlock },
    });
```

Delete the now-unused `monthStr/from/nextMonth/growth` code from this handler (the daily endpoint and `/pnl` own the monthly/financial math now).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run test/integration/reports-overview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/reports.ts apps/api/test/integration/reports-overview.test.ts
git commit -m "refactor: /reports/overview operational-only (factory/branch low-stock, transfers, units)"
```

---

## Task 5: Owner expense-category preference (localStorage)

**Files:**
- Create: `apps/admin/src/lib/finance-settings.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DailyExpenseCategory = "raw_materials" | "utilities" | "transport"
    | "salaries" | "rent" | "marketing" | "equipment" | "regulatory" | "other_with_note";
  export const DAILY_EXPENSE_CATEGORIES: { code: DailyExpenseCategory; label: string }[];
  export function getIncludedExpenseCategories(): DailyExpenseCategory[]; // default = all
  export function setIncludedExpenseCategories(codes: DailyExpenseCategory[]): void;
  ```
  Note: `packaging` is intentionally absent from this list (always excluded server-side).

- [ ] **Step 1: Create the module**

Create `apps/admin/src/lib/finance-settings.ts` (mirrors `receipt-settings.ts`):

```ts
/**
 * Which expense categories count toward the owner's daily-profit figure.
 * Persisted per-device in localStorage; passed to GET /reports/daily as the
 * `expense_categories` query param. The `packaging` category is deliberately
 * NOT selectable here — bottle/bag bulk purchases are counted per-unit (FIFO)
 * and are always excluded from the daily expenses line.
 */
export type DailyExpenseCategory =
  | "raw_materials" | "utilities" | "transport" | "salaries" | "rent"
  | "marketing" | "equipment" | "regulatory" | "other_with_note";

export const DAILY_EXPENSE_CATEGORIES: { code: DailyExpenseCategory; label: string }[] = [
  { code: "raw_materials", label: "Raw materials" },
  { code: "utilities", label: "Utilities" },
  { code: "transport", label: "Transport" },
  { code: "salaries", label: "Salaries" },
  { code: "rent", label: "Rent" },
  { code: "marketing", label: "Marketing" },
  { code: "equipment", label: "Equipment" },
  { code: "regulatory", label: "Regulatory" },
  { code: "other_with_note", label: "Other" },
];

const KEY = "ms_daily_expense_categories";
const ALL = DAILY_EXPENSE_CATEGORIES.map((c) => c.code);

export function getIncludedExpenseCategories(): DailyExpenseCategory[] {
  if (typeof localStorage === "undefined") return [...ALL];
  const raw = localStorage.getItem(KEY);
  if (!raw) return [...ALL];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...ALL];
    const valid = parsed.filter((v): v is DailyExpenseCategory => ALL.includes(v as DailyExpenseCategory));
    return valid.length > 0 ? valid : [...ALL];
  } catch {
    return [...ALL];
  }
}

export function setIncludedExpenseCategories(codes: DailyExpenseCategory[]): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(codes));
}
```

- [ ] **Step 2: Typecheck the admin app**

Run: `pnpm --filter @ms/admin typecheck` (or `cd apps/admin && npx tsc --noEmit`)
Expected: clean (no consumers yet; module compiles).

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/lib/finance-settings.ts
git commit -m "feat(admin): localStorage store for daily-profit expense categories"
```

---

## Task 6: Dashboard — operational face + remove month-profit; wire new overview shape

**Files:**
- Modify: `apps/admin/src/routes/owner/dashboard.tsx`

**Interfaces:**
- Consumes: new `/reports/overview` shape (Task 4); `useCan()` already imported.
- Produces: dashboard that renders the operational signals strip from the new `Overview` shape and no longer references `overview.growth` or `overview.today.net_ngn`.

This task makes the dashboard correct against the new API for **all roles** (operational strip), and removes the money-only "Month profit" stat. The owner-only financial block is added in Task 7.

- [ ] **Step 1: Update the `Overview` interface**

In `dashboard.tsx`, replace the `Overview` interface with:

```ts
interface Overview {
  stock: { low_stock_factory: number; low_stock_branch: number; expiring_48h: number };
  fulfilment: { orders_pending: number; preorders_open: number; bags_queue: number; pending_transfers: number };
  today: { total_units: number; units_by_size: Array<{ size_ml: number; units: number }> };
}
```

- [ ] **Step 2: Replace the overview stat strip**

Replace the entire `{overview && (...)}` block (the second stat grid, currently lines ~215–261 showing Low-stock SKUs / Orders pending / Today's sales / Month profit) with an operational strip. Delete the `deltaPct` import usage for that block:

```tsx
      {overview && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: 16,
            marginBottom: 26,
          }}
          className="ed-rise"
        >
          <Stat
            label="Units sold today"
            value={String(overview.today.total_units)}
            hint={overview.today.units_by_size.map((u) => `${u.size_ml}ml: ${u.units}`).join(" · ") || "No sales yet"}
          />
          <Stat
            label="Orders pending"
            value={String(overview.fulfilment.orders_pending)}
            tone={overview.fulfilment.orders_pending > 0 ? "warn" : "good"}
            hint={`${overview.fulfilment.preorders_open} preorders · ${overview.fulfilment.bags_queue} bags`}
          />
          <Stat
            label="Pending transfers"
            value={String(overview.fulfilment.pending_transfers)}
            tone={overview.fulfilment.pending_transfers > 0 ? "warn" : "good"}
            hint={overview.fulfilment.pending_transfers > 0 ? "Awaiting receipt" : "All received"}
          />
          <Stat
            label="Low stock — factory"
            value={String(overview.stock.low_stock_factory)}
            tone={overview.stock.low_stock_factory > 0 ? "bad" : "good"}
            hint={`Branch: ${overview.stock.low_stock_branch} low`}
          />
        </div>
      )}
```

- [ ] **Step 3: Remove the now-unused `deltaPct` helper if no longer referenced**

If `deltaPct` is no longer used anywhere in the file after Step 2, delete its declaration (lines ~72–76) to keep lint clean. (It was only used by the old "Today's sales" delta.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @ms/admin typecheck`
Expected: clean. No references to `overview.growth`, `overview.today.net_ngn`, or `low_stock_skus` remain.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/routes/owner/dashboard.tsx
git commit -m "refactor(admin): operational dashboard strip; drop month-profit stat"
```

---

## Task 7: Dashboard — owner-only daily financial block

**Files:**
- Modify: `apps/admin/src/routes/owner/dashboard.tsx`

**Interfaces:**
- Consumes: `GET /reports/daily` (Task 3); `finance-settings.ts` (Task 5); `can("finance.view")`.
- Produces: an owner-only financial section (revenue / packaging cost / expenses / profit + units-by-size + category checkboxes) rendered only when `can("finance.view")`.

- [ ] **Step 1: Add imports and types**

At the top of `dashboard.tsx` add:

```ts
import {
  DAILY_EXPENSE_CATEGORIES,
  getIncludedExpenseCategories,
  setIncludedExpenseCategories,
  type DailyExpenseCategory,
} from "../../lib/finance-settings.js";
```

Add an interface near the others:

```ts
interface DailyFinancials {
  date: string;
  net_revenue_ngn: number;
  packaging_cost_ngn: number;
  packaging_cost_bottles_ngn: number;
  packaging_cost_bags_ngn: number;
  expenses_ngn: number;
  daily_profit_ngn: number;
  total_units: number;
  units_by_size: Array<{ size_ml: number; units: number }>;
  caveats: string[];
}
```

- [ ] **Step 2: Add state + fetch (owner only)**

Inside `DashboardPage`, after the existing `const can = useCan();`:

```tsx
  const showFinance = can("finance.view");
  const [finDate, setFinDate] = useState(today());
  const [includedCats, setIncludedCats] = useState<DailyExpenseCategory[]>(getIncludedExpenseCategories());
  const [daily, setDaily] = useState<DailyFinancials | null>(null);

  useEffect(() => {
    if (!showFinance) return;
    let cancelled = false;
    void (async () => {
      try {
        const qs = `date=${finDate}&expense_categories=${includedCats.join(",")}`;
        const res = await api<{ data: DailyFinancials }>(`/reports/daily?${qs}`);
        if (!cancelled) setDaily(res.data);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [showFinance, finDate, includedCats]);

  function toggleCat(code: DailyExpenseCategory): void {
    setIncludedCats((prev) => {
      const next = prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code];
      setIncludedExpenseCategories(next);
      return next;
    });
  }
```

- [ ] **Step 3: Render the financial block (owner only)**

Immediately after the `<StatHero .../>` element, insert:

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
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 16,
            }}
          >
            <Stat label="Net revenue" value={ngn(daily?.net_revenue_ngn ?? 0)} tone="accent" />
            <Stat
              label="Packaging cost"
              value={ngn(daily?.packaging_cost_ngn ?? 0)}
              hint={`Bottles ${ngn(daily?.packaging_cost_bottles_ngn ?? 0)} · Bags ${ngn(daily?.packaging_cost_bags_ngn ?? 0)}`}
            />
            <Stat label="Daily expenses" value={ngn(daily?.expenses_ngn ?? 0)} />
            <Stat
              label="Daily profit"
              value={ngn(daily?.daily_profit_ngn ?? 0)}
              tone={(daily?.daily_profit_ngn ?? 0) >= 0 ? "good" : "bad"}
              hint={`${daily?.total_units ?? 0} units sold`}
            />
          </div>

          {daily && daily.units_by_size.length > 0 && (
            <div style={{ marginTop: 14, fontSize: 13, color: "var(--ink-soft)" }}>
              Cans by size: {daily.units_by_size.map((u) => `${u.size_ml}ml — ${u.units}`).join("  ·  ")}
            </div>
          )}

          {daily && daily.caveats.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--warning)" }}>
              {daily.caveats.join(" · ")}
            </div>
          )}

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

- [ ] **Step 4: Gate the money-bearing tables for non-finance roles**

The existing "Branch performance" (net/gross money) and "Recent variances" (money) sections and the revenue stat grid (`totals.net/gross/refunds`) must only show with finance. Wrap each in `{showFinance && (...)}`:
- The first stat grid (`Net revenue / Gross / Refunds / Needs review`) — split so **Needs review** stays visible to all but the three money stats are finance-only. Simplest: wrap the whole grid in `{showFinance && (...)}` and add a separate always-visible `Needs review` Stat into the operational strip from Task 6 Step 2 (add a 5th `<Stat label="Needs review" .../>` there using the existing `reviewCount`).
- Wrap the `<section className="card">…Branch performance…</section>` and its parent `l-split` partner usage so the "Top products" card may stay (quantity only). Keep it simple: wrap the whole `l-split` block and the "Recent variances" `<section>` in `{showFinance && (...)}`.

(Top products currently shows revenue; since the whole `l-split` is finance-gated, admin/manager simply won't see it — acceptable for this scope.)

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/routes/owner/dashboard.tsx
git commit -m "feat(admin): owner-only daily financials block with FIFO packaging cost"
```

---

## Task 8: Gate the bookkeeping P&L tab behind `finance.view`

**Files:**
- Modify: `apps/admin/src/routes/owner/bookkeeping.tsx`

**Interfaces:**
- Consumes: `user.capabilities` (already read via `useAuthUser()` in this file).

- [ ] **Step 1: Compute the gate**

Near the existing `const canWrite = user.capabilities.includes("expenses.write");` add:

```ts
  const canFinance = user.capabilities.includes("finance.view");
```

- [ ] **Step 2: Hide the P&L tab trigger and guard the panel**

Find the tab buttons that set `tab` to `"pnl"` and the panel rendered when `tab === "pnl"`. Render the P&L tab button only when `canFinance`. Guard the panel so a non-finance user (e.g. a manager who reaches this page) can never land on it:

```tsx
  // If finance is off and somehow on the pnl tab, fall back to expenses.
  const activeTab = !canFinance && tab === "pnl" ? "expenses" : tab;
```

Use `activeTab` in place of `tab` for deciding which panel renders, and wrap the P&L `<button>` tab trigger in `{canFinance && (...)}`.

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/routes/owner/bookkeeping.tsx
git commit -m "feat(admin): gate monthly P&L tab behind finance.view"
```

---

## Task 9: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Shared + API unit tests**

Run: `pnpm --filter @ms/shared test && cd apps/api && npx vitest run test/unit/packaging-cost.test.ts`
Expected: PASS.

- [ ] **Step 2: New + changed integration tests**

Run: `cd apps/api && npx vitest run test/integration/reports-daily.test.ts test/integration/reports-overview.test.ts`
Expected: PASS. (If a Testcontainers `beforeAll` times out under load, re-run the single file — known-flaky infra per repo notes, not a real failure.)

- [ ] **Step 3: Repo typecheck + lint**

Run: `pnpm -r typecheck && pnpm -r lint`
Expected: 0 type errors, 0 lint errors (repo baseline).

- [ ] **Step 4: Build admin (catch route/JSX breakage)**

Run: `pnpm --filter @ms/admin build`
Expected: clean build.

- [ ] **Step 5: Final commit if any lint autofixes occurred**

```bash
git add -A
git commit -m "chore: lint/typecheck cleanup for dashboard financials" || echo "nothing to commit"
```

---

## Notes for the implementer

- **PWA cache:** after deploy, existing admin sessions must hard-refresh to load the new bundle and the changed `/reports/overview` shape. The dashboard already nullish-coalesces missing fields to 0, so an old bundle hitting the new API degrades gracefully (operational strip just shows 0s until refresh).
- **Desktop app** should be resynced after this ships (per project deployment notes).
- **Do not** push or deploy unless the user asks. This branch (`feat/till-preorder-and-bulk-stock`) has unrelated WIP in the working tree — always commit with explicit pathspecs, never `git add -A` except in Task 9 Step 5 after confirming `git status` shows only this feature's files.

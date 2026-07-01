# Variance Monthly Report (Plan 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the owner a monthly variance/loss report — an admin page and a month-end Telegram summary — over the `variance_loss` data Plan 1 records (bottles + ₦ at retail).

**Architecture:** A new owner-only `GET /v1/reports/variance-losses?month=YYYY-MM` aggregates `variance_loss` for the month (totals, by-source split, per-flavour breakdown). A new admin `/owner/variance` page renders it with a month picker. A new worker cron digest (modeled on the existing monthly P&L digest) posts a month-end summary to the owner's Telegram with a link to the page.

**Tech Stack:** Hono + Drizzle API, TanStack React admin, node worker + Telegram, Vitest.

## Global Constraints

- Depends on Plan 1's `variance_loss` table (source `'transfer' | 'shift_close'`, columns `quantity`, `value_ngn`, `product_id`, `variant_id`, `size_ml`, `occurred_at`).
- Money is integer naira, formatted `₦` with `Intl.NumberFormat("en-NG")`.
- Month param is `YYYY-MM`; reject anything else with 400. Month window is `[${month}-01, nextMonth-01)` (same boundary math as `reports.ts` `/pnl`).
- The report is **owner-only**: gate the endpoint with `requireCapability("finance.view")` (owner-only by default), layered on the router's existing `reports.view`.
- Lagos timezone for the cron firing window; integration tests run `TZ=UTC`.
- The monthly digest is idempotent via the `cron_run` table (claim key + period), exactly like `pnl_monthly_digest`.

---

### Task 1: Monthly variance-loss report endpoint

**Files:**
- Modify: `apps/api/src/routes/reports.ts` (add `r.get("/variance-losses", ...)` near the existing `/variances` and `/pnl`)
- Create: `apps/api/test/integration/reports-variance-losses.test.ts`

**Interfaces:**
- Produces: `GET /v1/reports/variance-losses?month=YYYY-MM` → 
  ```jsonc
  {
    "data": {
      "month": "2026-06",
      "totals": { "bottles": 12, "value_ngn": 42000,
                  "by_source": { "transfer": { "bottles": 5, "value_ngn": 17500 },
                                 "shift_close": { "bottles": 7, "value_ngn": 24500 } } },
      "by_flavour": [
        { "product_id": "...", "name": "Ginger Spark", "size_ml": 650,
          "source": "transfer", "bottles": 5, "value_ngn": 17500 }
      ]
    }
  }
  ```

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/test/integration/reports-variance-losses.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { varianceLoss, branch, product } from "@ms/db";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

interface Totals { bottles: number; value_ngn: number; by_source: Record<string, { bottles: number; value_ngn: number }> }
interface Report { month: string; totals: Totals; by_flavour: Array<{ name: string; source: string; bottles: number; value_ngn: number }> }

describe("GET /reports/variance-losses", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  async function call<T>(path: string, cookie = cookies): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    const [br] = await db.insert(branch).values({ name: "VL Branch", code: `VL-${Date.now()}` }).returning();
    const [pr] = await db.insert(product).values({ name: "VL Sunrise", slug: `vl-${Date.now()}`, category: "regular" }).returning();
    const mk = (source: "transfer" | "shift_close", qty: number, value: number, when: string) => ({
      source, sourceId: uuid(), branchId: br!.id, productId: pr!.id, variantId: null,
      sizeMl: 650, quantity: qty, unitPriceNgn: value / qty, valueNgn: value, reason: "x",
      recordedByUserId: null, occurredAt: new Date(when),
    });
    await db.insert(varianceLoss).values([
      mk("transfer", 5, 17500, "2026-06-10T10:00:00Z"),
      mk("shift_close", 7, 24500, "2026-06-20T10:00:00Z"),
      mk("transfer", 3, 10500, "2026-05-15T10:00:00Z"), // different month — excluded
    ]);
  }, 120_000);

  afterAll(async () => { server.close(); await container.stop(); });

  it("aggregates losses for the month with by-source totals", async () => {
    const res = await call<{ data: Report }>("/v1/reports/variance-losses?month=2026-06");
    expect(res.status).toBe(200);
    expect(res.body.data.totals.bottles).toBe(12);
    expect(res.body.data.totals.value_ngn).toBe(42000);
    expect(res.body.data.totals.by_source.transfer).toEqual({ bottles: 5, value_ngn: 17500 });
    expect(res.body.data.totals.by_source.shift_close).toEqual({ bottles: 7, value_ngn: 24500 });
    expect(res.body.data.by_flavour).toHaveLength(2);
  });

  it("rejects a bad month", async () => {
    const res = await call("/v1/reports/variance-losses?month=2026");
    expect(res.status).toBe(400);
  });

  it("forbids a non-owner (manager lacks finance.view)", async () => {
    await seedUser(db, { email: "mgr-vl@example.com", role: "manager", password: "mgrpass123" });
    const mgr = await loginAs(baseUrl, "mgr-vl@example.com", "mgrpass123");
    const res = await call("/v1/reports/variance-losses?month=2026-06", mgr);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC pnpm --filter @ms/api test -- --run reports-variance-losses`
Expected: FAIL — route 404 (or passes auth but no handler).

- [ ] **Step 3: Add the endpoint**

In `apps/api/src/routes/reports.ts`, after the `/variances` handler:

```ts
  // Monthly stock-loss report (owner-only). Aggregates variance_loss for the
  // month: totals, by-source split, and a per-flavour/size breakdown.
  r.get("/variance-losses", requireCapability("finance.view"), async (c) => {
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return c.json({ error: { code: "validation_failed", message: "month must be YYYY-MM" } }, 400);
    }
    const from = `${month}-01`;
    const [yy, mm] = month.split("-").map((s) => Number(s));
    const nextMonth = mm === 12 ? `${yy! + 1}-01-01` : `${yy}-${String(mm! + 1).padStart(2, "0")}-01`;

    const rows = await db.execute<{
      product_id: string; name: string; size_ml: number | null;
      source: string; bottles: number; value_ngn: number;
    }>(sql`
      SELECT vl.product_id, p.name, vl.size_ml, vl.source,
             SUM(vl.quantity)::int AS bottles, SUM(vl.value_ngn)::int AS value_ngn
      FROM variance_loss vl
      JOIN product p ON p.id = vl.product_id
      WHERE vl.occurred_at >= ${from}::date
        AND vl.occurred_at <  ${nextMonth}::date
      GROUP BY vl.product_id, p.name, vl.size_ml, vl.source
      ORDER BY value_ngn DESC
    `);

    const bySource: Record<string, { bottles: number; value_ngn: number }> = {};
    let bottles = 0;
    let valueNgn = 0;
    for (const row of rows) {
      const b = Number(row.bottles);
      const v = Number(row.value_ngn);
      bottles += b;
      valueNgn += v;
      const acc = (bySource[row.source] ??= { bottles: 0, value_ngn: 0 });
      acc.bottles += b;
      acc.value_ngn += v;
    }

    return c.json({
      data: {
        month,
        totals: { bottles, value_ngn: valueNgn, by_source: bySource },
        by_flavour: rows.map((r) => ({
          product_id: r.product_id, name: r.name, size_ml: r.size_ml,
          source: r.source, bottles: Number(r.bottles), value_ngn: Number(r.value_ngn),
        })),
      },
    });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=UTC pnpm --filter @ms/api test -- --run reports-variance-losses`
Expected: PASS (3 cases). Then `pnpm --filter @ms/api exec tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/reports.ts apps/api/test/integration/reports-variance-losses.test.ts
git commit -m "feat(api): owner monthly variance-loss report endpoint"
```

---

### Task 2: Admin `/owner/variance` report page

**Files:**
- Create: `apps/admin/src/routes/owner/variance.tsx`
- Modify: `apps/admin/src/router.tsx` (lazyNamed import + route entry, near `AnalyticsPage`)
- Modify: `apps/admin/src/components/Shell.tsx` (owner nav link to `/owner/variance`)

**Interfaces:**
- Consumes: `GET /reports/variance-losses?month=YYYY-MM` (Task 1) via the admin `api()` client.
- Produces: `export function VarianceReportPage(): JSX.Element`.

- [ ] **Step 1: Build the page**

Create `variance.tsx` following the existing owner-page conventions (see `apps/admin/src/routes/owner/bookkeeping.tsx` for month-picker + `api()` + `humanizeError`/`toast` + DataState patterns). The page:
- holds `const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))` and an `<input type="month">`.
- fetches `api<{ data: Report }>(\`/reports/variance-losses?month=${month}\`)` on mount and when month changes.
- renders summary cards: total ₦ lost, total bottles, and ₦ by source (transfer vs shift close).
- renders a table: Flavour (name + size_ml), Source, Bottles, ₦ value — rows from `by_flavour`.
- shows an empty state when `by_flavour` is empty ("No losses recorded for {month}").

Use the same `Report` shape as Task 1 (snake_case fields: `value_ngn`, `by_source`, `by_flavour`, `size_ml`). Format money with `new Intl.NumberFormat("en-NG")` prefixed `₦` (match `pnl-digest`/admin convention).

- [ ] **Step 2: Register the route + nav**

In `router.tsx`, add near the other owner pages:
```ts
const VarianceReportPage = lazyNamed(() => import("./routes/owner/variance.js"), "VarianceReportPage");
```
and add its route entry with `path: "variance"` under the owner layout, mirroring how `AnalyticsPage` (`path: "analytics"`) is registered (copy that entry's exact wrapper/guard).

In `Shell.tsx`, add an owner nav link to `/owner/variance` labelled "Variance & losses", placed next to the existing Analytics/Bookkeeping links (copy an adjacent link's markup).

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @ms/admin exec tsc --noEmit` then `pnpm --filter @ms/admin build`
Expected: both clean.

- [ ] **Step 4: Manual check**

Run admin dev, log in as owner, open `/owner/variance`, switch months, confirm the totals/cards/table render and a month with no losses shows the empty state.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/routes/owner/variance.tsx apps/admin/src/router.tsx apps/admin/src/components/Shell.tsx
git commit -m "feat(admin): owner variance & losses monthly report page"
```

---

### Task 3: Month-end Telegram variance-loss digest

**Files:**
- Create: `apps/worker/src/jobs/variance-loss-digest.ts`
- Modify: `apps/worker/src/jobs/cron.ts` (claim + fire alongside the P&L digest)
- Create: `apps/worker/test/variance-loss-digest.test.ts`

**Interfaces:**
- Consumes: `sendMessage`, `channels` from `../notifiers/telegram.js`; `DbClient`.
- Produces: `fireMonthlyVarianceLossDigest(db: DbClient, month: string): Promise<void>` and reuses `shouldFirePnlDigestNow`'s day-1/hour>=9 window.

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/test/variance-loss-digest.test.ts
import { describe, it, expect } from "vitest";
import { formatVarianceLossDigest } from "../src/jobs/variance-loss-digest.js";

describe("formatVarianceLossDigest", () => {
  it("summarises totals and by-source split", () => {
    const text = formatVarianceLossDigest("2026-06", {
      bottles: 12, valueNgn: 42000,
      bySource: { transfer: { bottles: 5, valueNgn: 17500 }, shift_close: { bottles: 7, valueNgn: 24500 } },
      top: [{ label: "Ginger Spark 650ml", valueNgn: 17500 }],
    });
    expect(text).toContain("2026-06");
    expect(text).toContain("₦42,000");
    expect(text).toContain("Transfers");
    expect(text).toContain("Shift close");
    expect(text).toContain("Ginger Spark 650ml");
  });

  it("says clean month when nothing lost", () => {
    const text = formatVarianceLossDigest("2026-06", { bottles: 0, valueNgn: 0, bySource: {}, top: [] });
    expect(text).toContain("No stock losses");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/worker test -- --run variance-loss-digest`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the digest**

```ts
// apps/worker/src/jobs/variance-loss-digest.ts
import { sql } from "drizzle-orm";
import type { DbClient } from "@ms/db";
import { sendMessage, channels } from "../notifiers/telegram.js";

const ADMIN_URL = process.env.PUBLIC_ADMIN_URL ?? "https://admin.mrssamuel.com";

function fmt(n: number): string {
  return "₦" + new Intl.NumberFormat("en-NG").format(n);
}

export interface VarianceLossSummary {
  bottles: number;
  valueNgn: number;
  bySource: Record<string, { bottles: number; valueNgn: number }>;
  top: Array<{ label: string; valueNgn: number }>;
}

/** Pure formatter — kept separate so it is unit-testable without a DB. */
export function formatVarianceLossDigest(month: string, s: VarianceLossSummary): string {
  if (s.bottles === 0) {
    return `📦 *Monthly stock losses · ${month}*\nNo stock losses recorded. ✅`;
  }
  const transfer = s.bySource["transfer"] ?? { bottles: 0, valueNgn: 0 };
  const shift = s.bySource["shift_close"] ?? { bottles: 0, valueNgn: 0 };
  const top = s.top.map((t) => `${t.label} ${fmt(t.valueNgn)}`).join(", ");
  return (
    `📦 *Monthly stock losses · ${month}*\n` +
    `Lost:  *${fmt(s.valueNgn)}*  (${s.bottles} bottles)\n` +
    `Transfers:   ${fmt(transfer.valueNgn)} (${transfer.bottles})\n` +
    `Shift close: ${fmt(shift.valueNgn)} (${shift.bottles})\n` +
    (top ? `Top: ${top}\n` : "") +
    `👉 ${ADMIN_URL}/owner/variance`
  );
}

export async function fireMonthlyVarianceLossDigest(db: DbClient, month: string): Promise<void> {
  const from = `${month}-01`;
  const [yy, mm] = month.split("-").map((s) => Number(s));
  const nextMonth = mm === 12 ? `${yy! + 1}-01-01` : `${yy}-${String(mm! + 1).padStart(2, "0")}-01`;

  const rows = await db.execute<{ name: string; size_ml: number | null; source: string; bottles: number; value_ngn: number }>(sql`
    SELECT p.name, vl.size_ml, vl.source,
           SUM(vl.quantity)::int AS bottles, SUM(vl.value_ngn)::int AS value_ngn
    FROM variance_loss vl
    JOIN product p ON p.id = vl.product_id
    WHERE vl.occurred_at >= ${from}::date AND vl.occurred_at < ${nextMonth}::date
    GROUP BY p.name, vl.size_ml, vl.source
    ORDER BY value_ngn DESC
  `);

  const bySource: Record<string, { bottles: number; valueNgn: number }> = {};
  let bottles = 0;
  let valueNgn = 0;
  for (const r of rows) {
    const b = Number(r.bottles);
    const v = Number(r.value_ngn);
    bottles += b;
    valueNgn += v;
    const acc = (bySource[r.source] ??= { bottles: 0, valueNgn: 0 });
    acc.bottles += b;
    acc.valueNgn += v;
  }
  const top = rows.slice(0, 3).map((r) => ({
    label: `${r.name}${r.size_ml ? ` ${r.size_ml}ml` : ""}`,
    valueNgn: Number(r.value_ngn),
  }));

  const text = formatVarianceLossDigest(month, { bottles, valueNgn, bySource, top });
  const owner = channels.owner();
  if (owner) await sendMessage(owner, text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ms/worker test -- --run variance-loss-digest`
Expected: PASS (2 cases).

- [ ] **Step 5: Fire it from cron**

In `apps/worker/src/jobs/cron.ts`, import `fireMonthlyVarianceLossDigest`, and alongside the existing `pnl_monthly_digest` claim (same `prevMonthIso`, same day-1/hour>=9 window) add:
```ts
    if (await claimCronRun(db, "variance_loss_monthly_digest", prevMonthIso)) {
      await runJob(cronLogger, "variance_loss_digest", () => fireMonthlyVarianceLossDigest(db, prevMonthIso));
    }
```
Place it immediately after the P&L digest claim block so both fire in the same monthly window. (Read the surrounding lines first to copy the exact `claimCronRun`/`runJob` call shape and variable names.)

- [ ] **Step 6: Verify build + commit**

Run: `pnpm --filter @ms/worker exec tsc --noEmit`
Expected: clean.

```bash
git add apps/worker/src/jobs/variance-loss-digest.ts apps/worker/src/jobs/cron.ts apps/worker/test/variance-loss-digest.test.ts
git commit -m "feat(worker): month-end variance-loss Telegram digest"
```

---

## Self-Review

- **Spec coverage (Workstream D):** admin page → Task 2; month-end Telegram → Task 3; owner-only endpoint → Task 1 (`finance.view`). Bottles + ₦ at retail come straight from `variance_loss`. ✅
- **Placeholder scan:** Task 1 & 3 carry full code; Task 2 (UI) references concrete existing pages (`bookkeeping.tsx`, `AnalyticsPage`) to copy conventions rather than restating them — acceptable for a UI task, no logic placeholders. ✅
- **Type consistency:** endpoint response (snake_case `value_ngn`/`by_source`/`by_flavour`) consumed verbatim by Task 2; `VarianceLossSummary` (camelCase `valueNgn`) is worker-internal and used identically in the formatter test and `fireMonthlyVarianceLossDigest`. ✅
- **Idempotency:** Task 3 uses `cron_run` claim key `variance_loss_monthly_digest` (distinct from `pnl_monthly_digest`), so a restart never double-fires. ✅

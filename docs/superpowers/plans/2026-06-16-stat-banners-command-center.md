# Stat Banners + Command-Center Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every admin page a green `StatHero` banner carrying 2–4 live stat chips (the look already shipped on Products), and turn the owner Dashboard into a command center (stock alerts, orders/preorders, today-vs-yesterday, money & growth) backed by one new read endpoint.

**Architecture:** One reusable `StatHero` React component renders the existing `.juice-hero` markup; pages compute chips client-side from data they already fetch (no new API for per-page chips). The dashboard adds four `Stat` strips fed by a single new `GET /v1/reports/overview` endpoint that degrades per-block. No schema changes, no new write paths.

**Tech Stack:** React 18 + TanStack Router (`apps/admin`), Hono + Drizzle (`apps/api`), Vitest + Testcontainers (API tests), existing `index.css` design tokens.

Spec: `docs/superpowers/specs/2026-06-16-stat-banners-and-command-center-dashboard-design.md`

Branch: work continues on `feat/stat-banners-command-center` (already created, spec committed).

---

## Task 1: `StatHero` component

**Files:**
- Create: `apps/admin/src/components/StatHero.tsx`
- Test: `apps/admin/src/components/StatHero.test.tsx`

> Note: `apps/admin` currently has no component tests. Task 1 also wires up a minimal Vitest + React Testing Library setup. If the admin package already gains a test runner from a parallel effort, reuse it instead of duplicating config.

- [ ] **Step 1: Add admin test deps + config (one-time setup)**

Check whether `apps/admin/package.json` has a `test` script. If not, add dev deps and config:

Run:
```bash
cd "apps/admin" && npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom @vitejs/plugin-react
```

Create `apps/admin/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
```

Create `apps/admin/vitest.setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

Add to `apps/admin/package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing test**

`apps/admin/src/components/StatHero.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatHero } from "./StatHero.js";

describe("StatHero", () => {
  it("renders eyebrow, title, sub", () => {
    render(<StatHero eyebrow="Stock" title="Inventory" sub="On-hand stock." />);
    expect(screen.getByText("Stock")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Inventory" })).toBeInTheDocument();
    expect(screen.getByText("On-hand stock.")).toBeInTheDocument();
  });

  it("renders one chip per chip prop with label + value", () => {
    render(
      <StatHero
        eyebrow="Stock"
        title="Inventory"
        sub="x"
        chips={[
          { label: "Cans on hand", value: 120 },
          { label: "Low-stock SKUs", value: 3, tone: "danger" },
        ]}
      />,
    );
    expect(screen.getByText("Cans on hand")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    const lowChip = screen.getByText("Low-stock SKUs").closest(".hero-chip");
    expect(lowChip).toHaveClass("hero-chip--danger");
  });

  it("renders shimmer placeholders when loading", () => {
    const { container } = render(
      <StatHero eyebrow="x" title="y" sub="z" loading chips={[{ label: "A", value: 0 }]} />,
    );
    expect(container.querySelectorAll(".hero-chip.is-loading").length).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd "apps/admin" && npx vitest run src/components/StatHero.test.tsx`
Expected: FAIL — `Cannot find module './StatHero.js'`.

- [ ] **Step 4: Write the component**

`apps/admin/src/components/StatHero.tsx`:
```tsx
import type { CSSProperties } from "react";
import { getFlavourVisual } from "../lib/flavour-visuals.js";

export interface StatChip {
  label: string;
  value: string | number;
  tone?: "default" | "good" | "warn" | "danger";
}

interface StatHeroProps {
  eyebrow: string;
  title: string;
  sub: string;
  chips?: StatChip[];
  bottleSlug?: string;
  loading?: boolean;
}

export function StatHero({
  eyebrow,
  title,
  sub,
  chips,
  bottleSlug,
  loading = false,
}: StatHeroProps): JSX.Element {
  const showChips = chips && chips.length > 0;
  return (
    <section className="juice-hero ed-rise">
      <div className="juice-hero__body">
        <div className="juice-hero__eyebrow">{eyebrow}</div>
        <h1 className="juice-hero__title">{title}</h1>
        <p className="juice-hero__sub">{sub}</p>
      </div>
      {showChips ? (
        <div className="juice-hero__aside">
          {chips!.map((c) => (
            <div
              key={c.label}
              className={`hero-chip${c.tone && c.tone !== "default" ? ` hero-chip--${c.tone}` : ""}${
                loading ? " is-loading" : ""
              }`}
              style={{ ["--chip-c" as string]: chipColor(c.tone) } as CSSProperties}
            >
              <b>{loading ? "—" : c.value}</b>
              <span>{c.label}</span>
            </div>
          ))}
        </div>
      ) : bottleSlug ? (
        <img
          className="juice-hero__bottle"
          src={getFlavourVisual({ slug: bottleSlug }).bottle}
          alt=""
          aria-hidden="true"
          style={{ height: 188 }}
        />
      ) : null}
    </section>
  );
}

function chipColor(tone: StatChip["tone"]): string {
  if (tone === "danger") return "#ff6b6b";
  if (tone === "warn") return "#f6b545";
  if (tone === "good") return "#7ee0a6";
  return "#ffffff";
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd "apps/admin" && npx vitest run src/components/StatHero.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/components/StatHero.tsx apps/admin/src/components/StatHero.test.tsx apps/admin/vitest.config.ts apps/admin/vitest.setup.ts apps/admin/package.json
git commit -m "feat(admin): add reusable StatHero banner component"
```

---

## Task 2: Chip tone CSS modifier

**Files:**
- Modify: `apps/admin/src/index.css` (near the existing `.hero-chip` rule, ~line 1620)

- [ ] **Step 1: Add tone + loading styles**

Append directly after the existing `.hero-chip span { … }` rule in `index.css`:
```css
/* StatHero chip tones — value + border tint by status (--chip-c set inline). */
.hero-chip--danger { border-color: rgba(255,107,107,0.55); background: rgba(255,107,107,0.14); }
.hero-chip--warn   { border-color: rgba(246,181,69,0.55);  background: rgba(246,181,69,0.14); }
.hero-chip--good   { border-color: rgba(126,224,166,0.5);  background: rgba(126,224,166,0.13); }
.hero-chip--danger b, .hero-chip--warn b, .hero-chip--good b { color: var(--chip-c, #fff); }
.hero-chip.is-loading b { opacity: 0.4; animation: js-pulse 1.2s ease-in-out infinite; }
@keyframes js-pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 0.65; } }
```

- [ ] **Step 2: Verify build compiles**

Run: `cd "apps/admin" && npm run build`
Expected: build succeeds, no CSS errors.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/index.css
git commit -m "feat(admin): StatHero chip tone + loading styles"
```

---

## Task 3: Refactor Products onto `StatHero`

**Files:**
- Modify: `apps/admin/src/routes/owner/products.tsx:100-112`

- [ ] **Step 1: Replace the hand-rolled hero**

In `products.tsx`, add the import near the other component imports:
```tsx
import { StatHero } from "../../components/StatHero.js";
```

Replace the `<section className="juice-hero ed-rise"> … </section>` block (lines ~100-112) with:
```tsx
<StatHero
  eyebrow="Catalogue"
  title="Products"
  sub="Flavours, sizes and pricing — every bottle in the Mrs. Samuel range."
  loading={loading}
  chips={[
    { label: "Flavours", value: rows.length },
    { label: "Regular", value: rows.filter((r) => r.category === "regular").length },
    { label: "Special", value: rows.filter((r) => r.category === "special").length },
    { label: "Punch", value: rows.filter((r) => r.category === "punch").length },
  ]}
/>
```
(Use a real non-breaking space in the `sub` string, matching the original `&nbsp;`.)

- [ ] **Step 2: Verify no visual regression**

Run: `cd "apps/admin" && npm run build` then visually confirm the Products banner is unchanged (same green hero, same four chips). Expected: identical render.

- [ ] **Step 3: Typecheck**

Run: `cd "apps/admin" && npm run typecheck` (or the repo's typecheck script)
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/routes/owner/products.tsx
git commit -m "refactor(admin): Products uses StatHero (no visual change)"
```

---

## Task 4: Refactor Dashboard hero onto `StatHero`

**Files:**
- Modify: `apps/admin/src/routes/owner/dashboard.tsx:154-169`

- [ ] **Step 1: Replace the hand-rolled hero**

Add import:
```tsx
import { StatHero } from "../../components/StatHero.js";
```

Replace the `<section className="juice-hero ed-rise"> … </section>` block (lines ~154-169) with:
```tsx
<StatHero
  eyebrow="Overview"
  title="Store performance"
  sub="Revenue, orders and the things that need your attention — across every branch, poured fresh."
  bottleSlug={topProducts[0] ? slugify(topProducts[0].product_name) : "sunrise"}
/>
```

- [ ] **Step 2: Verify no visual regression + typecheck**

Run: `cd "apps/admin" && npm run build && npm run typecheck`
Expected: banner unchanged (eyebrow/title/sub + floating bottle), clean types.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/routes/owner/dashboard.tsx
git commit -m "refactor(admin): Dashboard hero uses StatHero (no visual change)"
```

---

## Task 5: `GET /v1/reports/overview` endpoint

**Files:**
- Modify: `apps/api/src/routes/reports.ts` (add handler before the closing `return r;`)
- Test: `apps/api/test/integration/reports-overview.test.ts`

**Response shape (the contract the dashboard consumes):**
```ts
interface OverviewBody {
  data: {
    stock: { low_stock_skus: number; expiring_48h: number };
    fulfilment: { orders_pending: number; preorders_open: number; bags_queue: number };
    today: { net_ngn: number; yesterday_net_ngn: number; wtd_net_ngn: number };
    growth: {
      month_revenue_ngn: number;
      month_expenses_ngn: number;
      month_profit_ngn: number;
      active_subscriptions: number;
      mrr_ngn: number;
      new_leads: number;
    };
  };
}
```

- [ ] **Step 1: Write the failing test**

`apps/api/test/integration/reports-overview.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("GET /v1/reports/overview", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 60_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("returns the full overview shape with numeric blocks on an empty DB", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/overview`, { headers: { cookie: cookies } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        stock: { low_stock_skus: number; expiring_48h: number };
        fulfilment: { orders_pending: number; preorders_open: number; bags_queue: number };
        today: { net_ngn: number; yesterday_net_ngn: number; wtd_net_ngn: number };
        growth: {
          month_revenue_ngn: number;
          month_expenses_ngn: number;
          month_profit_ngn: number;
          active_subscriptions: number;
          mrr_ngn: number;
          new_leads: number;
        };
      };
    };
    for (const v of [
      body.data.stock.low_stock_skus,
      body.data.stock.expiring_48h,
      body.data.fulfilment.orders_pending,
      body.data.fulfilment.preorders_open,
      body.data.fulfilment.bags_queue,
      body.data.today.net_ngn,
      body.data.today.yesterday_net_ngn,
      body.data.today.wtd_net_ngn,
      body.data.growth.month_revenue_ngn,
      body.data.growth.month_expenses_ngn,
      body.data.growth.month_profit_ngn,
      body.data.growth.active_subscriptions,
      body.data.growth.mrr_ngn,
      body.data.growth.new_leads,
    ]) {
      expect(typeof v).toBe("number");
    }
    // profit is revenue - expenses
    expect(body.data.growth.month_profit_ngn).toBe(
      body.data.growth.month_revenue_ngn - body.data.growth.month_expenses_ngn,
    );
  });

  it("requires auth", async () => {
    const res = await fetch(`${baseUrl}/v1/reports/overview`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "apps/api" && npx vitest run test/integration/reports-overview.test.ts`
Expected: FAIL — overview route 404s, shape assertions throw.

- [ ] **Step 3: Implement the handler**

In `apps/api/src/routes/reports.ts`, add before `return r;`. Each block is wrapped so a single failing sub-query yields zeros rather than failing the whole response. `LOW_STOCK_FLOOR` mirrors the per-flavour low threshold used in the UI (≤10 = low, per `inventory.tsx` `cellTone`).
```ts
  r.get("/overview", async (c) => {
    const LOW_STOCK_FLOOR = 10;

    async function block<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
      try {
        return await fn();
      } catch {
        return fallback;
      }
    }

    const stock = await block(
      async () => {
        const rows = await db.execute<{ low_stock_skus: number; expiring_48h: number }>(sql`
          WITH bal AS (
            SELECT location_id, product_id, variant_id, COALESCE(SUM(delta),0)::int AS balance
            FROM stock_ledger
            WHERE location_type = 'branch'
            GROUP BY location_id, product_id, variant_id
          )
          SELECT
            COUNT(*) FILTER (WHERE balance > 0 AND balance <= ${LOW_STOCK_FLOOR})::int AS low_stock_skus,
            0::int AS expiring_48h
          FROM bal
        `);
        return rows[0] ?? { low_stock_skus: 0, expiring_48h: 0 };
      },
      { low_stock_skus: 0, expiring_48h: 0 },
    );

    const fulfilment = await block(
      async () => {
        const rows = await db.execute<{
          orders_pending: number;
          preorders_open: number;
          bags_queue: number;
        }>(sql`
          SELECT
            (SELECT COUNT(*) FROM sale_order WHERE status IN ('pending','paid'))::int AS orders_pending,
            (SELECT COUNT(*) FROM preorder WHERE status IN ('open','reserved'))::int AS preorders_open,
            (SELECT COUNT(*) FROM packaging_bag WHERE status IN ('queued','assembling'))::int AS bags_queue
        `);
        return rows[0] ?? { orders_pending: 0, preorders_open: 0, bags_queue: 0 };
      },
      { orders_pending: 0, preorders_open: 0, bags_queue: 0 },
    );

    const today = await block(
      async () => {
        const rows = await db.execute<{
          net_ngn: number;
          yesterday_net_ngn: number;
          wtd_net_ngn: number;
        }>(sql`
          WITH paid AS (
            SELECT total_ngn, created_at_local::date AS d
            FROM sale_order
            WHERE status IN ('paid','handed_over','delivered')
          )
          SELECT
            COALESCE(SUM(total_ngn) FILTER (WHERE d = CURRENT_DATE), 0)::int AS net_ngn,
            COALESCE(SUM(total_ngn) FILTER (WHERE d = CURRENT_DATE - 1), 0)::int AS yesterday_net_ngn,
            COALESCE(SUM(total_ngn) FILTER (WHERE d >= date_trunc('week', CURRENT_DATE)::date), 0)::int AS wtd_net_ngn
          FROM paid
        `);
        return rows[0] ?? { net_ngn: 0, yesterday_net_ngn: 0, wtd_net_ngn: 0 };
      },
      { net_ngn: 0, yesterday_net_ngn: 0, wtd_net_ngn: 0 },
    );

    const growth = await block(
      async () => {
        const month = new Date().toISOString().slice(0, 7);
        const from = `${month}-01`;
        const [yy, mm] = month.split("-").map((s) => Number(s));
        const nextMonth =
          mm === 12 ? `${yy! + 1}-01-01` : `${yy}-${String(mm! + 1).padStart(2, "0")}-01`;
        const rows = await db.execute<{
          month_revenue_ngn: number;
          month_expenses_ngn: number;
          active_subscriptions: number;
          mrr_ngn: number;
          new_leads: number;
        }>(sql`
          SELECT
            COALESCE((SELECT SUM(total_ngn) FROM sale_order
              WHERE status IN ('paid','handed_over','delivered')
                AND created_at_local::date >= ${from}::date
                AND created_at_local::date <  ${nextMonth}::date), 0)::int AS month_revenue_ngn,
            COALESCE((SELECT SUM(amount_ngn) FROM business_expense
              WHERE deleted_at IS NULL
                AND expense_date >= ${from}::date
                AND expense_date <  ${nextMonth}::date), 0)::int AS month_expenses_ngn,
            COALESCE((SELECT COUNT(*) FROM customer_subscription WHERE status = 'active'), 0)::int AS active_subscriptions,
            COALESCE((SELECT SUM(price_ngn) FROM customer_subscription WHERE status = 'active'), 0)::int AS mrr_ngn,
            COALESCE((SELECT COUNT(*) FROM marketing_lead
              WHERE created_at::date >= ${from}::date
                AND created_at::date <  ${nextMonth}::date), 0)::int AS new_leads
        `);
        const g = rows[0] ?? {
          month_revenue_ngn: 0,
          month_expenses_ngn: 0,
          active_subscriptions: 0,
          mrr_ngn: 0,
          new_leads: 0,
        };
        return g;
      },
      {
        month_revenue_ngn: 0,
        month_expenses_ngn: 0,
        active_subscriptions: 0,
        mrr_ngn: 0,
        new_leads: 0,
      },
    );

    return c.json({
      data: {
        stock,
        fulfilment,
        today,
        growth: {
          ...growth,
          month_profit_ngn: growth.month_revenue_ngn - growth.month_expenses_ngn,
        },
      },
    });
  });
```

> **Table/column verification step (do this before running):** the SQL above references
> `preorder`, `packaging_bag`, `customer_subscription`, `marketing_lead` and columns
> `status`, `price_ngn`, `created_at`. Confirm each against `packages/db` schema. If a real
> table/column name differs, fix the SQL to match (the `block()` wrapper means a wrong name
> degrades to zeros rather than 500, but the numbers must be real). Grep:
> `cd "packages/db" && grep -rn "pgTable(" src` and match names.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "apps/api" && npx vitest run test/integration/reports-overview.test.ts`
Expected: PASS (2 tests). If a block name was wrong it still passes shape (zeros) — verify real names per Step 3 note.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/reports.ts apps/api/test/integration/reports-overview.test.ts
git commit -m "feat(api): add /reports/overview command-center endpoint"
```

---

## Task 6: Dashboard command-center strips

**Files:**
- Modify: `apps/admin/src/routes/owner/dashboard.tsx`

- [ ] **Step 1: Add the overview type + fetch**

In `dashboard.tsx`, add an interface near the other interfaces:
```tsx
interface Overview {
  stock: { low_stock_skus: number; expiring_48h: number };
  fulfilment: { orders_pending: number; preorders_open: number; bags_queue: number };
  today: { net_ngn: number; yesterday_net_ngn: number; wtd_net_ngn: number };
  growth: {
    month_revenue_ngn: number;
    month_expenses_ngn: number;
    month_profit_ngn: number;
    active_subscriptions: number;
    mrr_ngn: number;
    new_leads: number;
  };
}
```

Add state: `const [overview, setOverview] = useState<Overview | null>(null);`

Inside the existing `Promise.all` in the effect, add `api<{ data: Overview }>(\`/reports/overview\`)` as a sixth call, destructure it as `ov`, and after the other setters add `setOverview(ov.data);`. (The overview is date-independent, so it refreshing with the date range is harmless.)

- [ ] **Step 2: Render the four strips**

Immediately after the existing four-`Stat` grid (the `</div>` closing the `repeat(auto-fit,minmax(210px,1fr))` grid, ~line 191), insert:
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
      label="Low-stock SKUs"
      value={String(overview.stock.low_stock_skus)}
      tone={overview.stock.low_stock_skus > 0 ? "bad" : "good"}
      hint={overview.stock.expiring_48h > 0 ? `${overview.stock.expiring_48h} expiring ≤48h` : "Stock healthy"}
    />
    <Stat
      label="Orders pending"
      value={String(overview.fulfilment.orders_pending)}
      tone={overview.fulfilment.orders_pending > 0 ? "warn" : "good"}
      hint={`${overview.fulfilment.preorders_open} preorders · ${overview.fulfilment.bags_queue} bags`}
    />
    <Stat
      label="Today's sales"
      value={ngn(overview.today.net_ngn)}
      delta={deltaPct(overview.today.net_ngn, overview.today.yesterday_net_ngn)}
      hint={`Week so far ${ngn(overview.today.wtd_net_ngn)}`}
    />
    <Stat
      label="Month profit"
      value={ngn(overview.growth.month_profit_ngn)}
      tone={overview.growth.month_profit_ngn >= 0 ? "good" : "bad"}
      hint={`${overview.growth.active_subscriptions} subs · ${ngn(overview.growth.mrr_ngn)} MRR · ${overview.growth.new_leads} leads`}
    />
  </div>
)}
```

- [ ] **Step 3: Add the `deltaPct` helper**

Near the `nDaysAgo` helper at the top of `dashboard.tsx`:
```tsx
function deltaPct(current: number, prior: number): string | undefined {
  if (prior <= 0) return undefined;
  const pct = Math.round(((current - prior) / prior) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}
```

- [ ] **Step 4: Verify build + typecheck**

Run: `cd "apps/admin" && npm run build && npm run typecheck`
Expected: clean. Dashboard now shows the four new strips below the existing stats.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/routes/owner/dashboard.tsx
git commit -m "feat(admin): command-center strips on dashboard"
```

---

## Task 7: Page-sweep recipe + worked example (Inventory)

This task establishes the **recipe** every page-sweep task (8–N) follows, with one
page (`inventory.tsx`) implemented in full as the reference.

**Recipe (apply to each page):**
1. `import { StatHero } from "…/components/StatHero.js";` (path depth per route folder).
2. Find the page's existing header — either a hand-rolled `<section className="juice-hero …">`
   or a `<div className="page-head …">` block — and replace it with `<StatHero …/>`.
3. Pass `eyebrow`, `title`, `sub` from the existing header text.
4. Build `chips` from state the page **already** loads (the list/array it renders).
   Compute counts with `.filter(...).length`, sums with `.reduce(...)`, money via `ngn()`.
5. Set `loading={loading}` if the page has a loading flag.
6. Apply `tone: "danger" | "warn" | "good"` by threshold per the chip table.

**Files:**
- Modify: `apps/admin/src/routes/owner/inventory.tsx:463-469`

- [ ] **Step 1: Replace Inventory's `page-head` with StatHero**

Add import:
```tsx
import { StatHero } from "../../components/StatHero.js";
```

Add a memo computing the chips from already-loaded `branchStock` (cans on hand =
sum of positive balances; low-stock SKUs = distinct (product,variant) at branches with
0<balance≤10; stock value left as count of SKUs in stock since price isn't loaded here):
```tsx
const invStats = useMemo(() => {
  let cans = 0;
  let low = 0;
  let inStock = 0;
  // Aggregate branch balances per (product, variant).
  const perSku = new Map<string, number>();
  for (const r of branchStock) {
    const k = `${r.product_id}|${r.variant_id ?? "null"}`;
    perSku.set(k, (perSku.get(k) ?? 0) + r.balance);
  }
  for (const bal of perSku.values()) {
    if (bal > 0) {
      cans += bal;
      inStock += 1;
      if (bal <= 10) low += 1;
    }
  }
  return { cans, low, inStock };
}, [branchStock]);
```

Replace the `<div className="page-head ed-rise"> … </div>` block (lines ~463-469) with:
```tsx
<StatHero
  eyebrow="Stock"
  title="Inventory"
  sub="On-hand stock per can size across branches and the factory."
  loading={loading}
  chips={[
    { label: "Cans on hand", value: invStats.cans.toLocaleString() },
    { label: "SKUs in stock", value: invStats.inStock },
    { label: "Low-stock SKUs", value: invStats.low, tone: invStats.low > 0 ? "danger" : "good" },
    { label: "Branches", value: branches.length },
  ]}
/>
```

- [ ] **Step 2: Verify build + typecheck**

Run: `cd "apps/admin" && npm run build && npm run typecheck`
Expected: clean. Inventory now shows the green hero with four live chips.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/routes/owner/inventory.tsx
git commit -m "feat(admin): StatHero on Inventory (worked recipe example)"
```

---

## Tasks 8–11: Page sweep (apply the Task 7 recipe)

Each task below converts a batch of pages. For every page: follow the **Task 7 recipe**,
using the exact `eyebrow`/`title`/`sub` already on the page and the chips listed here.
Derive every chip from data the page already fetches; if a listed chip needs a number the
page does not currently load, **add it to that page's existing fetch** (note column under
the chip) rather than firing a separate request. After each batch: `npm run build &&
npm run typecheck`, then one commit per batch.

**Tone rules (consistent everywhere):** a "needs action" count (pending, overdue, low,
awaiting review, flagged, pending refund) is `danger` when > 0 else `good`; a "watch"
count (expiring soon, variance present, paused) is `warn` when > 0 else `good`; neutral
counts and money are `default`.

### Task 8: Owner list pages

| Page (`routes/owner/…`) | eyebrow / title | Chips (label → derive) |
|---|---|---|
| `orders.tsx` | Sales / Orders | Pending → status `pending`/`paid` count · Awaiting fulfilment → `paid` not handed/delivered · Delivered today → `delivered` & date=today · Refunded → `refunded`/has-return count |
| `preorders.tsx` | Sales / Preorders | Open → status open · Cans reserved → sum qty · Ready to convert → status reserved/ready · Overdue (`danger`) → due_date < today & open |
| `packaging.tsx` | Products / Packaging | Bags in queue (`warn` if >0) → status queued · Assembled today → status assembled & today · Materials low (`danger` if >0) → materials below floor *(may need a count from the materials fetch)* |
| `customers.tsx` | Sales / Customers | Total → rows.length · New this month → created_at month=now · Repeat buyers → orders_count>1 · Subscribed → has active subscription flag |
| `leads.tsx` | Marketing / Leads | New (`danger` if >0) → status new · Contacted → status contacted · Converted → status converted · This week → created_at within 7d |
| `subscriptions.tsx` | Marketing / Subscriptions | Active → status active · Paused (`warn` if >0) → status paused · MRR → sum price of active (`ngn`) · Due this week → next_charge within 7d |
| `bundles.tsx` | Products / Bundles | Active bundles → is_active · Avg discount → mean discount_pct · Items covered → sum item counts |
| `closes.tsx` | Finance / Daily closes | In range → rows.length · With variance (`warn` if >0) → variance_ngn≠0 · Net variance → sum variance (`ngn`) · Awaiting review (`danger` if >0) → status pending |
| `returns.tsx` | Sales / Returns | Pending approval (`danger` if >0) → status pending · Approved → status approved · Refunded → sum refund (`ngn`) · This month → created_at month=now |
| `transfers.tsx` (owner) | Products / Transfers | In transit → status in_transit · To receive (`warn` if >0) → status sent/pending receipt · Completed → status completed · Flagged (`danger` if >0) → has variance |
| `adjustments.tsx` | Products / Adjustments | In range → rows.length · Net delta → sum delta cans · Top reason → mode of reason_code · By you → actor=current user |
| `vendors.tsx` | Finance / Vendors | Vendors → rows.length · Active → is_active · Spend this month → sum month expenses for vendor *(reuse `/reports/pnl` or existing fetch)* |
| `factories.tsx` | Admin / Factories | Factories → rows.length · Active → is_active · Output today → sum today production *(may need count)* |
| `branches.tsx` | Admin / Branches | Branches → rows.length · Active → is_active · Devices online → sum online devices *(if already loaded)* |
| `devices.tsx` | Admin / Devices | Registered → rows.length · Online → last_seen<5m · Offline → rest · Last sync → max last_seen (relative) |
| `zones.tsx` | Admin / Delivery zones | Zones → rows.length · Active → is_active · Branches covered → distinct branch refs |
| `users.tsx` | Admin / Admin users | Users → rows.length · Owners/Admins → role counts (one chip "By role" → e.g. `2/3/1`) · Active → is_active · Pending invites → status invited |
| `audit-log.tsx` | Admin / Audit log | Events today → created_at=today · Writes → action≠read · Logins → action=login · Actors → distinct actor |
| `blog.tsx` | Marketing / Blog | Posts → rows.length · Published → status published · Drafts → status draft |
| `bookkeeping.tsx` | Finance / Bookkeeping | Revenue → pnl revenue (`ngn`) · Expenses → pnl expenses (`ngn`) · Profit → revenue−expenses (`ngn`, `good`/`bad` by sign) · Margin % → profit/revenue *(reuses existing `/reports/pnl` already on page)* |
| `review.tsx` | Overview / Needs review | Items to review (`danger` if >0) → total · Transfer variances → array length · Return approvals → array length |
| `settings.tsx` | Admin / Settings | **No chips** — `<StatHero eyebrow="Admin" title="Settings" sub="…" />` only |

- [ ] Convert all owner list pages above per the recipe.
- [ ] Run: `cd "apps/admin" && npm run build && npm run typecheck` → clean.
- [ ] Commit: `git commit -am "feat(admin): StatHero on owner list pages"`

### Task 9: Owner detail pages

Detail pages read one entity already loaded by the route. Chips describe that entity.

| Page | Chips |
|---|---|
| `product-detail.tsx` | Sizes → variants.length · Lowest price → min variant price (`ngn`) · Status → active/archived (value as text) · Category → category text |
| `order-detail.tsx` | Items → line count · Total → total_ngn (`ngn`) · Status → status text · Channel → channel text |
| `customer-detail.tsx` | Orders → order count · Lifetime → sum order totals (`ngn`) · Last order → relative date · Subscription → active/none text |
| `branch-detail.tsx` | Net (range) → branch net (`ngn`) · Orders → count · Stock value → on-hand SKUs · Devices → device count |
| `close-detail.tsx` | Expected → expected_ngn (`ngn`) · Counted → counted_ngn (`ngn`) · Variance → variance (`ngn`, `warn` if ≠0) · Status → text |
| `return-detail.tsx` | Items → line count · Refund → refund_ngn (`ngn`) · Reason → reason text · Status → text |
| `transfer-detail.tsx` (and root `transfer-detail.tsx`) | Cans → sum qty · Route → "From → To" text · Status → text · Variance → flagged (`warn` if any) |

- [ ] Convert all owner detail pages per the recipe (text-valued chips are fine — `value` accepts strings).
- [ ] Run build + typecheck → clean.
- [ ] Commit: `git commit -am "feat(admin): StatHero on owner detail pages"`

### Task 10: Branch pages

| Page (`routes/branch/…`) | Chips |
|---|---|
| `home.tsx` | Today's sales → today net (`ngn`) · Orders → today count · Cans left → branch on-hand sum · Close status → open/closed text |
| `sales.tsx` | Today → today net (`ngn`) · This week → wtd (`ngn`) · Avg ticket → net/orders (`ngn`) · Refunds → count (`danger` if >0) |
| `sale-detail.tsx` | Items → line count · Total → total (`ngn`) · Payment → method text · Status → text |
| `stock.tsx` | On hand → sum · Low (`danger` if >0) → ≤10 count · Expiring ≤48h (`warn`) → batch count *(if loaded; else omit)* · Last transfer → relative date |
| `queue.tsx` | In queue → status queued · Preparing → status preparing · Ready → status ready |
| `closes.tsx` | This month → count · With variance (`warn` if >0) → variance≠0 · Last variance → latest (`ngn`) |
| `close.tsx` | Expected → (`ngn`) · Counted → (`ngn`) · Variance → (`ngn`, `warn` if ≠0) |
| `returns.tsx` | Pending (`danger` if >0) → status pending · Approved → status approved · This month → month count |
| `return-detail.tsx` | Items → count · Refund → (`ngn`) · Status → text |
| `transfers.tsx` | Incoming → inbound count · To receive (`warn` if >0) → pending receipt · Received today → today count |
| `device.tsx` | **No chips** — title hero only |
| `sell.tsx` | **SKIP** — no banner (POS register) |

- [ ] Convert branch pages per the recipe (skip `sell.tsx`; `device.tsx` gets a no-chip hero).
- [ ] Run build + typecheck → clean.
- [ ] Commit: `git commit -am "feat(admin): StatHero on branch pages"`

### Task 11: Factory pages

| Page (`routes/factory/…`) | Chips |
|---|---|
| `inventory.tsx` | Materials → material count · Low (`danger` if >0) → below floor · Finished goods → finished count · Value → SKUs in stock |
| `production-runs.tsx` | Active runs → status active · Output today → sum today output · Planned → status planned · Yield % → produced/planned |
| `run-detail.tsx` | Planned → planned qty · Produced → produced qty · Yield % → produced/planned · Status → text |

- [ ] Convert factory pages per the recipe.
- [ ] Run build + typecheck → clean.
- [ ] Commit: `git commit -am "feat(admin): StatHero on factory pages"`

---

## Task 12: Responsive pass + quality gates

**Files:** none expected (existing `.juice-hero` media queries at `index.css:740-751` already
collapse the hero and wrap chips); only touch CSS if a banner overflows.

- [ ] **Step 1: Check chip wrap at small widths**

Build and view at 1280px, 768px, and 414px. At <768 the hero stacks (`.juice-hero__aside`
wraps); at <420 chips shrink (`min-width:70px`). Confirm no page's 4 chips overflow or
clip. If any do, add a `flex-wrap: wrap` / reduce `min-width` tweak scoped to `.juice-hero__aside`.

- [ ] **Step 2: Full quality gates**

Run:
```bash
cd "apps/admin" && npm run lint && npm run typecheck && npm run build
cd "apps/api" && npx vitest run test/integration/reports-overview.test.ts
```
Expected: 0 lint errors, clean types, admin build OK, overview test green.
(Per `reference_quality_gates`: full API suite may hit testcontainer beforeAll timeouts
under load — run the overview file alone to confirm, that is not a real failure.)

- [ ] **Step 3: Final commit**

```bash
git commit -am "chore(admin): responsive verify for StatHero rollout" --allow-empty
```

---

## Self-review notes

- **Spec coverage:** StatHero (Part 1) → Tasks 1–4; per-page chips (Part 2) → Tasks 7–11
  (every page in the spec table has a row); command center (Part 3) → Tasks 5–6;
  data/error handling → Task 5 `block()` degradation; testing → Tasks 1,5; rollout order →
  Tasks 1→12 mirror the spec's 6-step sequence.
- **POS & Settings/device** excluded exactly as the spec states (Tasks 9–10).
- **Type consistency:** `StatChip`/`StatHeroProps` defined in Task 1 are used unchanged in
  Tasks 3,4,7–11; `Overview` shape in Task 6 matches the `OverviewBody` contract and the
  SQL column names returned in Task 5.
- **Known follow-ups (acceptable):** `expiring_48h` returns 0 until batch-expiry data is
  wired to the overview query (the chip/field exist; value is a safe 0). A few Task 8/10
  chips marked *(may need count)* require widening that page's existing fetch — called out
  inline so they are not silent placeholders.

# Straws as a Packaging Material — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `straw` as a first-class packaging material — POS-consumed and tracked-only like a bag — flowing through purchase, transfer, adjust, receipts, financials, and stock, plus a till rule requiring the cashier to deliberately set both a bag and a straw count before a sale completes. Production runs are untouched.

**Architecture:** Straws reuse the existing **generic** packaging plumbing (everything keyed by `packaging_material_id`, not kind). The only backend logic that filters on kind is the POS `/sales/bags` endpoint and the P&L breakdown label; both are widened to include straws. The new till gate is UI-only in `sell.tsx`. The enum value is added in its own migration; the "Straw" material row is created by `seed.ts` (dev) and by the owner via the packaging page (prod) — never in a migration, because Postgres rejects use of a freshly-added enum value in the same transaction and **Drizzle runs all pending migrations in one transaction**.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM + Postgres, Vitest + Testcontainers (integration tests), React (admin SPA), pnpm workspaces.

## Global Constraints

- Migration number is **`0054`** (next free on `master`). Journal `when` MUST be greater than the last entry's `1782950000000` (0053) or Drizzle silently skips it — use `1782980000000`. ⚠️ The `feat/size-aware-shift-counts` WIP branch also targets `0054`; whichever lands second renumbers to `0055`.
- Never reference the `'straw'` enum value in any SQL migration (Postgres "unsafe use of new value" — all migrations share one transaction). Add the value only; create the material row outside migrations.
- Straws are **tracked-only / warn-but-allow**: branch straw stock may go negative; insufficient stock never blocks a sale. Only an *unset* selection blocks at the till.
- Straws are **never consumed by production runs** — no change to `production-runs.ts` or bottle (`bottle_material_id`) logic.
- Run quality gates from the repo root before each commit: `pnpm -w typecheck` and `pnpm -w lint` must be clean (repo baseline = 0 lint errors, clean typecheck).
- After editing any `@ms/db` schema, rebuild the package so dependents pick up types: `pnpm --filter @ms/db build`.

---

### Task 1: Add the `straw` enum value (migration + schema)

**Files:**
- Create: `packages/db/migrations/0054_straw_packaging_kind.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (append one entry)
- Modify: `packages/db/src/schema/packaging-material.ts:3-15` (enum + doc comment)
- Test: `packages/db/test/schema.test.ts` (append a case)

**Interfaces:**
- Produces: the Drizzle enum `packagingMaterialKind` now accepts `"straw"`; the Postgres type `packaging_material_kind` gains value `'straw'`. Later tasks insert `packagingMaterial` rows with `kind: "straw"`.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/test/schema.test.ts`:

```ts
import { packagingMaterialKind } from "../src/schema/packaging-material";

describe("packaging material kind", () => {
  it("includes straw as a kind", () => {
    expect(packagingMaterialKind.enumValues).toContain("straw");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/db test -- schema`
Expected: FAIL — `expected [ 'bottle', 'bag', 'other' ] to contain 'straw'`.

- [ ] **Step 3: Add `straw` to the Drizzle enum**

In `packages/db/src/schema/packaging-material.ts`, change the enum (lines 3-7) and update the doc comment to mention straws:

```ts
export const packagingMaterialKind = pgEnum("packaging_material_kind", [
  "bottle",
  "bag",
  "straw",
  "other",
]);

/**
 * Catalog of packaging materials. `kind` classifies each row: 'bottle' (sized,
 * consumed by production), 'bag' and 'straw' (unsized, consumed at the POS,
 * tracked-only), or 'other'. Seeded: 330ml/650ml glass bottles + Small/Medium/
 * Large bags (0043/0044) + Straw (seed.ts).
 *
 * `size_ml` is nullable so non-sized materials (caps, labels) coexist.
 */
```

- [ ] **Step 4: Create the migration**

Create `packages/db/migrations/0054_straw_packaging_kind.sql` with exactly one statement (no `--> statement-breakpoint`):

```sql
-- Straws become a first-class POS-consumed packaging kind (tracked-only, like
-- bags). ONLY add the enum value here. Postgres rejects using a freshly added
-- enum value inside the same transaction ("unsafe use of new value"), and
-- Drizzle runs ALL pending migrations in one transaction — so the "Straw"
-- material row is created by seed.ts (dev) and by the owner via the packaging
-- page (prod), never in a migration.
ALTER TYPE "packaging_material_kind" ADD VALUE IF NOT EXISTS 'straw';
```

- [ ] **Step 5: Register the migration in the journal**

In `packages/db/migrations/meta/_journal.json`, append after the `0053_shift_session` entry (inside the `entries` array):

```json
    ,{ "idx": 53, "version": "7", "when": 1782980000000, "tag": "0054_straw_packaging_kind", "breakpoints": true }
```

- [ ] **Step 6: Rebuild @ms/db and run the test**

Run: `pnpm --filter @ms/db build && pnpm --filter @ms/db test -- schema`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations/0054_straw_packaging_kind.sql packages/db/migrations/meta/_journal.json packages/db/src/schema/packaging-material.ts packages/db/test/schema.test.ts
git commit -m "feat(db): add 'straw' packaging material kind (migration 0054)"
```

---

### Task 2: Seed the "Straw" material

**Files:**
- Modify: `packages/db/src/seed.ts:84-95` (add `seedStrawMaterials`) and `:647-650` (call it)

**Interfaces:**
- Consumes: `packagingMaterial` table with `kind: "straw"` (Task 1).
- Produces: exactly one active `packaging_material` row named `"Straw"` (`kind='straw'`, `size_ml=null`) after `pnpm seed`, idempotently.

- [ ] **Step 1: Add the seeding function**

In `packages/db/src/seed.ts`, directly after `seedBagMaterials` (ends line 96), add:

```ts
async function seedStrawMaterials(): Promise<void> {
  const existing = await db
    .select()
    .from(packagingMaterial)
    .where(and(eq(packagingMaterial.kind, "straw"), eq(packagingMaterial.name, "Straw")));
  if (existing.length === 0) {
    await db.insert(packagingMaterial).values({
      name: "Straw", unitLabel: "straw", sizeMl: null, kind: "straw", isActive: true,
    });
  }
  console.warn("straw materials seeded");
}
```

- [ ] **Step 2: Call it during seed**

In `packages/db/src/seed.ts`, in the main seed sequence right after `await seedBagMaterials();` (line 648), add:

```ts
  await seedStrawMaterials();
```

- [ ] **Step 3: Verify against a local database**

Boot a local Postgres (see `reference_local_run`), export `DATABASE_URL`, then:

Run: `pnpm --filter @ms/db migrate && pnpm --filter @ms/db seed`
Expected: console shows `straw materials seeded`. Then:
Run: `psql "$DATABASE_URL" -c "select name, kind from packaging_material where kind='straw';"`
Expected: one row — `Straw | straw`. Run seed a second time; still exactly one row (idempotent).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/seed.ts
git commit -m "feat(db): seed a Straw packaging material"
```

---

### Task 3: API accepts `kind: "straw"` on material create/update

**Files:**
- Modify: `apps/api/src/routes/packaging.ts:23` and `:31` (both `z.enum`)
- Test: `apps/api/test/integration/packaging-straw.test.ts` (new)

**Interfaces:**
- Consumes: enum value `'straw'` (Task 1).
- Produces: `POST /v1/packaging/materials` and `PATCH /v1/packaging/materials/:id` accept `kind: "straw"`; the serialized response carries `kind: "straw"`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/packaging-straw.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import type { createDbClient } from "@ms/db";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("packaging: straw kind", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        ...(["POST", "PATCH", "PUT"].includes(method) ? { "idempotency-key": uuid() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
  }, 180_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("creates a straw material and returns kind=straw", async () => {
    const res = await call<{ data: { id: string; kind: string } }>("POST", "/v1/packaging/materials", {
      name: "Straw", unit_label: "straw", kind: "straw",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.kind).toBe("straw");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/api test -- packaging-straw`
Expected: FAIL — request rejected (zod `kind` enum has no `straw`), status 400 not 201.

- [ ] **Step 3: Widen both zod enums**

In `apps/api/src/routes/packaging.ts`, change line 23 and line 31 (identical change in `MaterialCreate` and `MaterialPatch`):

```ts
  kind: z.enum(["bottle", "bag", "straw", "other"]).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/api test -- packaging-straw`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/packaging.ts apps/api/test/integration/packaging-straw.test.ts
git commit -m "feat(api): accept straw kind on packaging material create/update"
```

---

### Task 4: POS endpoint returns straws; sales consume them

**Files:**
- Modify: `apps/api/src/routes/sales.ts:124-130` (the `/bags` handler) and its drizzle imports
- Test: `apps/api/test/integration/pos-straw.test.ts` (new)

**Interfaces:**
- Consumes: enum `'straw'` (Task 1); the generic `packaging[]` sale write path already records `sale_order_packaging` rows and debits the branch packaging ledger (no change needed there).
- Produces: `GET /v1/branches/:branchId/sales/bags` returns rows shaped `{ material_id, name, kind, balance }` for BOTH `kind='bag'` and `kind='straw'` active materials.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/pos-straw.test.ts`. It mirrors `pos-bag.test.ts` setup; the key assertions are that the endpoint surfaces a straw with its `kind`, and that a sale carrying a straw line decrements branch straw stock and may go negative:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { productVariant, stockLedger, packagingMaterial, packagingBalanceAt, type createDbClient } from "@ms/db";
import { setupTestDb, seedOwner, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("POS straw consumption", () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createDbClient>;
  let baseUrl: string;
  let cookies: string;
  let server: ReturnType<typeof serve>;
  let branch: { id: string };
  let product: { id: string };
  let straw: string;

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        ...(["POST", "PATCH", "PUT"].includes(method) ? { "idempotency-key": uuid() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : (null as T) };
  }

  const branchStraw = (): Promise<number> =>
    packagingBalanceAt(db, { locationType: "branch", locationId: branch.id }, straw);

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(tdb.db);
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    cookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");

    const bRes = await call<{ data: { id: string } }>("POST", "/v1/branches", {
      name: "Straw Branch", code: "STRW", delivery_zones: [],
    });
    branch = bRes.body.data;
    const pRes = await call<{ data: { id: string } }>("POST", "/v1/products", {
      name: "Straw Juice", slug: "straw-juice", category: "regular", ingredients: ["Mango"], initial_price_ngn: 2500,
    });
    product = pRes.body.data;
    await db.update(productVariant).set({ preorderOnly: false }).where(eq(productVariant.productId, product.id));
    await db.insert(stockLedger).values({
      locationType: "branch", locationId: branch.id, productId: product.id,
      delta: 20, sourceType: "adjustment", sourceId: uuid(), note: "seed juice",
    });

    // Create a straw material directly (no straw is seeded by migrations).
    const [s] = await db.insert(packagingMaterial)
      .values({ name: "Straw", unitLabel: "straw", sizeMl: null, kind: "straw", isActive: true })
      .returning();
    straw = s!.id;

    const today = new Date().toISOString().slice(0, 10);
    const shiftRes = await call("POST", `/v1/branches/${branch.id}/shift-open`, { business_date: today, stock_counts: [] });
    if ((shiftRes as { status: number }).status !== 201) {
      throw new Error(`shift-open failed: ${JSON.stringify(shiftRes)}`);
    }
  }, 180_000);

  afterAll(async () => {
    server.close();
    await container.stop();
  });

  it("GET /bags includes straws with their kind", async () => {
    const res = await call<{ data: Array<{ material_id: string; kind: string }> }>(
      "GET", `/v1/branches/${branch.id}/sales/bags`,
    );
    expect(res.status).toBe(200);
    const row = res.body.data.find((r) => r.material_id === straw);
    expect(row?.kind).toBe("straw");
  });

  it("a sale with a straw line decrements branch straw stock (warn-but-allow)", async () => {
    expect(await branchStraw()).toBe(0);
    const confirm = await call<{ data: { id: string } }>("POST", `/v1/branches/${branch.id}/sales`, {
      channel: "walkup",
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash",
      packaging: [{ packaging_material_id: straw, quantity: 1 }],
      created_at_local: new Date().toISOString(),
    });
    expect(confirm.status).toBe(201);
    const pay = await call("PATCH", `/v1/branches/${branch.id}/sales/${confirm.body.data.id}/pay`);
    expect(pay.status).toBe(200);
    expect(await branchStraw()).toBe(-1); // went negative — never blocked
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/api test -- pos-straw`
Expected: FAIL on the first test — the straw row is absent because the endpoint filters `kind = 'bag'` only (and no `kind` field is returned).

- [ ] **Step 3: Widen the endpoint to bags + straws**

In `apps/api/src/routes/sales.ts`, ensure `inArray` is imported from `drizzle-orm` (add it to the existing `import { and, eq, ... } from "drizzle-orm";` line). Then replace the query + response in the `/bags` handler (currently lines 124-130):

```ts
    const consumables = await db
      .select()
      .from(packagingMaterial)
      .where(and(inArray(packagingMaterial.kind, ["bag", "straw"]), eq(packagingMaterial.isActive, true)));
    return c.json({
      data: consumables.map((m) => ({
        material_id: m.id,
        name: m.name,
        kind: m.kind,
        balance: byId.get(m.id) ?? 0,
      })),
    });
```

- [ ] **Step 4: Run both straw + existing bag tests**

Run: `pnpm --filter @ms/api test -- pos-straw pos-bag`
Expected: PASS for both (the bag test still finds its bag rows; `kind` is additive).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sales.ts apps/api/test/integration/pos-straw.test.ts
git commit -m "feat(api): POS bag endpoint returns bags + straws with kind"
```

---

### Task 5: Financials label straws correctly in the P&L breakdown

**Files:**
- Modify: `apps/api/src/routes/reports.ts:482` (name query), the `kindById` derivation, and the `bagDetail` map in `packagingBreakdown` (lines 527-534)
- Test: `apps/api/test/integration/reports-straw.test.ts` (new)

**Interfaces:**
- Consumes: straw consumption recorded as `sale_order_packaging` rows (already captured generically by the day query at lines 452-467).
- Produces: each POS-consumed entry in `packagingBreakdown` carries the material's REAL `kind` (so straws show as `kind: "straw"`, not mislabeled `"bag"`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/reports-straw.test.ts`. It sells one juice with one straw, pays it, then asserts the P&L breakdown contains a `straw`-kinded line. (Mirror the setup in `pos-straw.test.ts`; only the final assertion differs.) The key request + assertion:

```ts
  it("packaging breakdown labels straws as kind=straw", async () => {
    // (after seeding branch/product/straw, opening a shift, and selling+paying
    //  one juice with packaging:[{ packaging_material_id: straw, quantity: 1 }])
    const today = new Date().toISOString().slice(0, 10);
    const res = await call<{ data: { packaging_breakdown: Array<{ kind: string; units: number }> } }>(
      "GET", `/v1/reports/daily-pl?date=${today}`,
    );
    expect(res.status).toBe(200);
    const strawLine = res.body.data.packaging_breakdown.find((b) => b.kind === "straw");
    expect(strawLine).toBeDefined();
    expect(strawLine!.units).toBe(1);
  });
```

Before writing, confirm the exact report route + response key by reading `apps/api/src/routes/reports.ts` (search for `packagingBreakdown` / `packaging_breakdown` and the route path). Use the real path/key in the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/api test -- reports-straw`
Expected: FAIL — the straw line is present but mislabeled `kind: "bag"`, so `find(b => b.kind === "straw")` is `undefined`.

- [ ] **Step 3: Select `kind` in the material-name query**

In `apps/api/src/routes/reports.ts`, change the name query (line 482) and its row type to also fetch `kind`:

```ts
    const nameRows = await db.execute<{ id: string; name: string; kind: string }>(sql`
      SELECT id, name, kind FROM packaging_material
    `);
```

Immediately after `const nameById = ...` (line 492), add:

```ts
    const kindById = new Map(nameRows.map((r) => [r.id, r.kind]));
```

- [ ] **Step 4: Use the real kind in the POS-consumed breakdown**

In the `packagingBreakdown` array, change the `bagDetail` map (lines 527-534) so `kind` comes from the material instead of the hardcoded `"bag"`:

```ts
      ...bagDetail.map((r) => ({
        material_id: r.material_id,
        name: nameById.get(r.material_id) ?? "—",
        kind: (kindById.get(r.material_id) ?? "bag") as "bag" | "straw",
        units: r.units,
        unit_cost_ngn: r.units > 0 ? Math.round(r.cost_ngn / r.units) : 0,
        cost_ngn: r.cost_ngn,
      })),
```

Leave the `bottleDetail` map (lines 519-526) unchanged — production bottles stay `kind: "bottle"`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ms/api test -- reports-straw`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/reports.ts apps/api/test/integration/reports-straw.test.ts
git commit -m "feat(api): label straws as their own kind in P&L packaging breakdown"
```

---

### Task 6: Admin packaging page surfaces straws

**Files:**
- Modify: `apps/admin/src/routes/owner/packaging.tsx` — type (`:10`), badge styles (`:57-60`), "Straws on hand" stat (`:167-203`), create-form `kind` option (`:756-759`)

**Interfaces:**
- Consumes: `/packaging/materials` and `/packaging/stock` already return `kind` for every material (straws appear once the material exists; the transfer picker also lists straws automatically because `GET /packaging/materials` returns all materials regardless of the `?kind=` param — no transfers change needed).
- Produces: the packaging UI renders a `straw` badge, a "Straws on hand" chip, and a `Straw` option in the create-material dropdown.

- [ ] **Step 1: Widen the kind type**

In `apps/admin/src/routes/owner/packaging.tsx` line 10:

```ts
type MaterialKind = "bottle" | "bag" | "straw" | "other";
```

- [ ] **Step 2: Add a straw badge style**

In the `styles` map inside `kindBadge` (lines 58-60), add a `straw` entry (amber, distinct from bag green):

```ts
    straw:  { background: "rgba(245,158,11,0.12)", color: "#b45309", border: "1px solid rgba(245,158,11,0.25)" },
```

- [ ] **Step 3: Add a "Straws on hand" stat**

After `bagsOnHand` (lines 167-169) add:

```ts
  const strawsOnHand = stock
    .filter((s) => s.kind === "straw")
    .reduce((sum, s) => sum + s.balance, 0);
```

Then add a chip in the `StatHero` `chips` array (after the "Bags on hand" chip, line 201):

```ts
          { label: "Straws on hand", value: strawsOnHand.toLocaleString() },
```

- [ ] **Step 4: Add the create-form option**

In the kind `<select>` (lines 757-759), add after the Bag option:

```tsx
              <option value="straw">Straw</option>
```

- [ ] **Step 5: Typecheck, lint, build**

Run: `pnpm -w typecheck && pnpm -w lint && pnpm --filter @ms/admin build`
Expected: all clean; build succeeds.

- [ ] **Step 6: Manual verification**

With the stack running locally (see `reference_local_run`) and the Straw material seeded: open the owner Packaging page → Materials tab shows a `straw` badge on the Straw row; the StatHero shows "Straws on hand"; the create-material form has a "Straw" kind option. Open Transfers → the packaging-line material picker lists "Straw".

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/routes/owner/packaging.tsx
git commit -m "feat(admin): show straws on the packaging page (badge, stat, create option)"
```

---

### Task 7: Till requires deliberate bag + straw counts

**Files:**
- Modify: `apps/admin/src/routes/branch/sell.tsx` — interfaces (`:23-33`), consumable state (`:137-161`), checkout payload (`:322-334`), reset + optimistic decrement (`:366-384`), bag UI block + new straw block (`:621-678`), the Charge button + hint (`:683-694`)

**Interfaces:**
- Consumes: `GET /branches/:id/sales/bags` now returns `{ material_id, name, kind, balance }` for bags and straws (Task 4); `createLocalSale` already accepts a generic `packaging[]` (`apps/admin/src/sync/local-sale.ts:27`).
- Produces: the till blocks the Charge/Take-preorder button until the cashier has explicitly *set* both a bag count and a straw count (0 allowed once set); straw lines are merged into the same `packaging[]` sent to `createLocalSale`.

This is a UI task; the repo has no React route-test harness, so it is verified by typecheck/build + manual Playwright driving. Implement it as one cohesive change, then verify.

- [ ] **Step 1: Add a `kind` field to the consumable row types**

In `apps/admin/src/routes/branch/sell.tsx`, extend both interfaces (lines 23-33) so each carries its kind:

```ts
interface BagMaterial {
  id: string;
  name: string;
  kind: "bag" | "straw";
  balance: number;
}

interface BagStockRow {
  material_id: string;
  name: string;
  kind: "bag" | "straw";
  balance: number;
}
```

- [ ] **Step 2: Split loaded consumables into bag vs straw + add straw cart + "set" flags**

Replace the bag state/loader block (lines 137-161). Keep `bagMaterials`/`bagCart`/`setBagQty`, add the straw equivalents, derive each list from the single `/bags` response by `kind`, and add `bagsSet`/`strawsSet` flags that flip true on first interaction:

```ts
  // Bags + straws are tracked-only POS consumables. The cashier MUST set a
  // count for each (0 allowed) before a sale can complete.
  const [bagMaterials, setBagMaterials] = useState<BagMaterial[]>([]);
  const [strawMaterials, setStrawMaterials] = useState<BagMaterial[]>([]);
  const [bagCart, setBagCart] = useState<Record<string, number>>({});
  const [strawCart, setStrawCart] = useState<Record<string, number>>({});
  const [bagsSet, setBagsSet] = useState(false);
  const [strawsSet, setStrawsSet] = useState(false);
  async function loadBags(): Promise<void> {
    try {
      const res = await api<{ data: BagStockRow[] }>(`/branches/${branchId}/sales/bags`);
      const rows = res.data.map((m) => ({ id: m.material_id, name: m.name, kind: m.kind, balance: m.balance }));
      setBagMaterials(rows.filter((m) => m.kind === "bag"));
      setStrawMaterials(rows.filter((m) => m.kind === "straw"));
    } catch {
      setBagMaterials([]); // offline or no access — consumable pickers stay hidden
      setStrawMaterials([]);
    }
  }
  useEffect(() => {
    void loadBags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);
  function setBagQty(id: string, qty: number): void {
    setBagsSet(true);
    setBagCart((b) => {
      const next = { ...b };
      if (qty <= 0) delete next[id];
      else next[id] = qty;
      return next;
    });
  }
  function setStrawQty(id: string, qty: number): void {
    setStrawsSet(true);
    setStrawCart((b) => {
      const next = { ...b };
      if (qty <= 0) delete next[id];
      else next[id] = qty;
      return next;
    });
  }
```

- [ ] **Step 3: Merge straw lines into the sale payload**

In `checkout()` (lines 322-334), build straw lines and merge them with bag lines into a single `packaging` array:

```ts
      const bagLines = Object.entries(bagCart).map(([packaging_material_id, quantity]) => ({
        packaging_material_id,
        quantity,
      }));
      const strawLines = Object.entries(strawCart).map(([packaging_material_id, quantity]) => ({
        packaging_material_id,
        quantity,
      }));
      const packagingLines = [...bagLines, ...strawLines];
```

Then change the spread (line 334) from `bagLines` to `packagingLines`:

```ts
        ...(packagingLines.length > 0 ? { packaging: packagingLines } : {}),
```

- [ ] **Step 4: Reset both carts/flags and decrement straws optimistically**

In the post-sale reset (after line 366 `setBagCart({});`) add:

```ts
      setStrawCart({});
      setBagsSet(false);
      setStrawsSet(false);
```

Extend the optimistic-decrement block (lines 377-384) to also update straws. Right after the existing `if (!orderIsPreorder && bagLines.length > 0) { setBagMaterials(...) }`, add the mirror:

```ts
      if (!orderIsPreorder && strawLines.length > 0) {
        setStrawMaterials((prev) =>
          prev.map((m) => {
            const sold = strawLines.find((s) => s.packaging_material_id === m.id)?.quantity ?? 0;
            return sold > 0 ? { ...m, balance: m.balance - sold } : m;
          }),
        );
      }
```

- [ ] **Step 5: Render a Straws section and a "set" affordance on both**

The existing bag block is lines 621-678. Refactor the repeated stepper list into a small inline renderer to stay DRY, OR duplicate the block for straws (match the existing style). Each section gets a **"None (0)"** button that marks the group set without adding any unit. Add this helper component above the JSX return (near other render helpers) and use it for both bags and straws:

```tsx
  function ConsumableSection(props: {
    title: string;
    emoji: string;
    materials: BagMaterial[];
    cart: Record<string, number>;
    setQty: (id: string, qty: number) => void;
    isSet: boolean;
    markNone: () => void;
  }): JSX.Element {
    const { title, emoji, materials, cart, setQty, isSet, markNone } = props;
    return (
      <div className="card card--soft" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <strong style={{ fontSize: 13 }}>{title}</strong>
          <span style={{ fontSize: 11, color: isSet ? "var(--success)" : "var(--danger)" }}>
            {isSet ? "✓ set" : "required · set a count"}
          </span>
        </div>
        {materials.map((m) => {
          const qty = cart[m.id] ?? 0;
          const remaining = m.balance - qty;
          const low = remaining <= 0;
          return (
            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                {emoji} {m.name}
                <span className="tabular-nums" style={{ marginLeft: 6, fontSize: 12, color: low ? "var(--danger)" : "var(--ink-soft)" }}>
                  {remaining} left
                </span>
              </span>
              <button type="button" className="btn btn--subtle btn--sm" style={{ width: 28, padding: 0, height: 26 }} onClick={() => setQty(m.id, qty - 1)}>−</button>
              <span className="tabular-nums" style={{ width: 22, textAlign: "center" }}>{qty}</span>
              <button type="button" className="btn btn--subtle btn--sm" style={{ width: 28, padding: 0, height: 26 }} onClick={() => setQty(m.id, qty + 1)}>+</button>
            </div>
          );
        })}
        <button type="button" className="btn btn--subtle btn--sm" onClick={markNone} disabled={isSet}>
          None (0)
        </button>
        <span className="field__hint">Counts down as you add. Not added to the total; may go below zero.</span>
      </div>
    );
  }
```

Replace the inline bag block (lines 621-678) with two sections:

```tsx
            {bagMaterials.length > 0 && (
              <ConsumableSection
                title="Bags on hand" emoji="🛍" materials={bagMaterials}
                cart={bagCart} setQty={setBagQty} isSet={bagsSet}
                markNone={() => setBagsSet(true)}
              />
            )}
            {strawMaterials.length > 0 && (
              <ConsumableSection
                title="Straws on hand" emoji="🥤" materials={strawMaterials}
                cart={strawCart} setQty={setStrawQty} isSet={strawsSet}
                markNone={() => setStrawsSet(true)}
              />
            )}
```

- [ ] **Step 6: Gate the Charge button on both being set**

Compute a guard near the other derived values, accounting for the offline case where a picker is hidden (no materials loaded → nothing to set for that group):

```ts
  const consumablesReady = (bagMaterials.length === 0 || bagsSet) && (strawMaterials.length === 0 || strawsSet);
```

Update the button `disabled` (line 686) to include it, and add an inline hint below the button when not ready:

```tsx
            <button
              type="button"
              className="btn btn--primary btn--block btn--cta"
              disabled={submitting || cart.length === 0 || checkoutDisabled || !consumablesReady}
              onClick={() => void checkout()}
            >
              {submitting ? "Recording…" : orderIsPreorder ? `Take preorder · ${ngn(total)}` : `Charge ${ngn(total)}`}
            </button>
            {!consumablesReady && cart.length > 0 && (
              <p style={{ fontSize: 11, color: "var(--danger)", textAlign: "center", margin: 0 }}>
                Set bag &amp; straw counts to continue.
              </p>
            )}
```

- [ ] **Step 7: Typecheck, lint, build**

Run: `pnpm -w typecheck && pnpm -w lint && pnpm --filter @ms/admin build`
Expected: all clean; build succeeds.

- [ ] **Step 8: Manual verification (Playwright or by hand)**

With the stack running, the Straw material seeded, and some bag + straw stock transferred to a branch: log in as branch staff, open the till, add a juice to the cart. Confirm:
1. Charge is **disabled** with the hint "Set bag & straw counts to continue." while either section reads "required".
2. Tapping **"None (0)"** on a section flips it to "✓ set" without adding units.
3. Setting both (via stepper or "None (0)") **enables** Charge.
4. A sale with 1 straw decrements the branch straw count on the till and, after sync, in the owner Packaging page; an over-sell goes negative without blocking.
5. The same gate applies in preorder mode.

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/routes/branch/sell.tsx
git commit -m "feat(pos): require deliberate bag + straw counts before a sale completes"
```

---

## Self-Review

**Spec coverage:**
- Straw = new kind, unsized, tracked-only → Task 1 (enum), Task 2 (seed). ✓
- Purchase / adjust → generic, no code change (covered by enum existing). ✓
- Transfers → no code change; `/packaging/materials` returns all materials so straws appear in the picker (Task 6 note + manual check). ✓
- POS consumption → Task 4 (endpoint) + Task 7 (till UI); sale write path already generic. ✓
- Receipts → render generically off `sale_order_packaging`; straws appear automatically. Verify during Task 7 manual check (print a receipt with a straw line). ✓
- Financials → Task 5 (real kind in breakdown); purchases/consumption already feed FIFO. ✓
- Stock visibility → Task 6 (badge + stat); `/packaging/stock` already returns all materials. ✓
- Mandatory bag + straw gate, 0 allowed but must be set → Task 7. ✓
- Production runs untouched → no task modifies production-runs.ts / bottle logic. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code. Task 5 Step 1 asks the implementer to confirm the exact report route path/key by reading `reports.ts` before finalizing the test — this is verification of an existing fact, not a placeholder for missing plan content.

**Type consistency:** `kind` is `"bag" | "straw"` on the till `BagMaterial`/`BagStockRow` (Task 7), matching the API `kind` field added in Task 4. `setBagQty`/`setStrawQty`, `bagsSet`/`strawsSet`, `bagLines`/`strawLines`/`packagingLines`, `consumablesReady`, and `ConsumableSection` props are referenced consistently across Task 7 steps. P&L breakdown `kind` widened to `"bag" | "straw"` (Task 5) while bottles stay `"bottle"`.

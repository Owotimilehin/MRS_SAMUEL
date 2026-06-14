# Workstream A2a: Location-Aware Materials Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make packaging stock location-aware (factory AND branch), classify materials by `kind` (bottle/bag/other), and seed the three bag sizes — the foundation that lets bags later move factory→branch (A2b) and be consumed at the POS (A2c).

**Architecture:** Today `packaging_stock_ledger` is keyed on `factory_id` only, so packaging can only live at a factory. A2a adds a `location_type`/`location_id` pair (reusing the existing `ledger_location_type` enum) and migrates every existing row to its factory, re-keying the non-negative-balance trigger on `(location_type, location_id, packaging_material_id)`. A `packaging_material.kind` enum classifies bottles vs bags. All current readers/writers (`packaging.ts`, `production-runs.ts`) move to the new location columns, keeping `factory_id` populated for factory rows this release for safety. No behavior change to bottle consumption — only the columns it writes. Bags can now be held and viewed per location; their movement (transfers) and consumption (POS) are A2b/A2c.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM, Postgres (hand-written SQL migrations), React + TanStack Router (admin), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-14-inventory-materials-preorders-design.md` (Workstream A — materials/bags foundation). Decisions locked 2026-06-14: bags **tracked-only, not charged**; POS bags will need **full offline support** (A2c); A2 built **phased A2a→A2b→A2c**.

**Branch:** `feat/per-size-stock`. Worktree: `C:\Users\owoti\Desktop\MRS SAMUEL FRUIT JUICE\ms-per-size-stock`. Local dev DB: `postgres://ms:ms@localhost:5432/ms_dev`.

---

## Background facts (verified on this branch)

- `packaging_material` (`packages/db/src/schema/packaging-material.ts`): `{ id, name, unitLabel, sizeMl (nullable), isActive }`. After migration 0043, the 330ml/650ml bottle rows exist and every 330/650 variant links to one.
- `packaging_stock_ledger` (`packages/db/src/schema/packaging-stock-ledger.ts`): `{ id, factoryId, packagingMaterialId, delta, sourceType ('purchase'|'consumption'|'adjustment'|'opening_balance'), sourceId, occurredAt, recordedByUserId, note }`. Balance = SUM(delta) per `(factory_id, packaging_material_id)`. A constraint trigger `packaging_ledger_balance_check` (function `packaging_ledger_check_balance()`, created in `0032_packaging.sql:38-60`) blocks a negative running balance per `(factory_id, packaging_material_id)`.
- The finished-goods `stock_ledger` already models locations with a pgEnum `ledger_location_type` = `['factory','branch']` plus `location_type`/`location_id` columns (`packages/db/src/schema/stock-ledger.ts:6,37-38`). **Reuse that same enum type** for packaging.
- Packaging ledger readers/writers are ONLY: `apps/api/src/routes/packaging.ts` (purchase write; `/stock`, `/ledger` reads — all keyed on `factory_id`) and `apps/api/src/routes/production-runs.ts` (A1's consumption write at `run.factoryId` + the pre-flight balance query).
- `apps/api/src/routes/packaging.ts`: `MaterialCreate`/`MaterialPatch` schemas + `serializeMaterial` (no `kind` today); `/stock?factory_id=` returns `{ material_id, name, unit_label, size_ml, is_active, balance, recent_unit_cost_ngn }[]`; `/purchases` POST writes a ledger row with `factoryId`.
- `apps/api/src/routes/production-runs.ts` `/complete`: consumption insert sets `factoryId: run.factoryId`; pre-flight query is `WHERE factory_id = ${run.factoryId} AND packaging_material_id = ${materialId}`.
- Admin packaging UI: `apps/admin/src/routes/owner/packaging.tsx`. Capabilities: `packaging.view`, `packaging.write`.
- Migration discipline: add a `migrations/meta/_journal.json` entry (0-based `idx`); latest migration is `0043`, so this is `0044`. Rebuild `@ms/db` after schema edits.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/db/migrations/0044_packaging_location_and_kind.sql` | Schema: kind enum+col+backfill; seed bags; ledger location cols+backfill+retrigger+index | Create |
| `packages/db/migrations/meta/_journal.json` | Migration registry | Modify (add 0044) |
| `packages/db/src/schema/packaging-material.ts` | Material schema | Add `kind` enum + column |
| `packages/db/src/schema/packaging-stock-ledger.ts` | Ledger schema | Add `locationType`/`locationId`; make `factoryId` nullable |
| `packages/db/src/lib/packaging-balance.ts` | Shared per-location balance helper | Create |
| `packages/db/src/index.ts` | db barrel | Export helper |
| `apps/api/src/routes/packaging.ts` | Packaging API | `kind` on materials; location-aware `/stock` + `/ledger`; purchase writes location cols |
| `apps/api/src/routes/production-runs.ts` | Production completion | Consumption + pre-flight use location cols (factory) |
| `apps/api/test/integration/packaging-location.test.ts` | Tests for kind + per-location balances | Create |
| `packages/db/src/seed.ts` | Dev seed | Seed 3 bag materials; set `kind` on bottle materials |
| `apps/admin/src/routes/owner/packaging.tsx` | Packaging tab | `kind` on list + create form; location selector on stock view |

---

## Task 1: Migration 0044 — kind, bag seed, location-aware ledger

**Files:**
- Create: `packages/db/migrations/0044_packaging_location_and_kind.sql`
- Modify: `packages/db/migrations/meta/_journal.json`

- [ ] **Step 1: Read the journal** to learn the entry shape (as in 0043). Latest file is `0043_backfill_bottle_materials` at the last `idx`. New entry: next `idx`, `tag` = `0044_packaging_location_and_kind`.

- [ ] **Step 2: Write the migration**

Create `packages/db/migrations/0044_packaging_location_and_kind.sql`:

```sql
-- A2a foundation: classify packaging materials by kind, seed the 3 bag sizes,
-- and make packaging_stock_ledger location-aware (factory AND branch) so bags
-- can later move factory→branch (A2b) and be consumed at a branch POS (A2c).

-- 1) packaging_material.kind
CREATE TYPE "packaging_material_kind" AS ENUM ('bottle', 'bag', 'other');

ALTER TABLE "packaging_material"
  ADD COLUMN "kind" "packaging_material_kind" NOT NULL DEFAULT 'other';

-- Existing sized materials are the bottles.
UPDATE "packaging_material" SET kind = 'bottle' WHERE size_ml IS NOT NULL;

-- 2) Seed the three bag sizes (idempotent: skip if a bag of that name exists).
INSERT INTO "packaging_material" (name, unit_label, size_ml, is_active, kind)
SELECT v.name, 'bag', NULL, true, 'bag'
FROM (VALUES ('Small Bag'), ('Medium Bag'), ('Large Bag')) AS v(name)
WHERE NOT EXISTS (
  SELECT 1 FROM "packaging_material" m WHERE m.kind = 'bag' AND m.name = v.name
);

-- 3) Location-aware packaging_stock_ledger.
--    Reuse the finished-goods location enum (factory|branch).
ALTER TABLE "packaging_stock_ledger"
  ADD COLUMN "location_type" "ledger_location_type",
  ADD COLUMN "location_id"   uuid;

-- Backfill every existing row to its factory.
UPDATE "packaging_stock_ledger"
  SET location_type = 'factory', location_id = factory_id
  WHERE location_type IS NULL;

ALTER TABLE "packaging_stock_ledger"
  ALTER COLUMN "location_type" SET NOT NULL,
  ALTER COLUMN "location_id"   SET NOT NULL;

-- factory_id is now optional (branch rows have no factory); keep it populated
-- for factory rows this release for back-compat, drop in a later cleanup.
ALTER TABLE "packaging_stock_ledger"
  ALTER COLUMN "factory_id" DROP NOT NULL;

-- 4) Re-key the non-negative balance trigger on (location_type, location_id, material).
CREATE OR REPLACE FUNCTION packaging_ledger_check_balance() RETURNS trigger AS $$
DECLARE
  current_sum integer;
BEGIN
  SELECT COALESCE(SUM(delta), 0) INTO current_sum
    FROM packaging_stock_ledger
    WHERE location_type        = NEW.location_type
      AND location_id          = NEW.location_id
      AND packaging_material_id = NEW.packaging_material_id;
  IF current_sum < 0 THEN
    RAISE EXCEPTION
      'packaging_stock_ledger negative balance: location_type=% location_id=% material_id=% sum=%',
      NEW.location_type, NEW.location_id, NEW.packaging_material_id, current_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5) Covering index for the new grouping.
CREATE INDEX IF NOT EXISTS idx_pkg_ledger_location_material
  ON packaging_stock_ledger (location_type, location_id, packaging_material_id);
```

> Note: the trigger itself (`packaging_ledger_balance_check`) created in 0032 stays attached; we only replace the FUNCTION body via `CREATE OR REPLACE`, so the existing trigger now uses the new logic. Do not drop/recreate the trigger.

- [ ] **Step 3: Add the journal entry** (next `idx`, `tag` `0044_packaging_location_and_kind`, same `version`/`when` format as neighbours — copy the 0043 entry's shape and bump).

- [ ] **Step 4: Apply against the local DB and verify**

`export DATABASE_URL=postgres://ms:ms@localhost:5432/ms_dev` then `pnpm --filter @ms/db migrate`. Expected: applies 0044. Verify in psql:
- `SELECT kind, COUNT(*) FROM packaging_material GROUP BY kind;` → `bottle` ≥ 2, `bag` = 3.
- `SELECT COUNT(*) FROM packaging_stock_ledger WHERE location_type IS NULL;` → 0.
- `SELECT location_type, COUNT(*) FROM packaging_stock_ledger GROUP BY location_type;` → all `factory` (pre-existing rows).

If the local DB is unreachable, do NOT start one — the integration testcontainer (Task 7's bootstrap) runs this migration; validate the SQL by careful read and that `_journal.json` is valid JSON. Report which path you took.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/0044_packaging_location_and_kind.sql packages/db/migrations/meta/_journal.json
git commit -m "feat(db): packaging kind + location-aware ledger + seed bags (0044)"
```

---

## Task 2: Drizzle schema — kind + location columns

**Files:**
- Modify: `packages/db/src/schema/packaging-material.ts`
- Modify: `packages/db/src/schema/packaging-stock-ledger.ts`

- [ ] **Step 1: Add the kind enum + column to the material schema**

In `packages/db/src/schema/packaging-material.ts`, add a pgEnum and the column. At the top add `pgEnum` to the `drizzle-orm/pg-core` import, then:

```ts
export const packagingMaterialKind = pgEnum("packaging_material_kind", [
  "bottle",
  "bag",
  "other",
]);
```

Add to the table columns (after `sizeMl`):

```ts
    kind: packagingMaterialKind("kind").notNull().default("other"),
```

- [ ] **Step 2: Add location columns to the ledger schema**

In `packages/db/src/schema/packaging-stock-ledger.ts`:
- Import the existing location enum: `import { ledgerLocationType } from "./stock-ledger.js";`
- Make `factoryId` nullable: remove `.notNull()` from the `factoryId` column (keep the FK).
- Add columns after `factoryId`:

```ts
    locationType: ledgerLocationType("location_type").notNull(),
    locationId: uuid("location_id").notNull(),
```

- Add a covering index in the table's index callback:

```ts
    idxLocationMaterial: index("idx_pkg_ledger_location_material").on(
      t.locationType, t.locationId, t.packagingMaterialId,
    ),
```

- [ ] **Step 3: Build @ms/db**

`pnpm --filter @ms/db build` → no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/packaging-material.ts packages/db/src/schema/packaging-stock-ledger.ts
git commit -m "feat(db): drizzle schema for packaging kind + ledger location columns"
```

---

## Task 3: Shared per-location packaging balance helper

DRY: one query used by `packaging.ts` and `production-runs.ts`.

**Files:**
- Create: `packages/db/src/lib/packaging-balance.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write the helper**

Create `packages/db/src/lib/packaging-balance.ts`:

```ts
import { eq, and, sql } from "drizzle-orm";
import type { DbExecutor } from "../client.js";
import { packagingStockLedger } from "../schema/packaging-stock-ledger.js";

export interface PackagingLocation {
  locationType: "factory" | "branch";
  locationId: string;
}

/**
 * Current balance of one material at one location (factory or branch).
 * Bottles live at factories; bags can live at either.
 */
export async function packagingBalanceAt(
  db: DbExecutor,
  loc: PackagingLocation,
  materialId: string,
): Promise<number> {
  const [row] = await db
    .select({ balance: sql<number>`COALESCE(SUM(${packagingStockLedger.delta}), 0)::int` })
    .from(packagingStockLedger)
    .where(
      and(
        eq(packagingStockLedger.locationType, loc.locationType),
        eq(packagingStockLedger.locationId, loc.locationId),
        eq(packagingStockLedger.packagingMaterialId, materialId),
      ),
    );
  return Number(row?.balance ?? 0);
}
```

> Use `DbExecutor` (the package's existing client-or-tx type, as `bottleMaterialIdForSize` does). Confirm its import path from `../client.js`.

- [ ] **Step 2: Export from the barrel**

In `packages/db/src/index.ts`: `export { packagingBalanceAt, type PackagingLocation } from "./lib/packaging-balance.js";`

- [ ] **Step 3: Build** `pnpm --filter @ms/db build` → no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/lib/packaging-balance.ts packages/db/src/index.ts
git commit -m "feat(db): add packagingBalanceAt per-location helper"
```

---

## Task 4: Packaging API — kind + location-aware reads/writes

**Files:**
- Modify: `apps/api/src/routes/packaging.ts`
- Test: `apps/api/test/integration/packaging-location.test.ts` (created in Task 7; this task’s behavior is asserted there — see ordering note)

> **Ordering note:** Tasks 4 and 7 are a TDD pair like A1's. Execute: Task 7 Steps 1–2 (write failing tests, watch fail) → Task 4 (implement) → Task 7 Steps 3+ (watch pass, commit). They share one red→green cycle and one commit.

- [ ] **Step 1: Add `kind` to material create/patch + serialization**

In `apps/api/src/routes/packaging.ts`:
- Add `kind: z.enum(["bottle", "bag", "other"]).optional()` to `MaterialCreate` and `MaterialPatch`.
- In `serializeMaterial`, add `kind: m.kind`.
- In the POST `/materials` insert values, add `kind: body.kind ?? "other"`.
- In the PATCH `/materials/:id`, add `if (body.kind !== undefined) patch.kind = body.kind;`.

- [ ] **Step 2: Make `/stock` location-aware (factory back-compat)**

Replace the `/stock` handler's factory-only query with a location-resolving one. Accept either `?factory_id=` (legacy → factory) OR `?location_type=&location_id=`:

```ts
  r.get("/stock", requireCapability("packaging.view"), async (c) => {
    const url = new URL(c.req.url);
    const factoryId = url.searchParams.get("factory_id");
    const locationType = url.searchParams.get("location_type") ?? (factoryId ? "factory" : null);
    const locationId = url.searchParams.get("location_id") ?? factoryId;
    if (!locationType || !locationId) {
      throw new BusinessError("validation_failed", "location_type+location_id (or factory_id) required", 400);
    }

    const balances = await db.execute<{ packaging_material_id: string; balance: number }>(sql`
      SELECT packaging_material_id, COALESCE(SUM(delta), 0)::int AS balance
      FROM packaging_stock_ledger
      WHERE location_type = ${locationType} AND location_id = ${locationId}::uuid
      GROUP BY packaging_material_id
    `);
    const materials = await db.select().from(packagingMaterial);
    const balanceById = new Map(balances.map((b) => [b.packaging_material_id, Number(b.balance)]));

    // recent unit cost only applies to factory purchases; keep the existing
    // query but scope it to the factory when location is a factory.
    const recentCostById = new Map<string, number>();
    if (locationType === "factory") {
      const recent = await db.execute<{ packaging_material_id: string; unit_cost_ngn: number }>(sql`
        SELECT DISTINCT ON (packaging_material_id) packaging_material_id, unit_cost_ngn
        FROM packaging_purchase
        WHERE factory_id = ${locationId}::uuid
        ORDER BY packaging_material_id, purchase_date DESC, created_at DESC
      `);
      for (const p of recent) recentCostById.set(p.packaging_material_id, Number(p.unit_cost_ngn));
    }

    const data = materials.map((m) => ({
      material_id: m.id,
      name: m.name,
      unit_label: m.unitLabel,
      size_ml: m.sizeMl,
      kind: m.kind,
      is_active: m.isActive,
      balance: balanceById.get(m.id) ?? 0,
      recent_unit_cost_ngn: recentCostById.get(m.id) ?? null,
    }));
    return c.json({ data });
  });
```

(`kind` is now in the response — the production stock card from A1 still works because it calls `?factory_id=` and filters by `size_ml != null`; it can later filter by `kind === "bottle"`.)

- [ ] **Step 3: Purchase write sets location columns**

In the `/purchases` POST transaction, the `packagingStockLedger` insert must set the new columns (purchases are into a factory):

```ts
      await tx.insert(packagingStockLedger).values({
        factoryId: body.factory_id,
        locationType: "factory",
        locationId: body.factory_id,
        packagingMaterialId: body.packaging_material_id,
        delta: body.quantity,
        sourceType: "purchase",
        sourceId: purchase.id,
        recordedByUserId: auth.userId,
        note: body.supplier_name?.trim() || null,
      });
```

- [ ] **Step 4: `/ledger` history accepts location (factory back-compat)**

Update the `/ledger` handler to filter by `location_type`/`location_id` when given, else fall back to `factory_id` (legacy). Minimal change: resolve `locationType`/`locationId` the same way as `/stock`, and change the `where` to filter on `packagingStockLedger.locationType`/`locationId` (keep `material_id` required). Include `location_type`/`location_id` in the returned rows.

- [ ] **Step 5: Implement against Task 7's failing tests, then typecheck**

`pnpm --filter @ms/api exec tsc -b` → no errors.

- [ ] **Step 6: (commit with Task 7)**

---

## Task 5: Production consumption + pre-flight use location columns

**Files:**
- Modify: `apps/api/src/routes/production-runs.ts`

- [ ] **Step 1: Consumption insert sets location columns**

In `/complete`, the per-material consumption insert (A1) must set the new columns:

```ts
      for (const [materialId, qty] of requiredByMaterial) {
        await tx.insert(packagingStockLedger).values({
          factoryId: run.factoryId,
          locationType: "factory",
          locationId: run.factoryId,
          packagingMaterialId: materialId,
          delta: -qty,
          sourceType: "consumption",
          sourceId: id,
          recordedByUserId: auth.userId,
          note: `Run ${id} consumed ${qty} bottles`,
        });
      }
```

- [ ] **Step 2: Pre-flight query uses location columns (via the helper)**

Add `import { packagingBalanceAt } from "@ms/db";` and replace the inline pre-flight balance `tx.execute` with the helper:

```ts
      const shortfalls: { material_id: string; needed: number; available: number }[] = [];
      for (const [materialId, needed] of requiredByMaterial) {
        const available = await packagingBalanceAt(
          tx,
          { locationType: "factory", locationId: run.factoryId },
          materialId,
        );
        if (available < needed) shortfalls.push({ material_id: materialId, needed, available });
      }
```

(You may drop the now-unused `sql` import from this file if nothing else uses it — check first.)

- [ ] **Step 3: Re-run the A1 production tests (no regression)**

```bash
pnpm --filter @ms/api exec vitest run test/integration/production-runs-consumption.test.ts
pnpm --filter @ms/api exec vitest run test/integration/packaging-consumption.test.ts
```
Run each file ALONE (heavy testcontainer files fail when run together — known artifact). Expected: all PASS — behavior is unchanged, only the columns written.

- [ ] **Step 4: Typecheck** `pnpm --filter @ms/api exec tsc -b` → no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/production-runs.ts
git commit -m "feat(api): production consumption + pre-flight use packaging location columns"
```

---

## Task 6: Seed parity — bag materials + kind

**Files:**
- Modify: `packages/db/src/seed.ts`

- [ ] **Step 1: Extend `seedBottleMaterials` (or add `seedBagMaterials`)**

In `packages/db/src/seed.ts`, after the existing bottle-material seeding (added in A1's `seedBottleMaterials`), set `kind: "bottle"` on the bottle inserts, and add an idempotent bag seed:

```ts
async function seedBagMaterials(): Promise<void> {
  for (const name of ["Small Bag", "Medium Bag", "Large Bag"]) {
    const existing = await db
      .select()
      .from(packagingMaterial)
      .where(and(eq(packagingMaterial.kind, "bag"), eq(packagingMaterial.name, name)));
    if (existing.length > 0) continue;
    await db.insert(packagingMaterial).values({
      name, unitLabel: "bag", sizeMl: null, kind: "bag", isActive: true,
    });
  }
}
```

Update the existing `seedBottleMaterials` insert to include `kind: "bottle"`. Add `and` to the `drizzle-orm` import if missing. Call `await seedBagMaterials();` right after `seedBottleMaterials()` in the run sequence.

- [ ] **Step 2: Verify (local DB if reachable)**

`DATABASE_URL=postgres://ms:ms@localhost:5432/ms_dev pnpm --filter @ms/db seed` → completes; `SELECT kind, COUNT(*) FROM packaging_material GROUP BY kind;` shows bag=3, bottle≥2. Idempotent on re-run. If no DB, typecheck only: `pnpm --filter @ms/db exec tsc -b`.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/seed.ts
git commit -m "feat(db): seed bag materials + kind on bottle materials"
```

---

## Task 7: Integration tests — kind + per-location balances (TDD pair with Task 4)

**Files:**
- Create: `apps/api/test/integration/packaging-location.test.ts`

> Copy setup helpers from `apps/api/test/integration/packaging-purchases.test.ts` and `packaging-consumption.test.ts` (authed request, create factory, record purchase). Read them first.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/packaging-location.test.ts`:

```ts
// Materials list exposes kind, and the 3 seeded bags are present as kind 'bag'.
it("lists materials with kind and includes the seeded bags", async () => {
  // GET /v1/packaging/materials → expect ≥3 rows with kind === "bag"
  // and the bottle materials with kind === "bottle".
});

// A factory purchase shows under that factory's location stock; a different
// branch shows zero for the same material.
it("reports packaging balance per location", async () => {
  // create factory F; record a purchase of 50 of a bag material at F.
  // GET /v1/packaging/stock?factory_id=F → that material balance === 50, kind 'bag'.
  // GET /v1/packaging/stock?location_type=branch&location_id=<some branch id>
  //   → same material balance === 0.
});

// Creating a material with kind 'bag' round-trips.
it("creates a material with an explicit kind", async () => {
  // POST /v1/packaging/materials { name, unit_label:'bag', kind:'bag' }
  // → 201; GET materials shows it with kind 'bag'.
});
```

Fill bodies using the copied helpers. For the branch-location assertion, use any existing branch id from the seeded/test data (or create a branch via the test helper if one exists; otherwise assert the factory-vs-a-random-uuid-location difference).

- [ ] **Step 2: Run, confirm FAIL**

`pnpm --filter @ms/api exec vitest run test/integration/packaging-location.test.ts`
Expected: FAIL (`kind` missing from responses; location_type param unsupported).

- [ ] **Step 3: Implement Tasks 4** (above), then re-run → all PASS.

- [ ] **Step 4: Regression** — run `packaging-purchases.test.ts` alone; expected PASS (purchase still works; response may now include `kind`/location — update assertions only if they over-specified the shape).

- [ ] **Step 5: Commit Tasks 4 + 7 together**

```bash
git add apps/api/src/routes/packaging.ts apps/api/test/integration/packaging-location.test.ts
git commit -m "feat(api): packaging kind + location-aware stock/ledger reads"
```

---

## Task 8: Admin packaging tab — kind + per-location stock view

**Files:**
- Modify: `apps/admin/src/routes/owner/packaging.tsx`

- [ ] **Step 1: Read the page** to learn its data loading (how it fetches `/packaging/materials`, `/packaging/stock?factory_id=`), state, and the existing table/card classes + any factory selector. Match existing styling primitives; do not invent classes.

- [ ] **Step 2: Show `kind` on the materials list** — add a column/badge rendering the material's `kind` (the API now returns it). Use the file's existing table cell/badge pattern.

- [ ] **Step 3: Add `kind` to the create-material form** — a select with `bottle` / `bag` / `other` (default `other`), sent as `kind` in the POST body. Match the form's existing field markup.

- [ ] **Step 4: Add a location selector to the stock view** — a dropdown listing the factory (default) and each branch (fetch `/factories` and `/branches` the way other admin pages do — check an existing page like `owner/inventory.tsx` for the pattern). On change, call `/packaging/stock?location_type=<factory|branch>&location_id=<id>` and render the per-location balances (showing `kind`). Keep the existing factory view as the default selection.

- [ ] **Step 5: Typecheck + lint**

`pnpm typecheck` (full repo) → exit 0. `pnpm lint` → 0 errors (pre-existing warnings ok).

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/routes/owner/packaging.tsx
git commit -m "feat(admin): packaging tab shows kind + per-location stock"
```

---

## Final verification

- [ ] **Step 1:** `pnpm lint && pnpm typecheck` → 0 errors.
- [ ] **Step 2:** Run the touched API test files INDIVIDUALLY (heavy testcontainer files fail together — known artifact):
```bash
pnpm --filter @ms/api exec vitest run test/integration/packaging-location.test.ts
pnpm --filter @ms/api exec vitest run test/integration/packaging-purchases.test.ts
pnpm --filter @ms/api exec vitest run test/integration/packaging-consumption.test.ts
pnpm --filter @ms/api exec vitest run test/integration/production-runs-consumption.test.ts
```
All PASS.
- [ ] **Step 3: Manual smoke** — on a seeded local stack: the Packaging tab lists bottles (kind bottle) and the 3 bags (kind bag); record a bag purchase at the factory; the stock view shows it; switch the location selector to a branch → that bag shows 0 there. Production page bottle card still works.

---

## Self-Review Notes (for the author)

- **Spec coverage (A2a portion):** `packaging_material.kind` → Tasks 1,2; seed 3 bags → Tasks 1,6; location-aware ledger (factory|branch) + migrated rows + re-keyed trigger → Task 1; readers/writers moved to location cols → Tasks 4,5; packaging tab kind + per-location view → Task 8. POS bag consumption (A2c) and transfer bag lines (A2b) are intentionally NOT here.
- **No bottle behavior change:** Task 5 only changes which columns the A1 consumption writes; the guard, aggregation, and tests are unchanged and must stay green.
- **Back-compat:** `factory_id` kept (now nullable) and still populated for factory rows; `/stock` and `/ledger` still accept `?factory_id=`. Drop `factory_id` in a later cleanup once nothing reads it.
- **Type consistency:** `packagingBalanceAt(db, {locationType, locationId}, materialId)` (Task 3) used identically in Task 5. `packagingMaterialKind` enum values `bottle|bag|other` consistent across schema, API, seed, UI.
- **Deferred to A2c:** the `kind='bottle'` filter + partial unique index on bottle `size_ml` (the A1 final-review minor #1) — fold in when POS bag work touches material lookup, or as a small follow-up.

# Workstream A1: Bottle-Consumption Integrity + Production Stock Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bottles actually reduce when a production run completes, hard-block a run that lacks enough bottles, and show a per-size bottle stock card on the production page.

**Architecture:** The root cause of "my bottle did not reduce" is that no `packaging_material` bottle rows are seeded and no `product_variant.bottle_material_id` is set, so the completion route's consumption loop hits `if (!variant?.bottleMaterialId) continue;` and silently skips every item. Fix in three layers: (1) a data migration that ensures the two bottle materials exist and backfills every variant's `bottle_material_id` by size; (2) auto-link new variants to their bottle material on product create so the gap never reopens; (3) replace the silent skip in `/complete` with a pre-flight hard guard that blocks the whole run with a precise shortfall message before posting any ledger rows, and requires every line to have a size (variant). Then add a read-only production stock card from data already exposed by `/packaging/stock`.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM, Postgres (hand-written SQL migrations), React + TanStack Router (admin), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-14-inventory-materials-preorders-design.md` (Workstream A — the bottle-consumption + stock-card portions). Bags / location-aware ledger / POS are deliberately deferred to plan A2.

**Branch:** Work on `feat/per-size-stock` (current). Worktree: `ms-per-size-stock`.

---

## Background facts (verified in the code on this branch)

- `packaging_material` (schema `packages/db/src/schema/packaging-material.ts`): `{ id, name, unitLabel, sizeMl (nullable), isActive }`. Migration `0032_packaging.sql` creates the table but inserts NO rows. The seed (`packages/db/src/seed.ts`) does NOT create bottle materials.
- `product_variant.bottleMaterialId` (nullable FK to packaging_material) exists (`packages/db/src/schema/product-variant.ts:23`) but is never set by the seed or by product create (`apps/api/src/routes/products.ts:239-248` inserts a variant with only `productId, sizeMl, sku`).
- `packaging_stock_ledger` is factory-keyed: `{ factoryId, packagingMaterialId, delta, sourceType ('purchase'|'consumption'|'adjustment'|'opening_balance'), sourceId, ... }`. An AFTER-INSERT trigger blocks a negative running balance per `(factory_id, packaging_material_id)`.
- `/complete` route: `apps/api/src/routes/production-runs.ts:107-217`. The consumption loop is lines 146-163; the outer try/catch reshaping the trigger error to a 422 is lines 182-205.
- `/packaging/stock?factory_id=<uuid>` (`apps/api/src/routes/packaging.ts:115-159`) returns `{ material_id, name, unit_label, size_ml, is_active, balance, recent_unit_cost_ngn }[]` — exactly what the stock card needs (bottles are the sized materials).
- Admin production page: `apps/admin/src/routes/factory/production-runs.tsx`, component `ProductionRunsPage` (line 29). Holds `factoryId` + `runDate` state; loads factories/products in a `useEffect` (line 63); loads the open draft (line 95) and history (line 112) keyed on `factoryId`. Uses the `api<T>()` wrapper from `apps/admin/src/lib/api.ts`.
- Capabilities (in `packages/shared/src/permissions.ts`): `production.manage`, `packaging.view`, `packaging.write`. The production route already gates on `production.manage`.
- Migrations require a `migrations/meta/_journal.json` entry or migrate skips them (see project memory `reference_migration_journal`). After schema edits, rebuild `@ms/db`.
- Latest migration is `0042_revert_per_flavour_floor.sql`. New migrations here: `0043`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/db/migrations/0043_backfill_bottle_materials.sql` | Ensure 330/650 bottle materials exist; backfill `variant.bottle_material_id` by size | Create |
| `packages/db/migrations/meta/_journal.json` | Migration registry | Modify (add 0043 entry) |
| `packages/db/src/seed.ts` | Dev seed | Add bottle materials + link seeded variants by size |
| `packages/db/src/lib/bottle-material.ts` | Shared helper: find bottle material id for a size at the DB | Create |
| `packages/db/src/index.ts` | db barrel | Export helper |
| `apps/api/src/routes/products.ts` | Product/variant create | Auto-link new variant to its bottle material by size |
| `apps/api/src/routes/production-runs.ts` | Production completion | Pre-flight hard guard; require variant on every line; no silent skip |
| `apps/api/test/integration/production-runs-consumption.test.ts` | Integration tests for consumption + guard | Create |
| `apps/admin/src/routes/factory/production-runs.tsx` | Production page | Add per-size bottle stock card |

---

## Task 1: Migration — ensure bottle materials exist and backfill variant links

**Files:**
- Create: `packages/db/migrations/0043_backfill_bottle_materials.sql`
- Modify: `packages/db/migrations/meta/_journal.json`

- [ ] **Step 1: Read the journal to learn the exact entry shape**

Read `packages/db/migrations/meta/_journal.json`. Note the structure of the last entry (the `idx`, `version`, `when`, `tag` fields) so your new entry matches it exactly. The `tag` must be `0043_backfill_bottle_materials` and `idx` one higher than the last.

- [ ] **Step 2: Write the migration**

Create `packages/db/migrations/0043_backfill_bottle_materials.sql`:

```sql
-- Bottles never reduced on production because no bottle materials existed and
-- no variant was linked to one (product_variant.bottle_material_id was always
-- NULL → the /complete consumption loop skipped every item). This migration is
-- idempotent: it ensures the two bottle materials exist, then links every
-- variant to the material matching its size.

-- 1) Ensure the 330ml and 650ml glass bottle materials exist (match by size_ml
--    so a manually-created row is reused rather than duplicated).
INSERT INTO packaging_material (name, unit_label, size_ml, is_active)
SELECT '330ml Glass Bottle', 'bottle', 330, true
WHERE NOT EXISTS (
  SELECT 1 FROM packaging_material WHERE size_ml = 330
);

INSERT INTO packaging_material (name, unit_label, size_ml, is_active)
SELECT '650ml Glass Bottle', 'bottle', 650, true
WHERE NOT EXISTS (
  SELECT 1 FROM packaging_material WHERE size_ml = 650
);

-- 2) Backfill: link each variant with no bottle yet to the bottle material whose
--    size_ml matches the variant's size. Picks the lowest id if (somehow) there
--    are duplicate materials for a size, so the result is deterministic.
UPDATE product_variant pv
SET bottle_material_id = m.id
FROM (
  SELECT DISTINCT ON (size_ml) id, size_ml
  FROM packaging_material
  WHERE size_ml IS NOT NULL
  ORDER BY size_ml, id
) m
WHERE pv.bottle_material_id IS NULL
  AND pv.size_ml = m.size_ml;
```

- [ ] **Step 3: Add the journal entry**

Edit `packages/db/migrations/meta/_journal.json`: append an entry matching the existing shape, e.g. (adapt `idx`/`when` to the real values you saw in Step 1):

```json
{ "idx": 43, "version": "7", "when": <use same format as prior entries>, "tag": "0043_backfill_bottle_materials", "breakpoints": true }
```

Use the same `version` and field set as the neighbouring entries; copy their format exactly. For `when`, use the current epoch-ms integer in the same form the other entries use.

- [ ] **Step 4: Apply migrations against a local/test DB and verify**

If a local stack is available (see project memory `reference_local_run`), export the local `DATABASE_URL` and run:
`pnpm --filter @ms/db migrate`
Expected: applies `0043` with no error. Then verify in psql:
`SELECT size_ml, COUNT(*) FROM packaging_material WHERE size_ml IN (330,650) GROUP BY size_ml;` → one row each.
`SELECT COUNT(*) FROM product_variant WHERE bottle_material_id IS NULL AND size_ml IN (330,650);` → 0.

If no local DB is available, instead confirm the SQL parses by reading it carefully and proceed — Task 6's integration tests run migrations against a testcontainer and will catch a broken migration.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/0043_backfill_bottle_materials.sql packages/db/migrations/meta/_journal.json
git commit -m "feat(db): ensure bottle materials exist + backfill variant links (0043)"
```

---

## Task 2: Shared helper to resolve a size's bottle material

A single query used by both product-create (Task 3) and the seed (Task 5) so the size→material lookup lives in one place.

**Files:**
- Create: `packages/db/src/lib/bottle-material.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write the helper**

Create `packages/db/src/lib/bottle-material.ts`:

```ts
import { eq, isNotNull, and, asc } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { packagingMaterial } from "../schema/packaging-material.js";

/**
 * Returns the packaging_material id for the bottle of a given size, or null if
 * none exists. Bottles are the sized materials; matches on size_ml, lowest id
 * wins if duplicates exist. Accepts a transaction or the base client.
 */
export async function bottleMaterialIdForSize(
  db: Pick<DbClient, "select">,
  sizeMl: number,
): Promise<string | null> {
  const rows = await db
    .select({ id: packagingMaterial.id })
    .from(packagingMaterial)
    .where(and(eq(packagingMaterial.sizeMl, sizeMl), isNotNull(packagingMaterial.sizeMl)))
    .orderBy(asc(packagingMaterial.id))
    .limit(1);
  return rows[0]?.id ?? null;
}
```

> Note: confirm the import path for `DbClient` — read `packages/db/src/client.ts` and `index.ts` to see how the type is named/exported and match it. If `DbClient` is exported from `index.ts` rather than `client.js`, import from the correct relative path. The `Pick<…, "select">` keeps it usable with a Drizzle transaction object too; if the transaction type doesn't structurally match, widen the param type to the project's transaction type or `any`-free equivalent used elsewhere (check how other `packages/db/src/lib` or domain helpers type a tx).

- [ ] **Step 2: Export from the barrel**

In `packages/db/src/index.ts`, add (matching existing export style):

```ts
export { bottleMaterialIdForSize } from "./lib/bottle-material.js";
```

- [ ] **Step 3: Build @ms/db so dependents see the export**

Run: `pnpm --filter @ms/db build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/lib/bottle-material.ts packages/db/src/index.ts
git commit -m "feat(db): add bottleMaterialIdForSize helper"
```

---

## Task 3: Auto-link new variants to their bottle material on product create

So the bug can't reopen: every variant created from now on gets `bottleMaterialId` set when a matching bottle material exists.

**Files:**
- Modify: `apps/api/src/routes/products.ts` (variant insert in the create transaction, around `:239-248`)
- Test: `apps/api/test/integration/products.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/integration/products.test.ts` (reuse the file's existing authenticated request helper — mirror the existing "creates a product" test). The test creates a product with a 330ml variant and asserts the created variant is linked to the 330ml bottle material. Because the bottle material must exist, first ensure it (the integration bootstrap runs all migrations incl. 0043, so 330/650 materials exist):

```ts
it("links a new variant to the bottle material matching its size", async () => {
  const create = await call("POST", "/v1/products", {
    name: "Linktest Juice",
    slug: "linktest-juice",
    category: "regular",
    variants: [{ size_ml: 330, price_ngn: 2500 }],
  });
  expect(create.status).toBe(201);
  const { data } = await create.json();
  // fetch the variant row back via the product detail endpoint
  const detail = await call("GET", `/v1/products/${data.id}`);
  const body = await detail.json();
  const v = body.data.variants.find((x: { size_ml: number }) => x.size_ml === 330);
  expect(v).toBeTruthy();
  // The detail endpoint must expose bottle_material_id (see Step 3 note).
  expect(v.bottle_material_id).toBeTruthy();
});
```

> If the product detail endpoint (`GET /v1/products/:id`, in `loadVariantsForProduct`) does not currently return `bottle_material_id` on each variant, add it to the variant projection there (it selects from `product_variant` already — include `bottleMaterialId` and map it to `bottle_material_id` in the returned object). This is a small, in-scope read addition needed to verify the link.

- [ ] **Step 2: Run it, confirm it FAILS**

Run: `pnpm --filter @ms/api exec vitest run test/integration/products.test.ts -t "links a new variant"`
Expected: FAIL (`bottle_material_id` is null/undefined — not set on insert, and possibly not returned).

- [ ] **Step 3: Implement the auto-link + expose the field**

In `apps/api/src/routes/products.ts`:
- Add import: `import { bottleMaterialIdForSize } from "@ms/db";`
- In the create transaction, change the variant insert (`:241-248`) to resolve and set the bottle material:

```ts
        const bottleMaterialId = await bottleMaterialIdForSize(tx, v.size_ml);
        const [vRow] = await tx
          .insert(productVariant)
          .values({
            productId: row.id,
            sizeMl: v.size_ml,
            sku,
            bottleMaterialId: bottleMaterialId ?? null,
          })
          .returning();
```

- In `loadVariantsForProduct` (the function that builds the variant projection for `GET /:id`), include `bottle_material_id`. Find where each variant object is assembled and add `bottle_material_id: v.bottleMaterialId ?? null` (the select already reads the full `product_variant` row, or add `bottleMaterialId` to the selected columns if it's a narrowed select).

- [ ] **Step 4: Run the test, confirm it PASSES**

Run: `pnpm --filter @ms/api exec vitest run test/integration/products.test.ts -t "links a new variant"`
Expected: PASS.

- [ ] **Step 5: Run the whole products test file (no regression)**

Run: `pnpm --filter @ms/api exec vitest run test/integration/products.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/products.ts apps/api/test/integration/products.test.ts
git commit -m "feat(api): auto-link new variants to their bottle material by size"
```

---

## Task 4: Pre-flight hard guard on production completion (no silent skip)

The core fix. Before posting any ledger rows, require every line to have a size (variant), compute bottles required per material, check the factory has enough, and block the whole run with a precise shortfall message if not. Keep the existing trigger reshaping as a backstop.

**Files:**
- Modify: `apps/api/src/routes/production-runs.ts` (`/complete`, `:107-217`)
- Test: `apps/api/test/integration/production-runs-consumption.test.ts` (Task 6 writes these; this task makes them pass — write the implementation here, tests in Task 6 reference it. To keep TDD, Task 6 is ordered to write tests first; if executing strictly, do Task 6 Step 1-2 before this task's implementation. See note.)

> **Ordering note for the executor:** This task and Task 6 are a TDD pair. Execute in this order: Task 6 Steps 1–2 (write the failing consumption/guard tests and watch them fail), then Task 4 (implement), then Task 6 Steps 3+ (watch them pass, add edge tests, commit). The plan keeps them as separate tasks for clarity, but they share one red→green cycle.

- [ ] **Step 1: Replace the consumption loop with a require-variant + pre-flight guard**

In `apps/api/src/routes/production-runs.ts`, inside the `db.transaction` in `/complete`, AFTER loading `items` and the empty-check (`:119-125`) and BEFORE the `stockLedger` insert loop (`:127`), insert:

```ts
      // Every line must have a size (variant) so the bottle material is known.
      const missingSize = items.filter((it) => !it.variantId);
      if (missingSize.length > 0) {
        throw new BusinessError(
          "validation_failed",
          "every flavour line needs a size before completing — set a size on each line",
          422,
          { reason: "missing_variant" },
        );
      }

      // Resolve each line's variant + bottle material, then aggregate required
      // bottles per material.
      const variantIds = [...new Set(items.map((it) => it.variantId!))];
      const variants = await tx
        .select()
        .from(productVariant)
        .where(inArray(productVariant.id, variantIds));
      const variantById = new Map(variants.map((v) => [v.id, v]));

      const requiredByMaterial = new Map<string, number>();
      const unlinkedSizes = new Set<number>();
      for (const it of items) {
        const v = variantById.get(it.variantId!);
        if (!v) throw new BusinessError("validation_failed", "variant not found for a line", 422);
        if (!v.bottleMaterialId) {
          unlinkedSizes.add(v.sizeMl);
          continue;
        }
        requiredByMaterial.set(
          v.bottleMaterialId,
          (requiredByMaterial.get(v.bottleMaterialId) ?? 0) + it.quantityProduced,
        );
      }
      if (unlinkedSizes.size > 0) {
        throw new BusinessError(
          "validation_failed",
          `no bottle is linked to size(s) ${[...unlinkedSizes].sort((a, b) => a - b).join(", ")}ml — link a bottle on the Packaging tab first`,
          422,
          { reason: "bottle_not_linked" },
        );
      }

      // Pre-flight: check the factory has enough of each bottle BEFORE posting.
      const shortfalls: { material_id: string; needed: number; available: number }[] = [];
      for (const [materialId, needed] of requiredByMaterial) {
        const [bal] = await tx.execute<{ balance: number }>(sql`
          SELECT COALESCE(SUM(delta), 0)::int AS balance
          FROM packaging_stock_ledger
          WHERE factory_id = ${run.factoryId}::uuid
            AND packaging_material_id = ${materialId}::uuid
        `);
        const available = Number(bal?.balance ?? 0);
        if (available < needed) {
          shortfalls.push({ material_id: materialId, needed, available });
        }
      }
      if (shortfalls.length > 0) {
        throw new BusinessError(
          "conflict",
          "not enough bottles in stock to complete this run",
          422,
          { reason: "packaging_insufficient", shortfalls },
        );
      }
```

- [ ] **Step 2: Replace the old silent-skip consumption loop**

Delete the existing consumption loop (`:146-163`, the `for (const it of items) { if (!it.variantId) continue; ... if (!variant?.bottleMaterialId) continue; ... }`) and replace it with a loop that posts the already-aggregated consumption:

```ts
      // Post one consumption row per material (negative delta = bottles used).
      for (const [materialId, qty] of requiredByMaterial) {
        await tx.insert(packagingStockLedger).values({
          factoryId: run.factoryId,
          packagingMaterialId: materialId,
          delta: -qty,
          sourceType: "consumption",
          sourceId: id,
          recordedByUserId: auth.userId,
          note: `Run ${id} consumed ${qty} bottles`,
        });
      }
```

- [ ] **Step 3: Add the needed imports**

At the top of `production-runs.ts`, ensure `inArray` and `sql` are imported from `drizzle-orm` (the file already imports `eq, and, desc, asc` — add `inArray, sql`):

```ts
import { eq, and, desc, asc, inArray, sql } from "drizzle-orm";
```

- [ ] **Step 4: Keep the outer trigger-reshape catch as a backstop**

Leave the existing `catch` block (`:182-205`) intact — it still protects against a race where stock dropped between the pre-flight read and the commit. No change needed there.

- [ ] **Step 5: Typecheck the API**

Run: `pnpm --filter @ms/api exec tsc -b`
Expected: no errors. (If `tx.execute` generic typing complains, mirror how `packaging.ts` types its `db.execute<{...}>` calls.)

- [ ] **Step 6: (defer commit to Task 6)** — commit happens after the tests in Task 6 are green, so this task's code and its tests land together.

---

## Task 5: Seed bottle materials + link seeded variants (dev parity)

So a freshly seeded dev DB behaves like prod-after-migration.

**Files:**
- Modify: `packages/db/src/seed.ts`

- [ ] **Step 1: Read the seed's product/variant section**

Read `packages/db/src/seed.ts` to find where products + variants are inserted (the function that seeds flavours and their sizes). Note the variable holding the inserted variant rows and their `sizeMl`.

- [ ] **Step 2: Seed the two bottle materials (idempotent)**

In `seed.ts`, add a `seedBottleMaterials()` step that inserts the 330ml and 650ml bottle materials only if absent (mirror the seed's existing "already exists, skip" pattern used by `seedOwner`/`seedFactory`):

```ts
async function seedBottleMaterials(): Promise<void> {
  for (const [name, sizeMl] of [["330ml Glass Bottle", 330], ["650ml Glass Bottle", 650]] as const) {
    const existing = await db
      .select()
      .from(packagingMaterial)
      .where(eq(packagingMaterial.sizeMl, sizeMl));
    if (existing.length > 0) continue;
    await db.insert(packagingMaterial).values({ name, unitLabel: "bottle", sizeMl, isActive: true });
  }
}
```

Add `packagingMaterial` to the schema import list at the top of `seed.ts`, and call `await seedBottleMaterials();` in the seed's main run sequence BEFORE products are seeded.

- [ ] **Step 3: Link seeded variants by size**

After products/variants are seeded, link any variant lacking a bottle material, using the helper from Task 2:

```ts
async function linkVariantBottles(): Promise<void> {
  const variants = await db.select().from(productVariant).where(isNull(productVariant.bottleMaterialId));
  for (const v of variants) {
    const materialId = await bottleMaterialIdForSize(db, v.sizeMl);
    if (materialId) {
      await db.update(productVariant).set({ bottleMaterialId: materialId }).where(eq(productVariant.id, v.id));
    }
  }
}
```

Import `bottleMaterialIdForSize` (from the local `./lib/bottle-material.js`), `productVariant`, and `isNull` (from `drizzle-orm`) as needed; call `await linkVariantBottles();` after products are seeded.

- [ ] **Step 4: Verify the seed runs (against a local/test DB)**

If a local DB is available: `pnpm --filter @ms/db seed` then verify `SELECT COUNT(*) FROM product_variant WHERE bottle_material_id IS NULL;` is 0 for 330/650 sizes. If no local DB, confirm the code typechecks: `pnpm --filter @ms/db exec tsc -b` → no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/seed.ts
git commit -m "feat(db): seed bottle materials + link seeded variants"
```

---

## Task 6: Integration tests for consumption + the hard guard (TDD pair with Task 4)

**Files:**
- Create: `apps/api/test/integration/production-runs-consumption.test.ts`

> Use the existing integration helper the other `apps/api/test/integration/*.test.ts` files use to: get an authed owner/admin client, create a factory, create a product with a variant, and post packaging stock. Read `apps/api/test/integration/packaging-consumption.test.ts` and `production-runs-draft.test.ts` first — they already exercise exactly these flows; copy their setup verbatim rather than inventing helpers.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/production-runs-consumption.test.ts` with (adapting setup to the real helpers):

```ts
// Happy path: completing a run with enough bottles reduces bottle stock by the
// produced quantity.
it("reduces bottle stock when a run with enough bottles completes", async () => {
  // setup: factory F, product with 330ml variant (auto-linked to 330ml bottle),
  // purchase 100 bottles of the 330ml material at F.
  // create a draft run at F with one line: 330ml variant, qty 30. complete it.
  // assert: /packaging/stock?factory_id=F shows the 330ml balance = 70.
});

// Guard: completing a run that needs more bottles than are in stock is blocked
// with a 422 and posts NOTHING (stock unchanged, run still draft).
it("blocks completion and posts nothing when bottles are short", async () => {
  // setup: factory F, product 330ml variant, purchase only 10 bottles.
  // draft run line: qty 30. complete → expect 422 reason packaging_insufficient.
  // assert: 330ml balance still 10; run status still 'draft'; no production
  // stock_ledger rows for the run.
});

// Guard: a line with no size (variant_id null) blocks completion.
it("blocks completion when a line has no size", async () => {
  // create a run, append an item with product_id but no variant_id (use the
  // append-items endpoint with variant omitted). complete → 422 reason
  // missing_variant.
});
```

Fill in each test body using the copied helper setup. For the "no size" test, the append-items endpoint accepts `variant_id` as optional (`apps/api/src/routes/production-runs.ts` `ItemInput`), so omit it to create a legacy line.

- [ ] **Step 2: Run them, confirm they FAIL**

Run: `pnpm --filter @ms/api exec vitest run test/integration/production-runs-consumption.test.ts`
Expected: FAIL — before Task 4's implementation, completion silently skips (happy path shows balance unchanged at 100, guard tests don't 422). This is the red half of the Task 4 cycle.

- [ ] **Step 3: Implement Task 4 now (if not already done)**

Apply Task 4 Steps 1–5. Then re-run:
Run: `pnpm --filter @ms/api exec vitest run test/integration/production-runs-consumption.test.ts`
Expected: all PASS.

- [ ] **Step 4: Run the existing packaging-consumption + production-runs-draft suites (no regression)**

Run: `pnpm --filter @ms/api exec vitest run test/integration/packaging-consumption.test.ts test/integration/production-runs-draft.test.ts`
Expected: all PASS. If `packaging-consumption.test.ts` encoded the OLD silent-skip behavior, update those assertions to the new hard-guard behavior and note it in the commit (the new behavior is correct per spec).

- [ ] **Step 5: Commit Task 4 + Task 6 together**

```bash
git add apps/api/src/routes/production-runs.ts apps/api/test/integration/production-runs-consumption.test.ts apps/api/test/integration/packaging-consumption.test.ts
git commit -m "feat(api): hard-guard production completion on bottle stock; consume per material"
```

---

## Task 7: Production stock card (per-size bottle balances)

A card atop the production page showing how many bottles of each size remain at the selected factory, plus units produced today — answering "always show counts of the sizes of bottles we have left."

**Files:**
- Modify: `apps/admin/src/routes/factory/production-runs.tsx`

- [ ] **Step 1: Read the component to find the right insertion point**

Read `apps/admin/src/routes/factory/production-runs.tsx`. Locate: the `factoryId` state, the `useEffect` keyed on `factoryId`, the `runDate` state, the `history` state (loaded by `loadHistory`), and where the page's main content renders (so the card goes at the top of the page body, below the factory/date selectors).

- [ ] **Step 2: Add bottle-stock state + loader**

Add state and a loader that fetches `/packaging/stock?factory_id=<factoryId>` and keeps only sized materials (bottles):

```tsx
interface BottleStock { material_id: string; name: string; size_ml: number | null; balance: number; }
const [bottleStock, setBottleStock] = useState<BottleStock[]>([]);

useEffect(() => {
  if (!factoryId) { setBottleStock([]); return; }
  let cancelled = false;
  void (async () => {
    try {
      const res = await api<{ data: BottleStock[] }>(`/packaging/stock?factory_id=${factoryId}`);
      if (cancelled) return;
      // Bottles are the sized materials.
      setBottleStock(res.data.filter((m) => m.size_ml != null).sort((a, b) => (a.size_ml ?? 0) - (b.size_ml ?? 0)));
    } catch {
      if (!cancelled) setBottleStock([]);
    }
  })();
  return () => { cancelled = true; };
}, [factoryId]);
```

Match the existing import of `api` and `useState`/`useEffect` already present in the file. If the file uses a shared loading/error pattern, follow it; a silent empty list on error is acceptable for a read-only card.

- [ ] **Step 3: Compute units produced today from the already-loaded history**

The page already loads `history` (runs with their `items`). Derive today's produced units without a new fetch:

```tsx
const producedToday = history
  .filter((h) => h.runDate === runDate)
  .flatMap((h) => h.items ?? [])
  .reduce((sum, it) => sum + (it.quantityProduced ?? 0), 0);
```

(Confirm the field names `runDate`, `items`, `quantityProduced` against the `Run`/item types defined at the top of the file; adapt casing to match those types.)

- [ ] **Step 4: Render the card**

Insert at the top of the page body (below the factory/date selectors, above the draft editor). Use the existing card/utility classes in this file (match a sibling card's className; do not introduce a new design system):

```tsx
<div className="card">
  <div className="card__head"><h3>Bottle stock — {factoryName ?? "factory"}</h3></div>
  <div className="stat-grid">
    {bottleStock.length === 0 ? (
      <p className="muted">No bottle stock recorded for this factory yet.</p>
    ) : (
      bottleStock.map((b) => (
        <div key={b.material_id} className="stat">
          <div className="stat__label">{b.size_ml}ml</div>
          <div className="stat__value">{b.balance}</div>
        </div>
      ))
    )}
    <div className="stat">
      <div className="stat__label">Produced today</div>
      <div className="stat__value">{producedToday}</div>
    </div>
  </div>
</div>
```

Replace `className` values with the actual classes used by an existing card/stat in this file or its siblings (e.g. check `apps/admin/src/routes/owner/dashboard.tsx` for the Stat component — if a reusable `Stat` exists, use it instead of raw divs). `factoryName` should come from the already-loaded factories list (find the selected factory's name); if no such variable exists, derive it inline or omit the suffix.

- [ ] **Step 5: Typecheck the admin app**

Run: `pnpm --filter @ms/admin exec tsc -b`
Expected: no NEW errors (the two pre-existing `ProductEditor.tsx:44` / `GateEditor.tsx:15` errors may still appear from a stale incremental build — confirm a full repo `pnpm typecheck` is clean, as it was after the quick-fixes work).

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/routes/factory/production-runs.tsx
git commit -m "feat(admin): per-size bottle stock card on the production page"
```

---

## Final verification

- [ ] **Step 1: Lint + typecheck the whole repo**

Run: `pnpm lint && pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 2: Run all touched test files**

```bash
pnpm --filter @ms/api exec vitest run \
  test/integration/products.test.ts \
  test/integration/production-runs-consumption.test.ts \
  test/integration/packaging-consumption.test.ts \
  test/integration/production-runs-draft.test.ts
```
Expected: all PASS.

- [ ] **Step 3: Manual smoke (the actual goal)**

On a seeded local stack: open the production page, pick a factory, confirm the **bottle stock card** shows per-size counts. Record a packaging purchase of, say, 50 × 330ml bottles. Start a draft run, add a 330ml flavour qty 20, complete → the run completes and the card's 330ml balance drops by 20. Add another run qty 9999 → completion is **blocked** with a clear "not enough bottles" message and the balance is unchanged.

---

## Self-Review Notes (for the author)

- **Spec coverage (A1 portion):** #5 bottle consumption + hard guard → Tasks 1–6; root-cause data fix (materials exist + variants linked) → Tasks 1, 3, 5; #9 production stock card → Task 7. Bags / location-aware ledger / POS bag consumption / transfers are intentionally in plan A2, not here.
- **Type consistency:** `bottleMaterialIdForSize(db, sizeMl)` is defined in Task 2 and used identically in Tasks 3 and 5. `requiredByMaterial` / `shortfalls` shapes are internal to Task 4. The `BusinessError(code, message, status, details)` signature matches the existing usage in `production-runs.ts`.
- **Migration discipline:** Task 1 adds the `_journal.json` entry (else migrate skips it) and Task 2 rebuilds `@ms/db`.
- **TDD pairing:** Tasks 4 and 6 share one red→green cycle; the executor note spells out the order.
- **Deferred to A2:** `packaging_material.kind`, bag rows, location-aware `packaging_stock_ledger`, POS bag consumption, transfer bag lines.

# Per-Size Stock Tracking — Phase 1 (Factory + Inventory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make on-hand stock track per **size (variant)** instead of per **flavour (product)**, starting with the factory-production → ledger → inventory path, so the system stops collapsing "10×35cl + 4×1L" into a single fungible pool of 14.

**Architecture:** The `stock_ledger` table already has a nullable `variant_id` column and an index on it, but three things collapse the size dimension: (1) the non-negative-balance trigger groups by `(location, product)`, (2) the domain `balanceAt()` read groups by `product_id`, and (3) several write sites omit `variant_id` even when they have it. Phase 1 retargets the trigger and reads to `(location, product, variant)`, fixes the production-run and adjustment write sites to carry the variant, and renders inventory per size. Legacy NULL-variant balances are auto-assigned to a flavour's sole variant where unambiguous; multi-size flavours keep a NULL "needs recount" bucket. Transfers and the offline POS are explicitly **out of scope for Phase 1** (see Roadmap) — they keep working unchanged at flavour grain because the trigger continues to treat NULL-variant rows as their own bucket.

**Tech Stack:** PostgreSQL + Drizzle ORM (`@ms/db`), Hono API (`apps/api`), Vitest + Testcontainers integration tests, React admin (`apps/admin`).

---

## Key facts established during review

Ledger write sites and whether they currently carry `variant_id`:

| Site | File:line | Carries variant today? | Phase 1 action |
|---|---|---|---|
| Sale decrement | `apps/api/src/routes/sales.ts:273` | ✅ `variantId: it.variantId ?? null` | none |
| Online order paid | `apps/api/src/routes/webhooks-opay.ts:82` | ✅ | none |
| Return restock | `apps/api/src/routes/returns.ts:345…` | ✅ | none |
| **Production run complete** | `apps/api/src/routes/production-runs.ts:128` | ❌ omits it (but `it.variantId` exists) | **fix** |
| **Inventory adjustment** | `apps/api/src/routes/inventory.ts:110` | ❌ no variant in body | **fix** |
| Transfer dispatch/receive | `apps/api/src/routes/transfers.ts:250,369,486,572,588` | ❌ flavour-grain; `stock_transfer_item` has no variant | Phase 3 (out of scope) |

Reads that collapse size:
- `packages/domain/src/stock.ts:30` — `balanceAt` does `GROUP BY product_id`.
- `apps/api/src/routes/reports.ts:86` — `/branch-stock` groups by `location_id, product_id`.
- `apps/api/src/routes/inventory.ts` factory stock + `/stock/factory/:id` (verify) group by product.

Invariant trigger: `packages/db/migrations/0006_stock_ledger_constraints.sql` groups by `(location_type, location_id, product_id)`.

Next migration index is **0041** (latest is `0040_storefront_marketing`).

---

## File Structure

**Modify:**
- `packages/db/migrations/0041_stock_ledger_per_variant.sql` (Create) — retarget trigger, backfill, index.
- `packages/db/migrations/meta/_journal.json` — journal entry for 0041.
- `packages/domain/src/stock.ts` — add `balanceByVariantAt()`; make `checkFactoryStockAvailable` variant-aware; keep `balanceAt` as a per-flavour roll-up that sums the per-variant map.
- `apps/api/src/routes/production-runs.ts:128` — post ledger with `variantId: it.variantId ?? null`.
- `apps/api/src/routes/inventory.ts` — accept optional `variant_id` per adjust item; compute old balance per `(product, variant)`; render factory stock per variant.
- `apps/api/src/routes/reports.ts:80` — `/branch-stock` returns `variant_id` and groups by it.
- `apps/admin/src/routes/owner/inventory.tsx` — grid rows become (flavour × size); adjust modal targets a variant.
- `apps/admin/src/routes/factory/production-runs.ts` (display) — no change needed (already shows size).

**Test:**
- `packages/db/test/stock-ledger-trigger.test.ts` — extend: per-variant negative check.
- `apps/api/test/integration/inventory-adjust.test.ts` — extend: adjust two sizes of one flavour independently.
- `apps/api/test/integration/production-run-variant-stock.test.ts` (Create) — produce two sizes, assert per-variant factory balance.

---

## Task 1: Domain — variant-aware balance reads

**Files:**
- Modify: `packages/domain/src/stock.ts`
- Test: covered via API integration in Task 4/5 (domain has no standalone DB harness; do not add testcontainers here).

- [ ] **Step 1: Add `balanceByVariantAt` and refactor `balanceAt` to roll it up**

Replace the `balanceAt` function in `packages/domain/src/stock.ts` (lines 13–33) with:

```ts
/**
 * Per-variant balance at a location. Key is `${productId}:${variantId ?? "null"}`
 * so legacy NULL-variant rows form their own bucket and never merge with sized
 * rows. Values are >= 0 (the per-variant trigger guarantees it).
 */
export async function balanceByVariantAt(
  db: DbExecutor,
  opts: { locationType: "factory" | "branch"; locationId: string; productId?: string },
): Promise<Array<{ productId: string; variantId: string | null; balance: number }>> {
  const where = [
    eq(stockLedger.locationType, opts.locationType),
    eq(stockLedger.locationId, opts.locationId),
  ];
  if (opts.productId) where.push(eq(stockLedger.productId, opts.productId));

  const rows = await db
    .select({
      productId: stockLedger.productId,
      variantId: stockLedger.variantId,
      balance: sql<number>`COALESCE(SUM(${stockLedger.delta}), 0)`.as("balance"),
    })
    .from(stockLedger)
    .where(and(...where))
    .groupBy(stockLedger.productId, stockLedger.variantId);

  return rows.map((r) => ({
    productId: r.productId,
    variantId: r.variantId,
    balance: Number(r.balance),
  }));
}

/**
 * Per-flavour roll-up (sum across all sizes incl. the NULL bucket). Kept for
 * callers that only need a flavour total (e.g. transfers, which are still
 * flavour-grain in Phase 1).
 */
export async function balanceAt(
  db: DbExecutor,
  opts: { locationType: "factory" | "branch"; locationId: string; productId?: string },
): Promise<Record<string, number>> {
  const rows = await balanceByVariantAt(db, opts);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.productId] = (out[r.productId] ?? 0) + r.balance;
  return out;
}
```

- [ ] **Step 2: Typecheck the domain package**

Run: `cd packages/domain && npx tsc -b`
Expected: no errors. (`balanceAt`'s signature is unchanged, so existing callers compile untouched.)

- [ ] **Step 3: Commit**

```bash
git add packages/domain/src/stock.ts
git commit -m "feat(domain): add balanceByVariantAt; balanceAt rolls it up"
```

---

## Task 2: DB migration — per-variant trigger + backfill + index

**Files:**
- Create: `packages/db/migrations/0041_stock_ledger_per_variant.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Test: `packages/db/test/stock-ledger-trigger.test.ts`

- [ ] **Step 1: Write the migration SQL**

Create `packages/db/migrations/0041_stock_ledger_per_variant.sql`:

```sql
-- Phase 1 of per-size stock tracking. The ledger already has variant_id; this
-- migration makes the NON-NEGATIVE invariant operate per (location, product,
-- variant) instead of per (location, product), and auto-assigns legacy
-- NULL-variant balances to a flavour's sole variant where unambiguous.
--
-- IMPORTANT: NULL-variant rows are a distinct bucket. `variant_id = X` and
-- `variant_id IS NULL` never merge, so multi-size flavours keep their old
-- pooled balance under the NULL bucket until staff recount (see admin UI).

-- 1) Retarget the balance-check trigger function. NULL variant_id is compared
--    with `IS NOT DISTINCT FROM` so the NULL bucket is summed on its own.
CREATE OR REPLACE FUNCTION stock_ledger_check_balance() RETURNS trigger AS $$
DECLARE
  current_sum integer;
BEGIN
  SELECT COALESCE(SUM(delta), 0) INTO current_sum
    FROM stock_ledger
    WHERE location_type = NEW.location_type
      AND location_id   = NEW.location_id
      AND product_id    = NEW.product_id
      AND variant_id IS NOT DISTINCT FROM NEW.variant_id;
  IF current_sum < 0 THEN
    RAISE EXCEPTION
      'stock_ledger negative balance: location_type=% location_id=% product_id=% variant_id=% sum=%',
      NEW.location_type, NEW.location_id, NEW.product_id, NEW.variant_id, current_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2) Auto-assign legacy NULL-variant balances for SINGLE-variant flavours.
--    For each such flavour at each location, post a paired correction: move the
--    NULL-bucket balance onto the sole active variant. Multi-variant flavours
--    are intentionally skipped (left as a NULL "needs recount" bucket).
WITH single_variant AS (
  SELECT pv.product_id, MIN(pv.id) AS variant_id
  FROM product_variant pv
  WHERE pv.deleted_at IS NULL
  GROUP BY pv.product_id
  HAVING COUNT(*) = 1
),
null_bucket AS (
  SELECT sl.location_type, sl.location_id, sl.product_id,
         COALESCE(SUM(sl.delta), 0)::int AS bal
  FROM stock_ledger sl
  WHERE sl.variant_id IS NULL
  GROUP BY sl.location_type, sl.location_id, sl.product_id
  HAVING COALESCE(SUM(sl.delta), 0) <> 0
)
INSERT INTO stock_ledger
  (location_type, location_id, product_id, variant_id, delta, source_type, source_id, note)
SELECT nb.location_type, nb.location_id, nb.product_id, sv.variant_id,
       nb.bal, 'count_correction', gen_random_uuid(),
       'Phase1 auto-assign NULL bucket to sole variant'
FROM null_bucket nb
JOIN single_variant sv ON sv.product_id = nb.product_id;

-- Mirror: drain the NULL bucket by the same amount so totals are conserved.
WITH single_variant AS (
  SELECT pv.product_id, MIN(pv.id) AS variant_id
  FROM product_variant pv
  WHERE pv.deleted_at IS NULL
  GROUP BY pv.product_id
  HAVING COUNT(*) = 1
),
null_bucket AS (
  SELECT sl.location_type, sl.location_id, sl.product_id,
         COALESCE(SUM(sl.delta), 0)::int AS bal
  FROM stock_ledger sl
  WHERE sl.variant_id IS NULL
  GROUP BY sl.location_type, sl.location_id, sl.product_id
  HAVING COALESCE(SUM(sl.delta), 0) <> 0
)
INSERT INTO stock_ledger
  (location_type, location_id, product_id, variant_id, delta, source_type, source_id, note)
SELECT nb.location_type, nb.location_id, nb.product_id, NULL,
       -nb.bal, 'count_correction', gen_random_uuid(),
       'Phase1 drain NULL bucket (moved to sole variant)'
FROM null_bucket nb
JOIN single_variant sv ON sv.product_id = nb.product_id;

-- 3) Covering index for the new grouping.
CREATE INDEX IF NOT EXISTS idx_ledger_loc_product_variant
  ON stock_ledger (location_type, location_id, product_id, variant_id);
```

Note: the two INSERTs are ordered drain-after-credit; the trigger is `DEFERRABLE INITIALLY IMMEDIATE` per-row, and both legs net to a non-negative result per bucket, so neither leg trips the check.

- [ ] **Step 2: Add the journal entry**

In `packages/db/migrations/meta/_journal.json`, append after the `0040_storefront_marketing` entry (inside the `entries` array):

```json
    ,{
      "idx": 40,
      "version": "7",
      "when": 1781900000000,
      "tag": "0041_stock_ledger_per_variant",
      "breakpoints": true
    }
```

(Place the comma correctly — it follows the closing `}` of the idx-39 object.)

- [ ] **Step 3: Extend the trigger test**

In `packages/db/test/stock-ledger-trigger.test.ts`, add a case asserting two sizes of one flavour have independent floors. Read the file first to match its harness (seed helpers, variant creation). Add:

```ts
it("enforces non-negative balance per variant, not per flavour", async () => {
  // Produce 5 of variant A, 0 of variant B for the same product at a factory.
  await insertLedger({ locationType: "factory", locationId: factoryId, productId, variantId: variantA, delta: 5, sourceType: "production_run" });
  // Selling 1 of variant B (which has 0) must fail even though the flavour total is 5.
  await expect(
    insertLedger({ locationType: "factory", locationId: factoryId, productId, variantId: variantB, delta: -1, sourceType: "adjustment" }),
  ).rejects.toThrow(/negative balance/);
  // Selling 5 of variant A is fine.
  await expect(
    insertLedger({ locationType: "factory", locationId: factoryId, productId, variantId: variantA, delta: -5, sourceType: "sale" }),
  ).resolves.toBeDefined();
});
```

- [ ] **Step 4: Rebuild @ms/db and run the migration + trigger test**

Run: `cd packages/db && npm run build && npm test`
Expected: migrations apply cleanly (0041 included), new per-variant test PASSES, existing trigger tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/0041_stock_ledger_per_variant.sql packages/db/migrations/meta/_journal.json packages/db/test/stock-ledger-trigger.test.ts
git commit -m "feat(db): per-variant stock ledger invariant + legacy backfill (0041)"
```

---

## Task 3: API — production-run completion posts the variant

**Files:**
- Modify: `apps/api/src/routes/production-runs.ts:128`
- Test: `apps/api/test/integration/production-run-variant-stock.test.ts` (Create)

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/production-run-variant-stock.test.ts`. Mirror the harness in `inventory-adjust.test.ts` (import `setupTestDb, seedOwner, loginAs` from `./helpers.js`, boot `buildApp` from `../../src/test-app.js`). Core assertion:

```ts
it("posts factory stock per variant when a run completes", async () => {
  // product with two variants v35 (35ml) and v100 (1L) — create via /products.
  // start a run, append 5×v35 and 3×v100, complete it.
  // then GET the factory stock and assert the two sizes are tracked separately.
  const stock = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
    "GET", `/v1/stock/factory/${factory.id}`,
  );
  const rows = stock.body.data.filter((r) => r.product_id === product.id);
  expect(rows.find((r) => r.variant_id === v35)!.balance).toBe(5);
  expect(rows.find((r) => r.variant_id === v100)!.balance).toBe(3);
});
```

(The factory-stock endpoint shape changes in Task 5; if running tests in plan order, expect this test to fail on shape until Task 5 lands. Acceptable — it is the same feature slice.)

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run test/integration/production-run-variant-stock.test.ts`
Expected: FAIL — balances collapse to one row / variant_id is null.

- [ ] **Step 3: Carry the variant into the ledger insert**

In `apps/api/src/routes/production-runs.ts`, change the insert at line 128:

```ts
        await tx.insert(stockLedger).values({
          locationType: "factory",
          locationId: run.factoryId,
          productId: it.productId,
          variantId: it.variantId ?? null,
          delta: it.quantityProduced,
          sourceType: "production_run",
          sourceId: id,
          recordedByUserId: auth.userId,
          note: `Production run ${id}`,
        });
```

- [ ] **Step 4: Run the test (with Task 5 done) to verify PASS**

Run: `cd apps/api && npx vitest run test/integration/production-run-variant-stock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/production-runs.ts apps/api/test/integration/production-run-variant-stock.test.ts
git commit -m "fix(api): production run posts factory stock per variant"
```

---

## Task 4: API — inventory adjustment targets a variant

**Files:**
- Modify: `apps/api/src/routes/inventory.ts`
- Test: `apps/api/test/integration/inventory-adjust.test.ts`

- [ ] **Step 1: Write the failing test**

In `inventory-adjust.test.ts`, add a case: a flavour with two variants, adjust v35 to 10 and v100 to 4 in one call, then read stock and assert the two sizes are independent (not a merged 14). Use the existing `call()` helper and idempotency header.

```ts
it("adjusts two sizes of one flavour independently", async () => {
  await call("POST", "/v1/inventory/adjust", {
    location_type: "factory", location_id: factory.id, reason_code: "opening_balance",
    items: [
      { product_id: product.id, variant_id: v35, new_quantity: 10 },
      { product_id: product.id, variant_id: v100, new_quantity: 4 },
    ],
  });
  const s = await call<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
    "GET", `/v1/stock/factory/${factory.id}`);
  const rows = s.body.data.filter((r) => r.product_id === product.id);
  expect(rows.find((r) => r.variant_id === v35)!.balance).toBe(10);
  expect(rows.find((r) => r.variant_id === v100)!.balance).toBe(4);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run test/integration/inventory-adjust.test.ts`
Expected: FAIL — `variant_id` is rejected by the zod body or ignored.

- [ ] **Step 3: Accept `variant_id` in the body and key the balance by it**

In `apps/api/src/routes/inventory.ts`, extend the item schema (lines 33–38):

```ts
      items: z
        .array(
          z.object({
            product_id: z.string().uuid(),
            variant_id: z.string().uuid().nullish(),
            new_quantity: z.number().int().nonnegative(),
          }),
        )
        .min(1)
        .max(50),
```

In the per-item loop (lines 94–104), add the variant to the old-balance query:

```ts
        const balRow = await tx
          .select({ bal: sql<number>`COALESCE(SUM(${stockLedger.delta}), 0)::int` })
          .from(stockLedger)
          .where(
            and(
              eq(stockLedger.locationType, body.location_type),
              eq(stockLedger.locationId, body.location_id),
              eq(stockLedger.productId, item.product_id),
              item.variant_id
                ? eq(stockLedger.variantId, item.variant_id)
                : isNull(stockLedger.variantId),
            ),
          );
```

Add `variantId: item.variant_id ?? null` to the `stockLedger` insert (line 110 block). Import `isNull` from `drizzle-orm` at the top (line 2: add `isNull`).

- [ ] **Step 4: Run the test to verify PASS**

Run: `cd apps/api && npx vitest run test/integration/inventory-adjust.test.ts`
Expected: PASS. Existing adjust tests (no variant_id ⇒ NULL bucket) still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/inventory.ts apps/api/test/integration/inventory-adjust.test.ts
git commit -m "feat(api): inventory adjustment targets a specific variant"
```

---

## Task 5: API — factory + branch stock reads return the variant

**Files:**
- Modify: `apps/api/src/routes/inventory.ts` (factory stock endpoint) and/or `apps/api/src/routes/reports.ts:80`
- Test: covered by Task 3 + Task 4 integration tests.

- [ ] **Step 1: Locate the factory-stock endpoint**

Run: `grep -rn "stock/factory" apps/api/src` to find the handler (it returns `Record<string, number>` keyed by product today). Read it.

- [ ] **Step 2: Return per-variant rows from factory stock**

Change the factory-stock handler to use `balanceByVariantAt` from `@ms/domain` and return:

```ts
const rows = await balanceByVariantAt(db, { locationType: "factory", locationId });
return c.json({ data: rows.map((r) => ({ product_id: r.productId, variant_id: r.variantId, balance: r.balance })) });
```

Update its import to add `balanceByVariantAt`. If the admin inventory page consumes the old `Record<string, number>` shape, that is updated in Task 6.

- [ ] **Step 3: Make `/branch-stock` per-variant**

In `apps/api/src/routes/reports.ts`, replace the `/branch-stock` query (lines 80–92):

```ts
  r.get("/branch-stock", async (c) => {
    const rows = await db.execute<{
      branch_id: string;
      product_id: string;
      variant_id: string | null;
      balance: number;
    }>(sql`
      SELECT location_id AS branch_id, product_id, variant_id,
             COALESCE(SUM(delta), 0)::int AS balance
      FROM stock_ledger
      WHERE location_type = 'branch'
      GROUP BY location_id, product_id, variant_id
    `);
    return c.json({ data: rows });
  });
```

- [ ] **Step 4: Run the related integration tests**

Run: `cd apps/api && npx vitest run test/integration/production-run-variant-stock.test.ts test/integration/inventory-adjust.test.ts`
Expected: PASS (Task 3 + Task 4 now green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/inventory.ts apps/api/src/routes/reports.ts
git commit -m "feat(api): factory + branch stock reads return per-variant balances"
```

---

## Task 6: Admin — inventory grid + adjust modal go per-size

**Files:**
- Modify: `apps/admin/src/routes/owner/inventory.tsx`

- [ ] **Step 1: Update the row types and fetch shapes**

Change `BranchStockRow` to `{ branch_id; product_id; variant_id: string | null; balance }`. Add a `variants` fetch (`/products` already lists flavours; pull `/products/:id` variants or a `variants` list endpoint — `grep -rn "variants" apps/api/src/routes/products.ts` to confirm the shape). Build the grid rows as one row per **(product × variant)**, with a readable label `"<flavour> · <size>"` and a separate visually-muted row for any NULL bucket labelled `"<flavour> · (unassigned — recount)"`.

- [ ] **Step 2: Key the heatmap maps by product+variant**

`branchHeat` key becomes `${branch_id}|${product_id}|${variant_id ?? "null"}`. Factory stock map becomes `Record<factoryId, Array<{product_id; variant_id; balance}>>` indexed the same way. Update `renderCell`, totals, and `AdjustTarget` to carry `variantId: string | null`.

- [ ] **Step 3: Pass `variant_id` through the adjust + bulk-adjust payloads**

In `runAdjust` and `BulkAdjustModal.handleSubmit`, include `variant_id: target.variantId` (resp. per-row variant) in each `items[]` entry sent to `/inventory/adjust`.

- [ ] **Step 4: Manual verify in the browser**

Boot the stack (see `reference_local_run` memory), open Owner → Inventory. Confirm: a two-size flavour shows two rows with independent counts; adjusting one size does not change the other; a multi-size flavour with legacy stock shows an "(unassigned — recount)" row; recounting it into sizes zeroes the unassigned row.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/routes/owner/inventory.tsx
git commit -m "feat(admin): inventory grid + adjustments are per-size"
```

---

## Task 7: Full-suite regression + quality gate

- [ ] **Step 1: API integration suite (run per-file to avoid testcontainer beforeAll timeouts under load — see quality_gates memory)**

Run: `cd apps/api && npx vitest run test/integration/inventory-adjust.test.ts test/integration/production-run-variant-stock.test.ts test/integration/transfer-flow.test.ts test/integration/transfer-adjust.test.ts test/integration/adjustments-history.test.ts`
Expected: all PASS. (Transfers still flavour-grain → unaffected because NULL bucket is preserved.)

- [ ] **Step 2: db + domain packages**

Run: `cd packages/db && npm test` then `cd packages/domain && npm test`
Expected: PASS.

- [ ] **Step 3: Lint + typecheck repo-wide**

Run: `npm run lint && npm run typecheck` (from repo root)
Expected: 0 errors (matches the quality-gates baseline).

- [ ] **Step 4: Commit any lint fixes, then stop for review**

```bash
git add -A && git commit -m "chore: per-size stock phase 1 — lint/typecheck clean"
```

---

## Self-Review (completed by author)

- **Spec coverage:** per-size tracking (Tasks 1–5), legacy migration via auto-assign + recount bucket (Task 2 backfill + Task 6 unassigned row), factory representation (Task 3), inventory representation (Task 6). ✅
- **Out of scope, documented:** transfers (Phase 3), offline POS availability (Phase 4) — NULL-bucket preservation keeps both working unchanged. ✅
- **Type consistency:** `balanceByVariantAt` returns `{ productId, variantId, balance }` and is consumed identically in Tasks 3/5; API JSON uses snake_case `variant_id` consistently. ✅

---

## Roadmap (subsequent phases — plan separately)

**Phase 2 — Sale/POS read-side correctness (server):** sales already write `variantId`; verify `/branches/:id/sales` confirm path rejects an oversell of a specific size via the now-per-variant trigger. Add an integration test that oversells one size while another size has stock.

**Phase 3 — Transfers per size:** add `variant_id` to `stock_transfer_item` (migration), thread it through dispatch/receive/reject ledger writes (`transfers.ts:250,369,486,572,588`), and the transfer UI. This is the largest remaining slice because the transfer line table is product-only today.

**Phase 4 — Offline POS availability per size:** bump the Dexie schema in `apps/admin/src/db/local.ts` (ledger key → `[location_type+location_id+product_id+variant_id]`), add `localAvailableForVariant`, update the sale-sync pull (`apps/api/src/routes/sync.ts`) to send `variant_id` on ledger rows, and switch the POS pre-flight in `apps/admin/src/routes/branch/sell.tsx` from per-flavour to per-size (this removes the oversell-a-size bug at the till). Requires the v3→v4 Dexie upgrade to repull the ledger.
```
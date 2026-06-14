# Size-Aware Transfers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make stock transfers (and the coupled production-run posting) carry the can **size (variant)**, so factory and branch on-hand become truthful per size. The per-size non-negative floor stays DEFERRED (floor remains per-flavour) — enforcement is a later, separate step.

**Architecture:** `stock_transfer_item` gains a nullable `variant_id`. Dispatch stores and posts it; receive/reject/count-adjust post the item's stored variant; factory availability is checked per-(product, variant). Production runs also post their item's variant (one-line fix) so factory per-size buckets are populated. Legacy/in-flight transfers keep `variant_id = NULL` and flow through the existing no-size bucket on both legs — balanced, no migration of in-flight data needed. Pre-cutover factory/branch stock in the NULL bucket is drained to sizes by the owner via the existing per-size recount in the inventory grid (operational, not code).

**Tech Stack:** PostgreSQL + Drizzle, Hono API, Vitest + Testcontainers, React admin.

**Branch:** `feat/transfers-per-size` (worktree at `C:\Users\owoti\Desktop\MRS SAMUEL FRUIT JUICE\ms-transfers`). Next migration index: **0044** (latest is 0043).

---

## Ledger write-sites that must carry the variant (from `apps/api/src/routes/transfers.ts`)
- Dispatch: line 250 (`transfer_dispatch`, factory −) → use `it.variant_id ?? null`.
- Receive: line 369 (`transfer_receive`, branch +) → use stored `it.variantId ?? null`.
- Reject-reverse: line 486 (`transfer_reject_reverse`, factory +) → stored `it.variantId ?? null`.
- Adjust sent: line 572 (`count_correction`, factory) → stored `it.variantId ?? null`.
- Adjust received: line 588 (`count_correction`, branch) → stored `it.variantId ?? null`.
Plus production: `apps/api/src/routes/production-runs.ts:128` (`production_run`, factory +) → `it.variantId ?? null`.

---

## Task 1: Schema + migration — `variant_id` on `stock_transfer_item`

**Files:** `packages/db/src/schema/stock-transfer.ts`, `packages/db/migrations/0044_transfer_item_variant.sql`, `packages/db/migrations/meta/_journal.json`

- [ ] **Step 1:** Add to the `stockTransferItem` table in `packages/db/src/schema/stock-transfer.ts` (after `productId`, import `productVariant` from `./product-variant.js`):
```ts
  variantId: uuid("variant_id").references(() => productVariant.id, { onDelete: "restrict" }),
```
- [ ] **Step 2:** Create `packages/db/migrations/0044_transfer_item_variant.sql`:
```sql
-- Size-aware transfers: each transfer line may name the exact can size.
-- Nullable so legacy/in-flight transfers keep NULL (no-size bucket) and stay
-- balanced across dispatch/receive. New dispatches always set it.
ALTER TABLE stock_transfer_item
  ADD COLUMN variant_id uuid REFERENCES product_variant(id);

CREATE INDEX IF NOT EXISTS idx_transfer_item_variant
  ON stock_transfer_item (variant_id);
```
- [ ] **Step 3:** Append a journal entry to `packages/db/migrations/meta/_journal.json` after the LAST existing entry: read the last entry's `idx`, use `idx + 1`, `version "7"`, a `when` larger than the last, `tag "0044_transfer_item_variant"`, `breakpoints true`. Keep JSON valid (comma after previous entry).
- [ ] **Step 4:** `cd packages/db && npm run build && npm test` → expect success (migration applies; existing tests green).
- [ ] **Step 5:** Commit `feat(db): add variant_id to stock_transfer_item (0044)`.

---

## Task 2: Domain — per-variant factory availability check

**Files:** `packages/domain/src/stock.ts`

- [ ] **Step 1:** Add a per-variant availability checker (alongside the existing `checkFactoryStockAvailable`, which stays for any flavour-grain caller). Uses `balanceByVariantAt`:
```ts
/**
 * Per-variant factory availability for a dispatch. Each requested line is keyed
 * to its own (product, variant) bucket — a NULL variantId checks the legacy
 * no-size bucket. MUST run in the same tx that writes the dispatch rows.
 */
export async function checkFactoryStockAvailableByVariant(
  db: DbExecutor,
  factoryId: string,
  items: { productId: string; variantId: string | null; quantity: number }[],
): Promise<
  | { ok: true }
  | { ok: false; insufficient: { productId: string; variantId: string | null; available: number; requested: number }[] }
> {
  const rows = await balanceByVariantAt(db, { locationType: "factory", locationId: factoryId });
  const key = (p: string, v: string | null) => `${p}:${v ?? "null"}`;
  const bal = new Map(rows.map((r) => [key(r.productId, r.variantId), r.balance]));
  const insufficient = items
    .map((it) => ({
      productId: it.productId,
      variantId: it.variantId,
      available: bal.get(key(it.productId, it.variantId)) ?? 0,
      requested: it.quantity,
    }))
    .filter((x) => x.available < x.requested);
  return insufficient.length === 0 ? { ok: true } : { ok: false, insufficient };
}
```
- [ ] **Step 2:** `cd packages/domain && npx tsc -b` → clean.
- [ ] **Step 3:** Commit `feat(domain): per-variant factory availability check`.

---

## Task 3: API transfers — dispatch/receive/reject/adjust carry the variant

**Files:** `apps/api/src/routes/transfers.ts`

- [ ] **Step 1:** `CreateDraft` item schema: add `variant_id: z.string().uuid().nullish()`.
- [ ] **Step 2:** Dispatch handler: replace the flavour-grain check call with `checkFactoryStockAvailableByVariant(tx, body.factory_id, body.items.map(i => ({ productId: i.product_id, variantId: i.variant_id ?? null, quantity: i.quantity_sent })))` (import it). Update the 422 details to include the per-variant `insufficient` shape.
- [ ] **Step 3:** Dispatch: store the variant on the item (`variantId: it.variant_id ?? null` in the `stockTransferItem` insert) AND on the dispatch ledger insert (`variantId: it.variant_id ?? null`).
- [ ] **Step 4:** Receive: the receive ledger insert (line ~369) add `variantId: it.variantId ?? null` (read from the stored item `it`).
- [ ] **Step 5:** Reject-reverse: ledger insert (line ~486) add `variantId: it.variantId ?? null`.
- [ ] **Step 6:** Adjust sent (line ~572) and adjust received (line ~588): add `variantId: it.variantId ?? null` to both ledger inserts.
- [ ] **Step 7:** Detail endpoint `GET /:id` (line ~196): left-join `product_variant` so each item includes `size_ml` (and keep `variant_id`), so the UI can show the size. Return items mapped with `variant_id` and `size_ml`.
- [ ] **Step 8:** `cd apps/api && npx tsc -b` → clean.
- [ ] **Step 9:** Commit `feat(api): transfers carry can size through dispatch/receive/reject/adjust`.

---

## Task 4: API production-runs — post the variant (coupled fix)

**Files:** `apps/api/src/routes/production-runs.ts`

- [ ] **Step 1:** In the run-complete ledger insert (line ~128), add `variantId: it.variantId ?? null` so produced stock lands in the correct factory per-size bucket.
- [ ] **Step 2:** `cd apps/api && npx tsc -b` → clean.
- [ ] **Step 3:** Commit `fix(api): production run posts factory stock per variant`.

---

## Task 5: Integration tests

**Files:** `apps/api/test/integration/transfer-variant.test.ts` (new), mirror harness of `transfer-flow.test.ts`.

- [ ] **Step 1 (failing test):** Seed a factory with a 2-variant flavour: produce (via production run complete) 8×v35 and 5×v1L, OR set via `/inventory/adjust` with variant_id. Dispatch 5×v35 + 3×v1L to a branch. Receive clean. Assert:
  - `GET /v1/stock/factory/:id` shows v35 balance 3, v1L balance 2.
  - `GET /v1/stock/branch/:id` shows v35 balance 5, v1L balance 3.
  - `GET /v1/transfers/:id` items include `size_ml` per line.
- [ ] **Step 2:** Per-variant availability rejection: attempt to dispatch more v35 than the factory holds → expect 422 with `insufficient` naming the variant.
- [ ] **Step 3:** Run: `cd apps/api && npx vitest run test/integration/transfer-variant.test.ts` → PASS. Also re-run `transfer-flow.test.ts` + `transfer-adjust.test.ts` (legacy NULL-variant path still works).
- [ ] **Step 4:** Commit `test(api): size-aware transfer dispatch/receive + per-variant availability`.

---

## Task 6: Admin UI — dispatch size picker + receive/detail show size

**Files:** `apps/admin/src/routes/transfers.tsx` (dispatch), `apps/admin/src/routes/branch/transfers.tsx` (receive), `transfer-detail.tsx` if present.

- [ ] **Step 1:** Dispatch form (`transfers.tsx`): `DraftItem` gains `variant_id: string`. For each line add a Size `<select>` populated by fetching the product's variants on flavour change (reuse the `ensureVariants`/`/products/:id` pattern from `apps/admin/src/routes/factory/production-runs.ts`). Default to the first/only variant. Send `variant_id` in each item of the `POST /transfers` payload. Keep the existing dedupe sensible (a flavour can now appear once per size).
- [ ] **Step 2:** Optionally show per-size available factory stock next to the size select (nice-to-have; pull from `/stock/factory/:id` which already returns per-variant rows). Skip if it bloats the task.
- [ ] **Step 3:** Receive form (`branch/transfers.tsx`) + detail: render the size per line (the detail endpoint now returns `size_ml`). Show e.g. "Zobo · 35cl".
- [ ] **Step 4:** `cd apps/admin && npx tsc --noEmit` → only the two PRE-EXISTING errors (`GateEditor.tsx`, `ProductEditor.tsx`) allowed.
- [ ] **Step 5:** Commit `feat(admin): transfer dispatch picks size; receive/detail show size`.

---

## Self-Review
- Floor stays per-flavour (deferred) — no migration touches the trigger. ✅
- All six transfer ledger sites + production post `variant_id ?? null`. ✅
- Legacy/in-flight transfers (NULL variant) remain balanced both legs. ✅
- Per-variant dispatch availability prevents overselling a size at dispatch (UX), even though the DB floor is still per-flavour. ✅

## Out of scope (later, separate)
- Re-enabling the per-size non-negative floor (after a one-time per-size recount of existing stock + verification).
- Offline POS per-size availability (Dexie schema + sync) — Phase 4.

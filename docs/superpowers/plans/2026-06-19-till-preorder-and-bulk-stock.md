# Till Preorder & Bulk Stock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three till changes — (1) 330ml sells instantly on the till when in stock (preorder only on out-of-stock), till-only; (2) move stock editing off the Sell page to a bulk adjust on the Stock page; (3) a branch-scoped preorder session on the till with full-text search and a nav count badge.

**Architecture:** Admin SPA (TanStack Router) talking to a Hono/Drizzle API over `/v1`. The till is the `/branch/*` route group rendered in `BranchShell`; availability comes from a server-authoritative `stock` snapshot (Dexie) layered with un-synced optimistic sale rows. Feature 1 changes the till sale route (`sales.ts`) and the cart's forced-preorder trigger; the public storefront route (`public-orders.ts`) is untouched so online keeps 330ml preorder-only. Feature 2 reuses the multi-item `/inventory/adjust` endpoint. Feature 3 adds a branch-scoped sibling of the owner preorder routes, gated on `pos.sell` and branch-locked, with shared fulfil logic.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Vitest + testcontainers (API); React, TanStack Router, Dexie/dexie-react-hooks (admin).

## Global Constraints

- Base branch: `feat/till-preorder-and-bulk-stock` (already created off `feat/pos-edit-branch-stock`). All work commits here.
- No DB migration. The `product_variant.preorder_only` column and seed stay unchanged.
- Capabilities are the source of truth — gate with `requireCapability` / `hasCapability`, never role strings. Reuse existing caps: `pos.sell` (Feature 3), `stock.adjust` (Feature 2). Do not add a new capability.
- API tests: Vitest integration tests under `apps/api/test/integration/`, using `setupTestDb`, `seedOwner`/`seedUser`, `loginAs` from `./helpers.js`. Full-suite runs can hit testcontainer beforeAll timeouts under load — run a single file alone to confirm green.
- Admin has no route-level test runner; verify admin changes with `pnpm --filter @ms/admin typecheck` + `pnpm --filter @ms/admin lint` and a manual till walkthrough. Existing tills need a PWA hard-refresh to load a new bundle.
- Quality gate before any "done" claim: 0 lint errors, clean typecheck, the touched API test file green.
- Commit messages end with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

## File Structure

**Feature 1 — till embargo (till-only):**
- Modify: `apps/api/src/routes/sales.ts` — drop the unconditional `preorderOnly → orderIsPreorder` forcing.
- Modify: `apps/api/test/integration/preorders.test.ts` — update the assertion that 330ml forces a preorder (now: only out-of-stock forces it on the till).
- Modify: `apps/admin/src/routes/branch/sell.tsx` — `forcedPreorder` derives from per-line availability, not `preorder_only`.

**Feature 2 — bulk stock adjust:**
- Modify: `apps/admin/src/lib/stock-adjust.ts` — add `adjustBranchStockBulk`.
- Modify: `apps/admin/src/routes/branch/stock.tsx` — bulk adjust mode.
- Modify: `apps/admin/src/routes/branch/sell.tsx` — remove the Edit-stock surface (button, `EditStockModal`, wiring).

**Feature 3 — branch preorder session:**
- Create: `apps/api/src/routes/preorder-shared.ts` — shared `listOpenPreorders` + `fulfilPreorderTx`.
- Modify: `apps/api/src/routes/preorders.ts` — owner route calls the shared helpers (behaviour unchanged).
- Create: `apps/api/src/routes/branch-preorders.ts` — branch-scoped GET + fulfil, gated `pos.sell`, branch-locked.
- Modify: `apps/api/src/test-app.ts` — register the branch preorder router.
- Create: `apps/api/test/integration/branch-preorders.test.ts` — branch isolation + staff access.
- Create: `apps/admin/src/routes/branch/preorders.tsx` — the till preorder page with search.
- Modify: `apps/admin/src/router.tsx` — register `/branch/preorders`.
- Modify: `apps/admin/src/components/BranchShell.tsx` — nav link + count badge.

---

## Task 1: Till route stops forcing preorder for `preorder_only` (Feature 1, server)

**Files:**
- Modify: `apps/api/src/routes/sales.ts:239-261`
- Test: `apps/api/test/integration/preorders.test.ts`

**Interfaces:**
- Consumes: existing `saleRoutes(db)` mounted at `/v1/branches/:branchId/sales`; request body field `is_preorder?: boolean` (forcePreorder).
- Produces: till sale behaviour — an in-stock line records `is_preorder=false` even when its variant is `preorder_only`; a line short of stock still flips the order to a preorder (unchanged).

- [ ] **Step 1: Update the existing assertion that 330ml forces a preorder**

In `apps/api/test/integration/preorders.test.ts`, find the test that posts an order containing the `preorder_only` 330ml variant **with stock on hand** and asserts `is_preorder === true`. The till no longer forces it. Change that case so the preorder-only product is seeded **with stock** and assert it is now an **instant sale**:

```ts
it("till: an in-stock preorder_only (330ml) line is an instant sale, not forced to preorder", async () => {
  // preorderProductId/preorderVariantId is the 330ml preorder_only variant.
  // Seed stock so it CAN be handed over at the counter.
  const { stockLedger } = await import("@ms/db");
  await db.insert(stockLedger).values({
    locationType: "branch",
    locationId: branchId,
    productId: preorderProductId,
    variantId: preorderVariantId,
    delta: 10,
    sourceType: "opening",
    sourceId: uuid(),
  });

  const res = await fetch(`${baseUrl}/v1/branches/${branchId}/sales`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookies, "idempotency-key": uuid() },
    body: JSON.stringify({
      channel: "walkup",
      payment_method: "cash",
      items: [{ variant_id: preorderVariantId, quantity: 1 }],
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { is_preorder: boolean } };
  expect(body.data.is_preorder).toBe(false);
});
```

> If the existing test seeds the preorder_only product with **zero** stock, keep a separate case asserting that an out-of-stock walk-up line still becomes a preorder only when `is_preorder:true` is sent (matches the unchanged out-of-stock branch). Do not delete coverage — adjust it to the new rule.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ms/api test -- preorders.test.ts -t "instant sale"`
Expected: FAIL — `is_preorder` is currently `true` because `preorderOnly` forces it.

- [ ] **Step 3: Remove the unconditional preorder_only forcing in the till route**

In `apps/api/src/routes/sales.ts`, the per-line block currently reads:

```ts
        if (preorderOnly) {
          orderIsPreorder = true;
        } else if (available < it.quantity) {
          // A deliberate till preorder (forcePreorder) is allowed to be short —
          // it's made to order. Otherwise an immediate-handover channel can't
          // give away absent stock, so it's still rejected.
          if (immediateHandover && !forcePreorder) {
            throw new BusinessError("conflict", "insufficient stock", 422, {
              product_id: productId,
              variant_id: variantId,
              available,
              requested: it.quantity,
            });
          }
          orderIsPreorder = true;
        }
```

Replace it so `preorderOnly` no longer forces a preorder on the till — only a stock shortfall (or the explicit `forcePreorder`) does. `preorderOnly` is now unused for flow control; keep reading it only if other code needs it, otherwise drop the variable read too:

```ts
        // The till treats every size the same: a line only becomes a preorder
        // when it can't be covered from stock (or the cashier explicitly took
        // the order as a preorder via is_preorder). preorder_only is a STOREFRONT
        // rule (see public-orders.ts) and is intentionally ignored here so an
        // in-stock 330ml sells instantly at the counter.
        if (available < it.quantity) {
          // An immediate-handover channel (walk-up / chowdeck pickup) can't give
          // away absent stock unless the cashier deliberately took it as a
          // made-to-order preorder.
          if (immediateHandover && !forcePreorder) {
            throw new BusinessError("conflict", "insufficient stock", 422, {
              product_id: productId,
              variant_id: variantId,
              available,
              requested: it.quantity,
            });
          }
          orderIsPreorder = true;
        }
```

Then remove the now-unused `preorderOnly` assignments (`let preorderOnly = false;` and the two `preorderOnly = v.preorderOnly;` lines) **only if** nothing else references `preorderOnly`. Verify with a grep before deleting; if the variable is referenced elsewhere in the handler, leave the reads in place.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ms/api test -- preorders.test.ts`
Expected: PASS (the updated in-stock case plus any retained out-of-stock case).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @ms/api typecheck
git add apps/api/src/routes/sales.ts apps/api/test/integration/preorders.test.ts
git commit -m "feat(pos): till sells in-stock 330ml instantly; preorder only on shortfall

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Cart forces preorder from out-of-stock, not from `preorder_only` (Feature 1, client)

**Files:**
- Modify: `apps/admin/src/routes/branch/sell.tsx`

**Interfaces:**
- Consumes: `localAvailableForVariant(branchId, productId, variantId): Promise<number>` from `db/local.js`; cart `CartLine[]`.
- Produces: `forcedPreorder` boolean = some cart line's available count `< line.quantity`. Drives the cashout preorder card (forces the toggle on + requires a delivery date), exactly as before but now keyed on stock instead of the size flag.

- [ ] **Step 1: Add a live availability map for the cart**

In `SellPage`, after the `cart` state and the `total`/`forcedPreorder` derivation, add a `useLiveQuery` that computes availability for each distinct variant in the cart. Place it near the other hooks (it must run on every render where the cart changes):

```tsx
  // Live per-variant availability for everything in the cart, so we can tell
  // when a line can't be covered from stock and the order must become a preorder.
  const cartVariantIds = cart.map((l) => l.variant_id).join(",");
  const availByVariant = useLiveQuery(
    async () => {
      const entries = await Promise.all(
        cart.map(
          async (l) =>
            [l.variant_id, await localAvailableForVariant(branchId, l.product_id, l.variant_id)] as const,
        ),
      );
      return Object.fromEntries(entries) as Record<string, number>;
    },
    [branchId, cartVariantIds],
    {} as Record<string, number>,
  );
```

- [ ] **Step 2: Derive `forcedPreorder` from shortfall, drop the `preorder_only` trigger**

Replace the existing lines:

```tsx
  // A 330ml (preorder_only) line forces the whole ticket to a preorder; the
  // cashier can also opt in for any other cans via the cashout toggle.
  const forcedPreorder = cart.some((l) => l.is_preorder);
  const orderIsPreorder = forcedPreorder || preorderChoice;
```

with:

```tsx
  // A line the branch can't cover from stock forces the whole ticket to a
  // preorder (made to order — paid now, fulfilled later). The cashier can also
  // opt any in-stock order in via the cashout toggle. preorder_only is no longer
  // a till trigger: an in-stock 330ml sells instantly (see sales.ts).
  const forcedPreorder = cart.some(
    (l) => (availByVariant[l.variant_id] ?? Infinity) < l.quantity,
  );
  const orderIsPreorder = forcedPreorder || preorderChoice;
```

> `?? Infinity` means "availability not loaded yet" never falsely forces a preorder; once the live query resolves, a real shortfall flips it.

- [ ] **Step 3: Stop tagging cart lines from `preorder_only`**

In `addToCart`, change the pushed line so `is_preorder` is no longer sourced from the variant flag (the field stays on the type for the receipt/back-compat but is always `false` at add time on the till):

```tsx
          is_preorder: false,
```

Update the forced-preorder hint copy in the cashout card so it reads on stock, not the size. Replace:

```tsx
              {forcedPreorder && (
                <span className="field__hint">
                  A 330ml can is in the cart — this order must be taken as a preorder.
                </span>
              )}
```

with:

```tsx
              {forcedPreorder && (
                <span className="field__hint">
                  An item in the cart is out of stock — this order must be taken as a preorder.
                </span>
              )}
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin lint`
Expected: clean (no unused-var error for the removed flag usage; if `is_preorder` on `CartLine` becomes entirely unused, leave the type field — it's still set and read in the receipt path).

- [ ] **Step 5: Manual smoke + commit**

Smoke (against a local stack or prod-mirroring data): with a 330ml that has stock, add it → cashout shows **Charge** (instant sale), no delivery-date requirement. Drop its stock to 0 (or add more than on hand) → cashout flips to **Take preorder** and demands a delivery date.

```bash
git add apps/admin/src/routes/branch/sell.tsx
git commit -m "feat(pos): cart forces preorder on stock shortfall, not on 330ml flag

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Bulk branch-stock adjust helper (Feature 2)

**Files:**
- Modify: `apps/admin/src/lib/stock-adjust.ts`

**Interfaces:**
- Consumes: `api` from `./api.js`, `resyncStock` from `../sync/engine.js`.
- Produces:
  - `interface BulkAdjustItem { productId: string; variantId: string | null; newQuantity: number; }`
  - `adjustBranchStockBulk(input: { branchId: string; reasonCode: string; reasonNote?: string; items: BulkAdjustItem[] }): Promise<void>` — posts ONE `/inventory/adjust` with all items, then `resyncStock(branchId)`.
  - Keeps existing `REASONS` and `adjustBranchStock` exports unchanged.

- [ ] **Step 1: Add the bulk helper**

Append to `apps/admin/src/lib/stock-adjust.ts` (reuse the existing single helper's pattern):

```ts
export interface BulkAdjustItem {
  productId: string;
  /** null targets the legacy untyped (variant-less) pool, mirroring the server. */
  variantId: string | null;
  newQuantity: number;
}

/**
 * Set absolute on-hand counts for MANY flavour+size rows at one branch in a
 * single audited adjustment. Same `/inventory/adjust` mutation as the single
 * helper — the endpoint already accepts an `items[]` array — then resyncs the
 * authoritative snapshot so the till's live availability reflects the new
 * counts immediately. Online-only (a correction must reach the server to be
 * authoritative). Caller renders its own inline errors (`silentError`).
 */
export async function adjustBranchStockBulk(input: {
  branchId: string;
  reasonCode: string;
  reasonNote?: string;
  items: BulkAdjustItem[];
}): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new Error("You're offline — connect to the internet to adjust stock.");
  }
  if (input.items.length === 0) return;
  const note = input.reasonNote?.trim();
  await api(
    "/inventory/adjust",
    {
      method: "POST",
      body: JSON.stringify({
        location_type: "branch",
        location_id: input.branchId,
        reason_code: input.reasonCode,
        ...(note ? { reason_note: note } : {}),
        items: input.items.map((i) => ({
          product_id: i.productId,
          variant_id: i.variantId,
          new_quantity: i.newQuantity,
        })),
      }),
    },
    { silentError: true },
  );
  await resyncStock(input.branchId);
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @ms/admin typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/lib/stock-adjust.ts
git commit -m "feat(stock): bulk branch-stock adjust helper (multi-item /inventory/adjust)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Bulk adjust mode on the branch Stock page (Feature 2)

**Files:**
- Modify: `apps/admin/src/routes/branch/stock.tsx`

**Interfaces:**
- Consumes: `adjustBranchStockBulk`, `REASONS`, `type BulkAdjustItem` from `../../lib/stock-adjust.js`; `useAuthUser` from `../../lib/auth.js`; `hasCapability` from `@ms/shared`; existing `rows` (per flavour+size, with `product_id`, `size_ml`, `balance`) and the `ServerBalance` fetch.
- Produces: an "Adjust stock" mode on the Stock page; saving posts a bulk adjust and refetches balances.

- [ ] **Step 1: Import the helper, auth, and capability check**

At the top of `stock.tsx`, add:

```tsx
import { useAuthUser } from "../../lib/auth.js";
import { hasCapability } from "@ms/shared";
import { adjustBranchStockBulk, REASONS, type BulkAdjustItem } from "../../lib/stock-adjust.js";
```

Keep `toast` (already imported).

- [ ] **Step 2: Add adjust-mode state and a refetch-able loader**

The current effect loads balances inline. Extract it into a `load()` callback so a successful save can refetch. Inside `BranchStockPage`, replace the existing `useEffect` that fetches balances with:

```tsx
  const user = useAuthUser();
  const canAdjust = hasCapability(user.capabilities, "stock.adjust");

  // Adjust mode: editable new-count drafts keyed by row key, a shared reason,
  // and a saving flag. Drafts start from the current balances when entering mode.
  const [adjusting, setAdjusting] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reasonCode, setReasonCode] = useState("physical_recount");
  const [reasonNote, setReasonNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api<{ data: ServerBalance[] }>(`/stock/branch/${branchId}`);
      setBalances(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);
```

Add `useCallback` to the React import: `import { useCallback, useEffect, useState } from "react";`.

- [ ] **Step 3: Add enter/cancel/save handlers**

After `rows` is computed (it needs `rows` for keys + variant ids), add:

```tsx
  function enterAdjust(): void {
    const seed: Record<string, string> = {};
    for (const r of rows) seed[r.key] = String(r.balance);
    setDrafts(seed);
    setReasonCode("physical_recount");
    setReasonNote("");
    setAdjusting(true);
  }

  function cancelAdjust(): void {
    setAdjusting(false);
    setDrafts({});
  }

  async function saveAdjust(): Promise<void> {
    // Only rows whose draft differs from the current balance and parses to a
    // non-negative integer become adjustment items. Unsized rows (variant_id
    // null) are skipped — they're a reconciliation concern, not a recount here.
    const items: BulkAdjustItem[] = [];
    for (const r of rows) {
      if (r.unsized) continue;
      const raw = drafts[r.key];
      if (raw == null || raw.trim() === "") continue;
      const next = Number(raw);
      if (!Number.isInteger(next) || next < 0) {
        toast.error(`Enter a whole number ≥ 0 for ${r.name} ${sizeLabel(r.size_ml)}.`);
        return;
      }
      if (next === r.balance) continue;
      const variantId = balances.find(
        (b) => b.product_id === r.product_id && sizeForVariant(b.variant_id) === r.size_ml,
      )?.variant_id ?? null;
      if (variantId == null) continue;
      items.push({ productId: r.product_id, variantId, newQuantity: next });
    }
    if (items.length === 0) {
      toast.error("No counts changed.");
      return;
    }
    if (reasonCode === "other_with_note" && reasonNote.trim().length === 0) {
      toast.error("Add a note for 'Other'.");
      return;
    }
    setSaving(true);
    try {
      await adjustBranchStockBulk({
        branchId,
        reasonCode,
        reasonNote: reasonNote.trim() || undefined,
        items,
      });
      toast.success(`Updated ${items.length} stock ${items.length === 1 ? "line" : "lines"}.`);
      setAdjusting(false);
      setDrafts({});
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(
        /would_go_negative|negative/i.test(msg) ? "A count would go below 0 — re-check and try again." : msg,
      );
    } finally {
      setSaving(false);
    }
  }
```

- [ ] **Step 4: Add the Adjust toolbar + reason controls, and make the On-hand cell editable in adjust mode**

In the JSX, add a toolbar between `<StatHero .../>` and the table (only when `canAdjust`):

```tsx
      {canAdjust && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "14px 0" }}>
          {!adjusting ? (
            <button type="button" className="btn btn--subtle btn--sm" onClick={enterAdjust} disabled={loading || rows.length === 0}>
              Adjust stock
            </button>
          ) : (
            <>
              <select className="select" style={{ maxWidth: 220 }} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} disabled={saving}>
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              {reasonCode === "other_with_note" && (
                <input className="input" style={{ maxWidth: 240 }} placeholder="Describe what happened" value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} disabled={saving} />
              )}
              <button type="button" className="btn btn--primary btn--sm" onClick={() => void saveAdjust()} disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </button>
              <button type="button" className="btn btn--subtle btn--sm" onClick={cancelAdjust} disabled={saving}>
                Cancel
              </button>
              <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                Enter new on-hand per size. Selling continues from the new count.
              </span>
            </>
          )}
        </div>
      )}
```

In the table body, replace the static On-hand `<td>` value with an input when `adjusting` and the row is sized:

```tsx
                    <td className="table__num" style={{ fontWeight: 800, color: /* keep existing tone color expr */ undefined }}>
                      {adjusting && !r.unsized ? (
                        <input
                          className="input"
                          type="number"
                          min={0}
                          inputMode="numeric"
                          value={drafts[r.key] ?? String(r.balance)}
                          onChange={(e) => setDrafts((d) => ({ ...d, [r.key]: e.target.value }))}
                          disabled={saving}
                          style={{ width: 84, textAlign: "right" }}
                        />
                      ) : (
                        r.balance
                      )}
                    </td>
```

> Keep the existing tone-based color on the static value; when an input is shown the color is irrelevant. Preserve the surrounding cell structure already in the file — only swap the inner value for the conditional.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin lint`
Expected: clean.

- [ ] **Step 6: Manual smoke + commit**

Smoke: as owner/manager open `/branch/stock` → "Adjust stock" → change two rows' counts → pick a reason → Save → counts update, toast shows "Updated 2 stock lines", then sell one of those flavours and confirm it deducts from the new count. As branch_staff, the "Adjust stock" button is absent.

```bash
git add apps/admin/src/routes/branch/stock.tsx
git commit -m "feat(stock): bulk adjust on the branch Stock page (set new on-hand per size)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Remove the Edit-stock surface from the Sell page (Feature 2)

**Files:**
- Modify: `apps/admin/src/routes/branch/sell.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SizePicker` becomes pick-only again; `EditStockModal`, the `canEdit`/`editTarget` state, the `onEdit` prop, and the `adjustBranchStock`/`REASONS` import (if only used by the removed modal) are deleted.

- [ ] **Step 1: Delete the Edit-stock state and modal render**

In `SellPage`, remove the `editTarget` state and the `<EditStockModal … />` JSX block (the one rendered alongside `SaleSuccessModal`). Remove the `canEdit` derivation (e.g. a `hasCapability(... "stock.adjust")` used only to show the button).

- [ ] **Step 2: Make `SizePicker` pick-only**

Remove the `canEdit`, `onEdit` props from `SizePicker`'s signature and props type, and delete the `{canEdit && (<button … Edit stock</button>)}` block. Restore each size row to the single pick `<button>` (the version on `feat/rich-notifications`): the row is itself the clickable `onPick` button, no nested edit button.

- [ ] **Step 3: Delete `EditStockModal` and unused imports**

Delete the entire `EditStockModal` function. Remove the import line `import { adjustBranchStock, REASONS } from "../../lib/stock-adjust.js";` **only if** neither symbol is used elsewhere in `sell.tsx` (grep first; the bulk page imports them separately, this file should no longer need them).

- [ ] **Step 4: Update the `SizePicker` call site**

Where `SellPage` renders `<SizePicker … />`, remove the `canEdit` and `onEdit` props so it matches the trimmed signature:

```tsx
      {picking && (
        <SizePicker
          flavour={picking}
          branchId={branchId}
          onPick={(s) => {
            addToCart(s);
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
```

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin lint`
Expected: clean (no unused imports/vars).

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/routes/branch/sell.tsx
git commit -m "refactor(pos): drop in-Sell stock editing (moved to Stock page bulk adjust)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Branch-scoped preorder API — shared logic + branch routes (Feature 3)

**Files:**
- Create: `apps/api/src/routes/preorder-shared.ts`
- Modify: `apps/api/src/routes/preorders.ts`
- Create: `apps/api/src/routes/branch-preorders.ts`
- Modify: `apps/api/src/test-app.ts:93-94`
- Test: `apps/api/test/integration/branch-preorders.test.ts`

**Interfaces:**
- Produces:
  - `listOpenPreorders(db: DbClient, opts: { branchId?: string }): Promise<PreorderListRow[]>` — open paid unfulfilled preorders (+ line items), optionally branch-filtered.
  - `fulfilPreorderTx(db, c, opts: { id: string; branchId?: string }): Promise<SaleOrderRow>` — the existing fulfil transaction, with an optional branch guard (404 when the order's branch ≠ `branchId`). Writes audit.
  - `branchPreorderRoutes(db: DbClient)` mounted at `/v1/branches/:branchId/preorders`, gated `pos.sell`, always passing the path `branchId` to the shared helpers.

- [ ] **Step 1: Write the failing branch-isolation test**

Create `apps/api/test/integration/branch-preorders.test.ts`. Model the harness on `preorders.test.ts` / `preorders-fulfil.test.ts`. Seed two branches, a `branch_staff` user (via `seedUser`), and a paid unfulfilled preorder at branch A. Assert:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { v4 as uuid } from "uuid";
import { setupTestDb, seedOwner, seedUser, loginAs } from "./helpers.js";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

describe("Branch-scoped preorder session", () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;
  let ownerCookies: string;
  let staffCookies: string;
  let server: ReturnType<typeof serve>;
  let branchA: string;
  let branchB: string;
  let preorderId: string;
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

  beforeAll(async () => {
    const tdb = await setupTestDb();
    container = tdb.container;
    db = tdb.db;
    await seedOwner(tdb.db);
    await seedUser(tdb.db, {
      email: "staff@example.com",
      password: "staffpassword123",
      role: "branch_staff",
    });
    const { buildApp } = await import("../../src/test-app.js");
    server = serve({ fetch: buildApp().fetch, port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://localhost:${addr.port}`;
    ownerCookies = await loginAs(baseUrl, "owner@example.com", "ownerpassword123");
    staffCookies = await loginAs(baseUrl, "staff@example.com", "staffpassword123");

    const mkBranch = async (name: string, code: string): Promise<string> => {
      const res = await fetch(`${baseUrl}/v1/branches`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookies, "idempotency-key": uuid() },
        body: JSON.stringify({ name, code }),
      });
      return ((await res.json()) as { data: { id: string } }).data.id;
    };
    branchA = await mkBranch("Branch A", "BRA");
    branchB = await mkBranch("Branch B", "BRB");

    // Create a product + take an explicit preorder at branch A (out of stock,
    // is_preorder:true, with a delivery date) so it lands paid+unfulfilled.
    const pRes = await fetch(`${baseUrl}/v1/products`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookies, "idempotency-key": uuid() },
      body: JSON.stringify({ name: "Mango", slug: "mango", category: "regular", initial_price_ngn: 1500 }),
    });
    const productId = ((await pRes.json()) as { data: { id: string } }).data.id;
    const { productVariant } = await import("@ms/db");
    const { eq } = await import("drizzle-orm");
    const [variant] = await db.select().from(productVariant).where(eq(productVariant.productId, productId));

    const saleRes = await fetch(`${baseUrl}/v1/branches/${branchA}/sales`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookies, "idempotency-key": uuid() },
      body: JSON.stringify({
        channel: "walkup",
        payment_method: "cash",
        is_preorder: true,
        scheduled_delivery_at: new Date(Date.now() + 86400000).toISOString(),
        items: [{ variant_id: variant!.id, quantity: 2 }],
      }),
    });
    const saleId = ((await saleRes.json()) as { data: { id: string } }).data.id;
    // Mark it paid (preorder must be status=paid to appear in the queue).
    await fetch(`${baseUrl}/v1/branches/${branchA}/sales/${saleId}/pay`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: ownerCookies, "idempotency-key": uuid() },
      body: JSON.stringify({ payment_method: "cash" }),
    });
    preorderId = saleId;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await container.stop();
  });

  it("branch staff can list their branch's open preorders", async () => {
    const res = await fetch(`${baseUrl}/v1/branches/${branchA}/preorders`, { headers: { cookie: staffCookies } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((o) => o.id === preorderId)).toBe(true);
  });

  it("a branch's queue never shows another branch's preorders", async () => {
    const res = await fetch(`${baseUrl}/v1/branches/${branchB}/preorders`, { headers: { cookie: staffCookies } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((o) => o.id === preorderId)).toBe(false);
  });

  it("fulfilling through the wrong branch is rejected", async () => {
    const res = await fetch(`${baseUrl}/v1/branches/${branchB}/preorders/${preorderId}/fulfil`, {
      method: "PATCH",
      headers: { cookie: staffCookies },
    });
    expect(res.status).toBe(404);
  });
});
```

> If `/sales/:id/pay` needs a different body, copy the exact shape from `preorders-fulfil.test.ts` (which already drives a preorder to paid). Match whatever that file does.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ms/api test -- branch-preorders.test.ts`
Expected: FAIL — route `/v1/branches/:branchId/preorders` does not exist yet (404 on the list call, body has no `data`).

- [ ] **Step 3: Extract shared helpers**

Create `apps/api/src/routes/preorder-shared.ts` by moving the list query and fulfil transaction out of `preorders.ts`. Add an optional `branchId` guard:

```ts
import type { Context } from "hono";
import { eq, and, desc, isNull } from "drizzle-orm";
import {
  saleOrder,
  saleOrderItem,
  stockLedger,
  outboxEvent,
  customer,
  product,
  productVariant,
  type DbClient,
} from "@ms/db";
import { availableAtBranch } from "@ms/domain";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

const COUNTER_CHANNELS = new Set(["walkup", "whatsapp", "chowdeck_pickup"]);

/** Open (paid, unfulfilled) preorders with line items, optionally branch-locked. */
export async function listOpenPreorders(
  db: DbClient,
  opts: { branchId?: string } = {},
): Promise<unknown[]> {
  const conds = [
    eq(saleOrder.isPreorder, true),
    eq(saleOrder.status, "paid"),
    isNull(saleOrder.fulfilledAt),
  ];
  if (opts.branchId) conds.push(eq(saleOrder.branchId, opts.branchId));

  const orders = await db
    .select({
      id: saleOrder.id,
      order_number: saleOrder.orderNumber,
      branch_id: saleOrder.branchId,
      channel: saleOrder.channel,
      status: saleOrder.status,
      total_ngn: saleOrder.totalNgn,
      scheduled_delivery_at: saleOrder.scheduledDeliveryAt,
      created_at_local: saleOrder.createdAtLocal,
      customer_name: customer.name,
      customer_phone: customer.phone,
    })
    .from(saleOrder)
    .leftJoin(customer, eq(customer.id, saleOrder.customerId))
    .where(and(...conds))
    .orderBy(desc(saleOrder.createdAtLocal))
    .limit(200);

  const out: unknown[] = [];
  for (const o of orders) {
    const items = await db
      .select({
        product_id: saleOrderItem.productId,
        variant_id: saleOrderItem.variantId,
        name: product.name,
        size_ml: productVariant.sizeMl,
        quantity: saleOrderItem.quantity,
        unit_price_ngn: saleOrderItem.unitPriceNgn,
      })
      .from(saleOrderItem)
      .leftJoin(product, eq(product.id, saleOrderItem.productId))
      .leftJoin(productVariant, eq(productVariant.id, saleOrderItem.variantId))
      .where(eq(saleOrderItem.saleOrderId, o.id));
    out.push({ ...o, items });
  }
  return out;
}

/**
 * Fulfil a preorder: deduct stock now, hand the order onward. When `branchId`
 * is given, the order must belong to that branch (else 404) — this is how the
 * till is locked to its own queue.
 */
export async function fulfilPreorderTx(
  db: DbClient,
  c: Context,
  opts: { id: string; branchId?: string },
): Promise<Record<string, unknown>> {
  const { id } = opts;
  const auth = c.get("auth");

  const result = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
    if (!o) throw new BusinessError("not_found", "preorder not found", 404);
    if (opts.branchId && o.branchId !== opts.branchId) {
      throw new BusinessError("not_found", "preorder not found", 404);
    }
    if (!o.isPreorder) throw new BusinessError("conflict", "order is not a preorder", 409);
    if (o.fulfilledAt) throw new BusinessError("conflict", "preorder already fulfilled", 409);
    if (o.status !== "paid") throw new BusinessError("conflict", `cannot fulfil from ${o.status}`, 409);

    const items = await tx.select().from(saleOrderItem).where(eq(saleOrderItem.saleOrderId, id));

    const wantByProduct = new Map<string, number>();
    for (const it of items) {
      wantByProduct.set(it.productId, (wantByProduct.get(it.productId) ?? 0) + it.quantity);
    }
    const shortfalls: Array<{ product_id: string; needed: number; available: number }> = [];
    for (const [productId, needed] of wantByProduct) {
      const available = await availableAtBranch(tx, { branchId: o.branchId, productId });
      if (available < needed) shortfalls.push({ product_id: productId, needed, available });
    }
    if (shortfalls.length > 0) {
      throw new BusinessError("conflict", "not enough stock to fulfil this preorder", 422, {
        code: "preorder_unfulfillable",
        shortfalls,
      });
    }

    for (const it of items) {
      await tx.insert(stockLedger).values({
        locationType: "branch",
        locationId: o.branchId,
        productId: it.productId,
        variantId: it.variantId ?? null,
        delta: -it.quantity,
        sourceType: "sale",
        sourceId: id,
        recordedByUserId: auth.userId,
        note: `Preorder fulfil ${o.orderNumber}`,
      });
    }

    const toCounter = COUNTER_CHANNELS.has(o.channel);
    const [u] = await tx
      .update(saleOrder)
      .set({
        status: toCounter ? "handed_over" : o.status,
        fulfilledAt: new Date(),
        fulfilledByUserId: auth.userId,
        updatedAt: new Date(),
      })
      .where(eq(saleOrder.id, id))
      .returning();
    if (!u) throw new BusinessError("internal_error", "fulfil update returned no rows", 500);

    if (!toCounter) {
      await tx.insert(outboxEvent).values({
        eventType: "delivery.request",
        payload: { sale_order_id: id, order_number: o.orderNumber, branch_id: o.branchId },
      });
    }
    await tx.insert(outboxEvent).values({
      eventType: "sale.preorder_fulfilled",
      payload: { sale_order_id: id, order_number: o.orderNumber, branch_id: o.branchId, channel: o.channel },
    });
    return u;
  });

  await writeAudit(db, c, {
    action: "preorder.fulfil",
    entityType: "sale_order",
    entityId: id,
    after: result,
  });
  return result;
}
```

- [ ] **Step 4: Rewrite `preorders.ts` to use the shared helpers (owner behaviour unchanged)**

Replace the bodies in `apps/api/src/routes/preorders.ts` so it delegates:

```ts
import { Hono } from "hono";
import { type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { BusinessError } from "../lib/errors.js";
import { listOpenPreorders, fulfilPreorderTx } from "./preorder-shared.js";

export function preorderRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/", requireCapability("orders.manage"), async (c) => {
    const branchId = c.req.query("branch_id");
    const data = await listOpenPreorders(db, branchId ? { branchId } : {});
    return c.json({ data });
  });

  r.patch("/:id/fulfil", requireCapability("orders.manage"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const data = await fulfilPreorderTx(db, c, { id });
    return c.json({ data });
  });

  return r;
}
```

- [ ] **Step 5: Create the branch-scoped router**

Create `apps/api/src/routes/branch-preorders.ts`:

```ts
import { Hono } from "hono";
import { type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { BusinessError } from "../lib/errors.js";
import { listOpenPreorders, fulfilPreorderTx } from "./preorder-shared.js";

/**
 * Till-facing preorder queue, mounted at /v1/branches/:branchId/preorders.
 * Gated on pos.sell (so a branch_staff till operator qualifies) and locked to
 * the path branch — a till can only see and fulfil ITS OWN branch's preorders.
 */
export function branchPreorderRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  r.get("/", requireCapability("pos.sell"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const data = await listOpenPreorders(db, { branchId });
    return c.json({ data });
  });

  r.patch("/:id/fulfil", requireCapability("pos.sell"), async (c) => {
    const branchId = c.req.param("branchId");
    const id = c.req.param("id");
    if (!branchId || !id) throw new BusinessError("validation_failed", "branchId and id required", 400);
    const data = await fulfilPreorderTx(db, c, { id, branchId });
    return c.json({ data });
  });

  return r;
}
```

> Hono note: the `:branchId` param from the mount path is readable via `c.req.param("branchId")` inside the sub-router, exactly as `saleRoutes` reads it today.

- [ ] **Step 6: Register the router**

In `apps/api/src/test-app.ts`, add the import and mount line next to the other branch routes:

```ts
import { branchPreorderRoutes } from "./routes/branch-preorders.js";
```

```ts
  app.route("/v1/branches/:branchId/preorders", branchPreorderRoutes(db));
```

- [ ] **Step 7: Run the new test + the owner regression test**

Run: `pnpm --filter @ms/api test -- branch-preorders.test.ts`
Expected: PASS (all three cases).
Run: `pnpm --filter @ms/api test -- preorders-fulfil.test.ts`
Expected: PASS (owner fulfil still works through the refactored helper).

- [ ] **Step 8: Typecheck + commit**

```bash
pnpm --filter @ms/api typecheck
git add apps/api/src/routes/preorder-shared.ts apps/api/src/routes/preorders.ts apps/api/src/routes/branch-preorders.ts apps/api/src/test-app.ts apps/api/test/integration/branch-preorders.test.ts
git commit -m "feat(api): branch-scoped preorder queue (pos.sell, branch-locked)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Till preorder page with full-field search (Feature 3, client)

**Files:**
- Create: `apps/admin/src/routes/branch/preorders.tsx`
- Modify: `apps/admin/src/router.tsx`

**Interfaces:**
- Consumes: `GET /v1/branches/:branchId/preorders`, `PATCH /v1/branches/:branchId/preorders/:id/fulfil` via `api`; `BranchShell`, `StatHero`, `InlineLoader`, `toast`, `ngn`, `formatDateTime`, `useAuthUser`, `buildReceiptFromOrder`, `getReceiptStyle`, `fetchBranchInfo`, `printAndToast` (same imports the owner page uses).
- Produces: `BranchPreordersPage({ branchId }: { branchId: string }): JSX.Element` (named export, for `lazyNamed`).

- [ ] **Step 1: Create the page**

Create `apps/admin/src/routes/branch/preorders.tsx` — a branch-scoped sibling of `owner/preorders.tsx` in `BranchShell`, with a search box that matches **every recorded field**:

```tsx
import { useEffect, useMemo, useState } from "react";
import { BranchShell } from "../../components/BranchShell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import { StatHero } from "../../components/StatHero.js";
import { useAuthUser } from "../../lib/auth.js";
import { buildReceiptFromOrder } from "../../lib/receipt-data.js";
import { getReceiptStyle } from "../../lib/receipt-settings.js";
import { fetchBranchInfo, printAndToast } from "../../lib/reprint.js";

interface PreorderItem {
  product_id: string;
  variant_id: string | null;
  name: string | null;
  size_ml: number | null;
  quantity: number;
  unit_price_ngn: number;
}

interface Preorder {
  id: string;
  order_number: string;
  branch_id: string;
  channel: string;
  status: string;
  total_ngn: number;
  scheduled_delivery_at: string | null;
  created_at_local: string;
  customer_name: string | null;
  customer_phone: string | null;
  items: PreorderItem[];
}

const sizeLabel = (ml: number | null): string =>
  ml == null ? "" : ml >= 1000 ? `${ml / 1000}L` : `${ml}ml`;

const itemsSummary = (items: PreorderItem[]): string =>
  items
    .map((i) => `${i.quantity}× ${i.name ?? "?"}${i.size_ml ? ` ${sizeLabel(i.size_ml)}` : ""}`)
    .join(", ");

// A single searchable haystack across every recorded field of a preorder:
// order number, customer name/phone, channel, target day, total, and each
// item's flavour + size. Lowercased so the search box is case-insensitive.
function haystack(o: Preorder): string {
  return [
    o.order_number,
    o.customer_name ?? "",
    o.customer_phone ?? "",
    o.channel,
    o.scheduled_delivery_at ? formatDateTime(o.scheduled_delivery_at) : "",
    formatDateTime(o.created_at_local),
    String(o.total_ngn),
    ngn(o.total_ngn),
    itemsSummary(o.items),
  ]
    .join(" ")
    .toLowerCase();
}

export function BranchPreordersPage({ branchId }: { branchId: string }): JSX.Element {
  const [rows, setRows] = useState<Preorder[]>([]);
  const [loading, setLoading] = useState(true);
  const [fulfilling, setFulfilling] = useState<string | null>(null);
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const authUser = useAuthUser();

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: Preorder[] }>(`/branches/${branchId}/preorders`);
      setRows(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  async function printPreorder(o: Preorder): Promise<void> {
    setPrintingId(o.id);
    try {
      const branch = await fetchBranchInfo(o.branch_id);
      const receipt = buildReceiptFromOrder({
        style: getReceiptStyle(),
        orderNumber: o.order_number,
        createdAtIso: o.created_at_local,
        branch,
        servedBy: (authUser.email.split("@")[0] || authUser.role).replace(/[._]/g, " "),
        channel: o.channel,
        payment: "prepaid",
        items: o.items.map((i) => ({
          name: i.name ?? "Item",
          sizeMl: i.size_ml,
          quantity: i.quantity,
          unitPriceNgn: i.unit_price_ngn,
          lineTotalNgn: i.unit_price_ngn * i.quantity,
        })),
        subtotalNgn: o.total_ngn,
        totalNgn: o.total_ngn,
        isPreorder: true,
        ...(o.scheduled_delivery_at ? { fulfilIso: o.scheduled_delivery_at } : {}),
      });
      await printAndToast(receipt);
    } finally {
      setPrintingId(null);
    }
  }

  async function fulfil(o: Preorder): Promise<void> {
    if (!window.confirm(`Fulfil ${o.order_number}? This deducts stock now and hands the order over.`)) {
      return;
    }
    setFulfilling(o.id);
    try {
      await api(`/branches/${branchId}/preorders/${o.id}/fulfil`, { method: "PATCH" }, { silentError: true });
      toast.success(`${o.order_number} fulfilled`);
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(
        /unfulfillable|not enough stock/i.test(msg)
          ? `Not enough stock to fulfil ${o.order_number} yet — produce/transfer more first.`
          : msg,
      );
    } finally {
      setFulfilling(null);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((o) => haystack(o).includes(q));
  }, [rows, search]);

  const total = useMemo(() => filtered.reduce((sum, r) => sum + r.total_ngn, 0), [filtered]);

  return (
    <BranchShell branchId={branchId} title="Preorders">
      <StatHero
        eyebrow="Branch"
        title="Preorders"
        sub="Prepaid orders awaiting production at this branch. Stock is deducted when you fulfil."
        loading={loading}
        chips={[
          { label: "Awaiting", value: rows.length, tone: rows.length > 0 ? "danger" : "good" },
          { label: "Cans", value: rows.reduce((s, r) => s + r.items.reduce((n, i) => n + i.quantity, 0), 0) },
          { label: "Prepaid", value: ngn(rows.reduce((s, r) => s + r.total_ngn, 0)) },
        ]}
      />

      <input
        className="input"
        placeholder="Search order #, name, phone, flavour, date…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ margin: "14px 0" }}
      />

      {loading ? (
        <InlineLoader />
      ) : filtered.length === 0 ? (
        <div className="empty">
          <div className="empty__title">{rows.length === 0 ? "No preorders waiting" : "No matches"}</div>
          {rows.length === 0
            ? "Paid preorders that haven't been fulfilled yet show up here."
            : "Try a different order number, name, phone, or flavour."}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Order #</th>
                <th>Placed</th>
                <th>Customer</th>
                <th>Items</th>
                <th>Target day</th>
                <th className="table__num">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr key={o.id}>
                  <td style={{ fontWeight: 600 }}>{o.order_number}</td>
                  <td>{formatDateTime(o.created_at_local)}</td>
                  <td>
                    {o.customer_name ?? "Walk-up"}
                    {o.customer_phone && (
                      <span style={{ color: "var(--ink-soft)", fontSize: 12, display: "block" }}>
                        {o.customer_phone}
                      </span>
                    )}
                  </td>
                  <td style={{ maxWidth: 280 }}>{itemsSummary(o.items)}</td>
                  <td>
                    {o.scheduled_delivery_at ? (
                      formatDateTime(o.scheduled_delivery_at)
                    ) : (
                      <span style={{ color: "var(--ink-soft)" }}>—</span>
                    )}
                  </td>
                  <td className="table__num" style={{ fontWeight: 700 }}>{ngn(o.total_ngn)}</td>
                  <td className="table__num">
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      disabled={printingId === o.id}
                      onClick={() => void printPreorder(o)}
                      style={{ marginRight: 6 }}
                      title="Print receipt"
                    >
                      {printingId === o.id ? "…" : "🖨"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={fulfilling === o.id}
                      onClick={() => void fulfil(o)}
                    >
                      {fulfilling === o.id ? "Fulfilling…" : "Fulfil"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 12 }}>
            {filtered.length} preorder{filtered.length === 1 ? "" : "s"} · {ngn(total)} prepaid
          </p>
        </div>
      )}
    </BranchShell>
  );
}
```

> Verify the `StatHero` chip `tone` values (`"danger"`/`"good"`) and `buildReceiptFromOrder` field names against `owner/preorders.tsx` — they must match exactly (that file is the reference). If `api`'s third `silentError` arg differs, copy the owner page's call signature.

- [ ] **Step 2: Register the route**

In `apps/admin/src/router.tsx`:

1. Add the lazy component near the other branch imports:

```tsx
const BranchPreordersPage = lazyNamed<{ branchId: string }>(
  () => import("./routes/branch/preorders.js"),
  "BranchPreordersPage",
);
```

2. Add the route definition next to `branchStockRoute`:

```tsx
const branchPreordersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/preorders",
  component: () =>
    guarded(<L><WithBranchId render={(id) => <BranchPreordersPage branchId={id} />} /></L>),
});
```

3. Add `branchPreordersRoute` to the `routeTree` children array (where `branchStockRoute` is listed).

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/routes/branch/preorders.tsx apps/admin/src/router.tsx
git commit -m "feat(pos): till preorder session with full-field search

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Preorders nav link + awaiting-fulfilment count badge (Feature 3)

**Files:**
- Modify: `apps/admin/src/components/BranchShell.tsx`

**Interfaces:**
- Consumes: `GET /v1/branches/:branchId/preorders` (count of returned rows); existing `NAV` rendering.
- Produces: a "Preorders" nav item gated `pos.sell` with a numeric badge of open preorders; badge hidden at zero; refreshed on mount, on an interval, and when the window regains focus.

- [ ] **Step 1: Add the nav entry**

In `apps/admin/src/components/BranchShell.tsx`, add to the `NAV` array (after the Stock entry):

```tsx
  { to: "/branch/preorders", label: "Preorders", icon: "📅", cap: "pos.sell" },
```

- [ ] **Step 2: Fetch the open-preorder count in `BranchShell`**

Inside `BranchShell`, add state + a polling effect (place near the existing `branchName` effect):

```tsx
  const [preorderCount, setPreorderCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      try {
        const res = await fetch(`/v1/branches/${branchId}/preorders`, { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as { data: unknown[] };
        if (!cancelled) setPreorderCount(Array.isArray(body.data) ? body.data.length : 0);
      } catch {
        /* offline or no access — leave the last known count */
      }
    }
    void refresh();
    const id = window.setInterval(() => void refresh(), 60_000);
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [branchId]);
```

- [ ] **Step 3: Render the badge on the Preorders link**

In the `NAV.filter(...).map(...)` render, show a badge when the item is Preorders and the count > 0. Replace the `<span>{item.label}</span>` line with a label that conditionally appends a badge:

```tsx
              <span>{item.label}</span>
              {item.to === "/branch/preorders" && preorderCount > 0 && (
                <span
                  className="pill pill--danger"
                  style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, minWidth: 20, textAlign: "center" }}
                  aria-label={`${preorderCount} preorders awaiting fulfilment`}
                >
                  {preorderCount}
                </span>
              )}
```

> If the existing `.app-nav__link` doesn't lay out a trailing element well, wrap the icon+label+badge so the badge sits at the row's end (`marginLeft: "auto"` pushes it right within the flex link). Keep it visually consistent with the `SyncBadge` pills already used in this file.

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin lint`
Expected: clean.

- [ ] **Step 5: Manual smoke + commit**

Smoke: take a preorder at the till (out-of-stock item or manual toggle) → the "Preorders" nav badge shows the count; open the page, fulfil it → badge decrements/disappears within a minute (or immediately on the page's own refetch). As a branch_staff login the link is visible and works.

```bash
git add apps/admin/src/components/BranchShell.tsx
git commit -m "feat(pos): Preorders nav link with awaiting-fulfilment count badge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `pnpm --filter @ms/api typecheck && pnpm --filter @ms/admin typecheck` — clean.
- [ ] `pnpm --filter @ms/admin lint` — 0 errors.
- [ ] `pnpm --filter @ms/api test -- preorders.test.ts` — green (Feature 1 rule).
- [ ] `pnpm --filter @ms/api test -- branch-preorders.test.ts` — green (Feature 3 isolation).
- [ ] `pnpm --filter @ms/api test -- preorders-fulfil.test.ts` — green (owner regression after refactor).
- [ ] Manual till walkthrough: in-stock 330ml = instant sale; OOS = forced preorder; Stock-page bulk adjust updates counts and selling continues from the new count; Sell page has no Edit-stock; till Preorders page searchable by order # / name / phone / flavour; nav badge counts awaiting preorders; branch isolation holds.
- [ ] Note for rollout: existing tills need a PWA hard-refresh to load the new bundle.

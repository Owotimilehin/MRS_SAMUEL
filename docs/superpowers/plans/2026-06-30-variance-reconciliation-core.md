# Variance Reconciliation & Loss Tracking (Core) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make stock variance reconcile with physical reality — owner-settled transfer variance (Factory/Branch/Loss per flavour) and shift-close on-hand reconciliation — and record every genuine loss as a durable `variance_loss` row (bottles + ₦ at retail price).

**Architecture:** Append-only `stock_ledger` already records every stock movement; reconciliation = inserting balancing ledger rows (never mutating). A new `variance_loss` table captures write-offs valued at the variant's current retail price (`product_price.priceNgn`), snapshotted at record time. Transfer settlement is gated to a new owner-only `variance.settle` capability; shift-close reconciliation is automatic (staff physically counted, reason already mandatory).

**Tech Stack:** Hono + Drizzle (Postgres) API, TanStack React admin, Vitest. Money in integer kobo-free naira (`*_ngn` integers).

## Global Constraints

- Stock ledger is **append-only**: app DB user has INSERT+SELECT only; never UPDATE/DELETE ledger rows. Reconcile by inserting balancing rows.
- A deferred AFTER-INSERT trigger **rejects any insert that would drive a location's running balance negative** (`check_violation`). Branch/Loss settlement of an over-receive can hit this — handle as a `BusinessError`, not a 500.
- All money is integer naira in `*_ngn` columns. Loss value = `quantity * priceNgn`, snapshotted.
- New ledger source type added by `ALTER TYPE ledger_source_type ADD VALUE`; reuse existing `count_correction` for shift reconcile (no new value needed there).
- Migration is `0060`; its `meta/_journal.json` `when` MUST be greater than 0059's (a too-low timestamp silently skips the migration — prior prod incident). Generate with `pnpm --filter @ms/db drizzle-kit generate` then hand-add the trigger-safe SQL, or hand-number carefully and verify the journal.
- Owner-only = add capability to `CAPABILITIES` but NOT to `ADMIN_CAPS`/`MANAGER_CAPS`/`BRANCH_STAFF_CAPS`; `owner` gets it via `owner: [...CAPABILITIES]`.
- Lagos timezone for any date scoping. Run integration tests with `TZ=UTC` (repo convention).

---

### Task 1: `variance_loss` schema + migration

**Files:**
- Create: `packages/db/src/schema/variance-loss.ts`
- Modify: `packages/db/src/schema/index.ts` (export new table)
- Modify: `packages/db/src/schema/stock-ledger.ts:8-20` (add `transfer_variance_settlement` enum value)
- Create: `packages/db/migrations/0060_variance_loss.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (new entry, `when` > 0059)

**Interfaces:**
- Produces: `varianceLoss` table with columns `id, source, sourceId, branchId, productId, variantId, sizeMl, quantity, unitPriceNgn, valueNgn, reason, recordedByUserId, occurredAt`. `source` is one of `'transfer' | 'shift_close'`.
- Produces: ledger source type `'transfer_variance_settlement'`.

- [ ] **Step 1: Write the schema file**

```ts
// packages/db/src/schema/variance-loss.ts
import { pgTable, uuid, integer, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { product } from "./product.js";
import { productVariant } from "./product-variant.js";
import { branch } from "./branch.js";
import { adminUser } from "./admin-user.js";

export const varianceLossSource = pgEnum("variance_loss_source", ["transfer", "shift_close"]);

/** One durable record per genuine stock loss (write-off), valued at retail. */
export const varianceLoss = pgTable(
  "variance_loss",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: varianceLossSource("source").notNull(),
    sourceId: uuid("source_id").notNull(),
    branchId: uuid("branch_id").notNull().references(() => branch.id),
    productId: uuid("product_id").notNull().references(() => product.id),
    variantId: uuid("variant_id").references(() => productVariant.id),
    sizeMl: integer("size_ml"),
    quantity: integer("quantity").notNull(), // bottles lost, positive
    unitPriceNgn: integer("unit_price_ngn").notNull(), // retail snapshot
    valueNgn: integer("value_ngn").notNull(), // quantity * unitPriceNgn
    reason: text("reason"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => adminUser.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxOccurred: index("idx_variance_loss_occurred").on(t.occurredAt),
    idxBranchOccurred: index("idx_variance_loss_branch_occurred").on(t.branchId, t.occurredAt),
  }),
);
```

- [ ] **Step 2: Add the ledger enum value**

In `packages/db/src/schema/stock-ledger.ts`, add `"transfer_variance_settlement"` to the `ledgerSourceType` array (after `"count_correction"`).

- [ ] **Step 3: Export from index**

In `packages/db/src/schema/index.ts`, add `export * from "./variance-loss.js";` alongside the other schema exports.

- [ ] **Step 4: Generate + finalize migration**

Run: `pnpm --filter @ms/db drizzle-kit generate`
Then confirm `0060_*.sql` contains: `CREATE TYPE "variance_loss_source"`, `CREATE TABLE "variance_loss"`, the two indexes, and `ALTER TYPE "ledger_source_type" ADD VALUE 'transfer_variance_settlement'`. Rename the file to `0060_variance_loss.sql` if needed and verify the `meta/_journal.json` entry's `when` is greater than 0059's.

- [ ] **Step 5: Apply + verify**

Run: `pnpm --filter @ms/db migrate` (against local/dev DB)
Expected: applies cleanly; `\d variance_loss` shows the table.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/variance-loss.ts packages/db/src/schema/index.ts packages/db/src/schema/stock-ledger.ts packages/db/migrations/0060_variance_loss.sql packages/db/migrations/meta/_journal.json packages/db/migrations/meta/0060_snapshot.json
git commit -m "feat(db): variance_loss table + transfer_variance_settlement ledger source (0060)"
```

---

### Task 2: `variance.settle` owner-only capability

**Files:**
- Modify: `packages/shared/src/permissions.ts:4-50` (add to `CAPABILITIES`)
- Modify: `packages/shared/src/permissions.test.ts` (assert owner-only)

**Interfaces:**
- Produces: capability literal `"variance.settle"`, granted only to `owner`.

- [ ] **Step 1: Write the failing test**

```ts
// in packages/shared/src/permissions.test.ts
import { resolveCapabilities } from "./permissions.js";

test("variance.settle is owner-only", () => {
  expect(resolveCapabilities("owner")).toContain("variance.settle");
  expect(resolveCapabilities("admin")).not.toContain("variance.settle");
  expect(resolveCapabilities("manager")).not.toContain("variance.settle");
  expect(resolveCapabilities("branch_staff")).not.toContain("variance.settle");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/shared test -- permissions`
Expected: FAIL — `"variance.settle"` not in owner caps.

- [ ] **Step 3: Add the capability**

In `packages/shared/src/permissions.ts`, add `"variance.settle",` to the `CAPABILITIES` array (place it near `transfers.adjust`, with a comment: `// owner-only: settle transfer variance to factory/branch/loss`). Do NOT add it to `ADMIN_CAPS`, `MANAGER_CAPS`, or `BRANCH_STAFF_CAPS`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/shared test -- permissions`
Expected: PASS. Then `pnpm --filter @ms/shared build` so `dist` types update for the API.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/permissions.ts packages/shared/src/permissions.test.ts
git commit -m "feat(auth): add owner-only variance.settle capability"
```

---

### Task 3: Loss-recording domain helper

**Files:**
- Create: `packages/domain/src/variance-loss.ts`
- Modify: `packages/domain/src/index.ts` (export)
- Create: `packages/domain/src/variance-loss.test.ts`

**Interfaces:**
- Consumes: a Drizzle transaction (`tx`), `varianceLoss`, `productPrice` from `@ms/db`.
- Produces:
  ```ts
  async function recordVarianceLoss(tx, input: {
    source: "transfer" | "shift_close";
    sourceId: string;
    branchId: string;
    productId: string;
    variantId: string | null;
    sizeMl: number | null;
    quantity: number;       // bottles lost, positive
    reason: string | null;
    recordedByUserId: string;
  }): Promise<{ id: string; valueNgn: number }>
  ```
  Looks up retail price for the variant, snapshots `unitPriceNgn`, computes `valueNgn = quantity * unitPriceNgn`, inserts a `variance_loss` row.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/src/variance-loss.test.ts
import { describe, it, expect } from "vitest";
import { computeLossValue } from "./variance-loss.js";

describe("computeLossValue", () => {
  it("values loss at quantity * retail price", () => {
    expect(computeLossValue(5, 3500)).toBe(17500);
  });
  it("is zero when nothing lost", () => {
    expect(computeLossValue(0, 3500)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/domain test -- variance-loss`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

```ts
// packages/domain/src/variance-loss.ts
import { eq } from "drizzle-orm";
import { varianceLoss, productPrice } from "@ms/db";

/** Pure: money value of a loss. */
export function computeLossValue(quantity: number, unitPriceNgn: number): number {
  return quantity * unitPriceNgn;
}

export interface RecordVarianceLossInput {
  source: "transfer" | "shift_close";
  sourceId: string;
  branchId: string;
  productId: string;
  variantId: string | null;
  sizeMl: number | null;
  quantity: number;
  reason: string | null;
  recordedByUserId: string;
}

/** Snapshot the variant's current retail price and insert one loss row. */
export async function recordVarianceLoss(
  tx: any,
  input: RecordVarianceLossInput,
): Promise<{ id: string; valueNgn: number }> {
  let unitPriceNgn = 0;
  if (input.variantId) {
    const [p] = await tx
      .select({ priceNgn: productPrice.priceNgn })
      .from(productPrice)
      .where(eq(productPrice.variantId, input.variantId))
      .limit(1);
    unitPriceNgn = p?.priceNgn ?? 0;
  }
  const valueNgn = computeLossValue(input.quantity, unitPriceNgn);
  const [row] = await tx
    .insert(varianceLoss)
    .values({
      source: input.source,
      sourceId: input.sourceId,
      branchId: input.branchId,
      productId: input.productId,
      variantId: input.variantId,
      sizeMl: input.sizeMl,
      quantity: input.quantity,
      unitPriceNgn,
      valueNgn,
      reason: input.reason,
      recordedByUserId: input.recordedByUserId,
    })
    .returning({ id: varianceLoss.id });
  return { id: row.id, valueNgn };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/domain test -- variance-loss`
Expected: PASS (the pure `computeLossValue` test; `recordVarianceLoss` is covered by integration tests in Tasks 4 & 6).

- [ ] **Step 5: Export + commit**

Add `export * from "./variance-loss.js";` to `packages/domain/src/index.ts`.

```bash
git add packages/domain/src/variance-loss.ts packages/domain/src/variance-loss.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): recordVarianceLoss helper (retail valuation)"
```

---

### Task 4: Transfer variance settlement API

**Files:**
- Modify: `apps/api/src/routes/transfers.ts:515-538` (replace the `/:id/approve` handler)
- Create: `apps/api/test/integration/transfer-variance-settle.test.ts`

**Interfaces:**
- Consumes: `recordVarianceLoss` (Task 3), `varianceLoss`, `stockLedger`, `requireCapability` from existing imports.
- Produces: `PATCH /v1/transfers/:id/approve` accepting `{ settlements: Array<{ item_id: string; settle: "factory" | "branch" | "loss" }> }`.

Behaviour: transfer must be `received_with_variance`. For each transfer item where `quantitySent !== quantityReceived`, the matching settlement is required. `gap = quantitySent - quantityReceived`. For `factory`/`branch`: insert a `stock_ledger` row `{ locationType: settle, locationId: factoryId|branchId, delta: gap, sourceType: "transfer_variance_settlement", sourceId: transfer.id, note }`. For `loss`: call `recordVarianceLoss({ source: "transfer", quantity: Math.abs(gap) ... })` (loss only meaningful when `gap > 0`; if `gap < 0`, a "loss" choice is rejected with a `BusinessError` — you can't write off bottles that arrived extra). Then set status `completed`. Gate with `requireCapability("variance.settle")`.

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/test/integration/transfer-variance-settle.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { makeTestApp, seedOwner, seedTransferWithVariance, ledgerBalance, lossRows } from "../helpers/variance.js";

describe("transfer variance settlement", () => {
  it("factory settle returns the gap to factory stock", async () => {
    const { app, token, ids } = await seedTransferWithVariance({ sent: 100, received: 95 });
    const res = await app.request(`/v1/transfers/${ids.transferId}/approve`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ settlements: [{ item_id: ids.itemId, settle: "factory" }] }),
    });
    expect(res.status).toBe(200);
    // factory regained 5 (gap = 100-95)
    expect(await ledgerBalance("factory", ids.factoryId, ids.productId, ids.variantId)).toBe(ids.factoryStartBalance - 100 + 5);
    expect(await lossRows(ids.transferId)).toHaveLength(0);
  });

  it("loss settle writes a valued loss row and does not touch stock", async () => {
    const { app, token, ids } = await seedTransferWithVariance({ sent: 100, received: 95, priceNgn: 3500 });
    await app.request(`/v1/transfers/${ids.transferId}/approve`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ settlements: [{ item_id: ids.itemId, settle: "loss" }] }),
    });
    const losses = await lossRows(ids.transferId);
    expect(losses).toHaveLength(1);
    expect(losses[0].quantity).toBe(5);
    expect(losses[0].valueNgn).toBe(17500);
  });

  it("rejects a non-owner (manager with transfers.adjust)", async () => {
    const { app, managerToken, ids } = await seedTransferWithVariance({ sent: 100, received: 95 });
    const res = await app.request(`/v1/transfers/${ids.transferId}/approve`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ settlements: [{ item_id: ids.itemId, settle: "factory" }] }),
    });
    expect(res.status).toBe(403);
  });
});
```

(Implement the small `apps/api/test/helpers/variance.ts` seeding/util module alongside — `seedTransferWithVariance` creates owner+manager, a factory with starting balance, a branch, a product+variant+price, dispatches `sent`, receives `received` with a `variance_reason`, returns ids; `ledgerBalance` sums `stock_ledger.delta`; `lossRows` selects `variance_loss` by `sourceId`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC pnpm --filter @ms/api test -- transfer-variance-settle`
Expected: FAIL — approve ignores `settlements` / returns 200 without ledger or loss rows; non-owner not yet blocked.

- [ ] **Step 3: Replace the approve handler**

```ts
// apps/api/src/routes/transfers.ts — replace the existing r.patch("/:id/approve", ...) block
const SettleBody = z.object({
  settlements: z
    .array(z.object({
      item_id: z.string().uuid(),
      settle: z.enum(["factory", "branch", "loss"]),
    }))
    .default([]),
});

r.patch("/:id/approve", requireCapability("variance.settle"), async (c) => {
  const id = c.req.param("id");
  const auth = c.get("auth");
  const body = SettleBody.parse(await c.req.json().catch(() => ({})));
  const settleByItem = new Map(body.settlements.map((s) => [s.item_id, s.settle]));

  const updated = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
    if (!t) throw new BusinessError("not_found", "transfer not found", 404);
    if (t.status !== "received_with_variance") {
      throw new BusinessError("conflict", `cannot approve from ${t.status}`, 409);
    }
    const items = await tx
      .select()
      .from(stockTransferItem)
      .where(eq(stockTransferItem.stockTransferId, id));

    for (const it of items) {
      if (it.productId == null || it.quantityReceived == null) continue; // packaging / unreceived
      const gap = it.quantitySent - it.quantityReceived;
      if (gap === 0) continue;
      const settle = settleByItem.get(it.id);
      if (!settle) {
        throw new BusinessError("validation_failed", `settlement required for item ${it.id}`, 400);
      }
      if (settle === "loss") {
        if (gap < 0) {
          throw new BusinessError("validation_failed", "cannot record loss on an over-receive", 400);
        }
        await recordVarianceLoss(tx, {
          source: "transfer",
          sourceId: id,
          branchId: t.branchId,
          productId: it.productId,
          variantId: it.variantId ?? null,
          sizeMl: null,
          quantity: gap,
          reason: it.varianceReason ?? null,
          recordedByUserId: auth.userId,
        });
      } else {
        const locationId = settle === "factory" ? t.factoryId : t.branchId;
        await tx.insert(stockLedger).values({
          locationType: settle,
          locationId,
          productId: it.productId,
          variantId: it.variantId ?? null,
          delta: gap,
          sourceType: "transfer_variance_settlement",
          sourceId: id,
          recordedByUserId: auth.userId,
          note: `Variance settle ${t.transferNumber} (${settle})`,
        });
      }
    }

    const [u] = await tx
      .update(stockTransfer)
      .set({ status: "completed", approvedAt: new Date(), approvedByUserId: auth.userId, updatedAt: new Date() })
      .where(eq(stockTransfer.id, id))
      .returning();
    if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);
    return u;
  });

  await writeAudit(db, c, {
    action: "stock_transfer.settle_variance",
    entityType: "stock_transfer",
    entityId: id,
    after: updated,
  });
  return c.json({ data: updated });
});
```

Add `import { recordVarianceLoss } from "@ms/domain";` (or extend the existing `@ms/domain` import) and ensure `stockTransferItem` is imported.

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=UTC pnpm --filter @ms/api test -- transfer-variance-settle`
Expected: PASS (factory, loss, and 403 cases).

- [ ] **Step 5: Guard the negative-balance edge**

Add a test asserting a `branch` settle that would drive branch balance negative returns a 4xx `BusinessError` (the trigger raises `check_violation`; confirm the API maps DB errors to a clean response, not a 500). If it currently 500s, wrap the transaction's known check-violation into a `BusinessError("conflict", "settlement would make stock negative", 409)`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/transfers.ts apps/api/test/integration/transfer-variance-settle.test.ts apps/api/test/helpers/variance.ts
git commit -m "feat(api): owner-settled transfer variance (factory/branch/loss)"
```

---

### Task 5: Admin transfer-approval settlement UI

**Files:**
- Modify: `apps/admin/src/routes/transfer-detail.tsx` (settlement panel on variance transfers)
- Modify: the admin API client call for approve (send `settlements` body)

**Interfaces:**
- Consumes: `PATCH /v1/transfers/:id/approve` with `{ settlements }` (Task 4).
- Produces: owner-only settlement panel.

- [ ] **Step 1: Render the settlement panel**

On a transfer in status `received_with_variance`, for each varianced line show flavour, size, sent, received, and `gap = sent - received`. Provide three bulk buttons — **Adopt → Factory** (sets every line to `factory`), **Ignore** (every line `loss`), **Check per flavour** (reveals a per-line Factory/Branch/Loss selector). Default each line to `factory`. Only render for users whose caps include `variance.settle` (reuse the existing capability check used elsewhere in admin).

- [ ] **Step 2: Wire submit**

On confirm, POST `{ settlements: lines.map(l => ({ item_id: l.id, settle: l.choice })) }` to the approve endpoint via the existing admin `api()` client. On success, refetch the transfer and show the `completed` state. Surface API `BusinessError` messages via the existing `humanizeError` path.

- [ ] **Step 3: Manual verification**

Run admin dev (`pnpm --filter @ms/admin dev`), open a `received_with_variance` transfer as owner, confirm: Adopt→Factory completes and factory stock rises by the gap; Loss completes and the loss appears (verified again in Plan 2's report). Confirm a non-owner does not see the panel.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/routes/transfer-detail.tsx
git commit -m "feat(admin): owner transfer variance settlement panel"
```

---

### Task 6: Shift-close on-hand reconciliation + loss capture

**Files:**
- Modify: `apps/api/src/routes/daily-close.ts:95-120` (after the count-insert loop)
- Modify: `apps/api/test/integration/daily-close-flow.test.ts` (or a new `daily-close-reconcile.test.ts`)

**Interfaces:**
- Consumes: `stockLedger`, `recordVarianceLoss`, the per-line `expected`/`counted_quantity`/`variantId`/`size` already computed in the close handler.
- Produces: after a close, branch on-hand equals the counted quantity for every line; each shortfall writes a `variance_loss` (`source: "shift_close"`).

Behaviour: for each `sc` in `body.stock_counts`, `recon = sc.counted_quantity - expected` (= `lineVariance`). If `recon !== 0`, insert a `stock_ledger` row `{ locationType: "branch", locationId: branchId, productId, variantId, delta: recon, sourceType: "count_correction", sourceId: close.id, note: variance_reason }`. If `recon < 0`, also `recordVarianceLoss({ source: "shift_close", sourceId: close.id, branchId, productId, variantId, sizeMl: size, quantity: -recon, reason: sc.variance_reason })`. Do this inside the existing close transaction, in the same loop that inserts `dailyCloseStockCount` (reuse `lineVariance`).

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/test/integration/daily-close-reconcile.test.ts
import { describe, it, expect } from "vitest";
import { openShiftWithStock, closeShiftWithCounts, branchBalance, lossRowsForClose } from "../helpers/variance.js";

describe("shift close reconciliation", () => {
  it("sets branch on-hand to the counted quantity and logs the shortfall as a loss", async () => {
    // system expects 30, staff count 25
    const ctx = await openShiftWithStock({ expected: 30, priceNgn: 3500 });
    const close = await closeShiftWithCounts(ctx, { counted: 25, reason: "spillage" });
    expect(await branchBalance(ctx)).toBe(25);
    const losses = await lossRowsForClose(close.id);
    expect(losses).toHaveLength(1);
    expect(losses[0].quantity).toBe(5);
    expect(losses[0].valueNgn).toBe(17500);
  });

  it("counts up found stock without writing a loss", async () => {
    const ctx = await openShiftWithStock({ expected: 30 });
    const close = await closeShiftWithCounts(ctx, { counted: 33, reason: "miscount" });
    expect(await branchBalance(ctx)).toBe(33);
    expect(await lossRowsForClose(close.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC pnpm --filter @ms/api test -- daily-close-reconcile`
Expected: FAIL — on-hand unchanged (stays 30), no loss row.

- [ ] **Step 3: Add reconcile + loss inside the close loop**

In `daily-close.ts`, within the `for (const sc of body.stock_counts)` loop (right after the `dailyCloseStockCount` insert), add:

```ts
if (lineVariance !== 0) {
  await tx.insert(stockLedger).values({
    locationType: "branch",
    locationId: branchId,
    productId: sc.product_id,
    variantId,
    delta: lineVariance,
    sourceType: "count_correction",
    sourceId: close.id,
    recordedByUserId: auth.userId,
    note: sc.variance_reason ?? "shift close count",
  });
  if (lineVariance < 0) {
    await recordVarianceLoss(tx, {
      source: "shift_close",
      sourceId: close.id,
      branchId,
      productId: sc.product_id,
      variantId,
      sizeMl: sizeByKey.get(expectedStockKey(sc.product_id, variantId)) ?? null,
      quantity: -lineVariance,
      reason: sc.variance_reason ?? null,
      recordedByUserId: auth.userId,
    });
  }
}
```

Add `stockLedger` and `recordVarianceLoss` to the imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `TZ=UTC pnpm --filter @ms/api test -- daily-close-reconcile daily-close-flow`
Expected: PASS, and the existing daily-close-flow suite still green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/daily-close.ts apps/api/test/integration/daily-close-reconcile.test.ts apps/api/test/helpers/variance.ts
git commit -m "feat(api): shift-close reconciles on-hand to physical count + logs losses"
```

---

## Deferred to later plans

- **Plan 2 — Monthly report:** `GET /v1/reports/variance?month=YYYY-MM` (owner), `/owner/variance` admin page, month-end Telegram summary. Depends on `variance_loss` (Task 1).
- **Plan 3 — Per-shift reporting integrity:** audit the shift-end notification / owner close-detail / closes list so figures cover only the open shift's window, not the whole day.
- **Shift-OPEN reconciliation is intentionally excluded:** open counts are mutable (recount = delete+reinsert, `shift-open.ts:95`), which conflicts with the append-only ledger. Close is the conclusive event and captures end-of-shift truth.

## Self-Review

- **Spec coverage:** A (transfer settlement) → Tasks 4–5; B (shift reconcile) → Task 6 (close only; open deferred with rationale); C (variance_loss) → Tasks 1, 3; owner-only → Task 2. D (report) and E (per-shift) explicitly deferred to Plans 2/3. ✅
- **Placeholder scan:** all steps carry concrete code or exact commands. Test-helper module described by its functions; implementer builds it in Task 4 Step 1. ✅
- **Type consistency:** `recordVarianceLoss` signature identical in Tasks 3, 4, 6; `settle` enum `"factory"|"branch"|"loss"` consistent; ledger `sourceType` values match Task 1 (`transfer_variance_settlement`) and the existing `count_correction`. ✅

# Unified online-order / preorder fulfilment + till nav Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an order that is both an online order and a preorder fulfillable in one coherent flow — both the Online lens and the Preorder lens read/write the same lifecycle, so fulfilling once is reconciled everywhere; then declutter the till nav from 13 items to 7.

**Architecture:** Add a `produced_at` timestamp to `sale_order` to disambiguate the overloaded `fulfilled_at` ("produced/stock-deducted" vs "delivered/complete"). The preorder "Fulfil" step sets `produced_at`; for *pickup* orders it also hands over (done), for *delivery* orders it leaves `status='paid'` so the order flows into the existing out-for-delivery path. Queues and the journey timeline derive stage from `status` + `produced_at`, never from `fulfilled_at` alone. Part 2 collapses the till nav by merging related pages behind one shared tab strip, routes unchanged.

**Tech Stack:** TypeScript monorepo (pnpm). API: Hono + Drizzle (Postgres). DB: hand-written SQL migrations + Drizzle schema. Admin UI: React + TanStack Router + Vite. Tests: Vitest (API integration via `@testcontainers/postgresql`; pure helpers as unit tests).

## Global Constraints

- Migrations are **hand-written SQL** in `packages/db/migrations/` plus a **manual journal entry** in `packages/db/migrations/meta/_journal.json`. The new journal `when` value MUST be strictly greater than the previous entry's `when` (`1783130000000` for `0059`) or the migrator silently skips it. Next migration is `0060`; use `when: 1783160000000`.
- No new `sale_status` enum value — stage is *derived*, not stored.
- No change to the Payaza reconcile/money path, refund flow, or order-creation reservation logic.
- No change to the customer app (`apps/customer/**`).
- **Pickup vs delivery** is determined the same way everywhere (server `advance` and client `isDeliveryOrder`): an order is *delivery* if it has any of `delivery_address_formatted`, `delivery_state`, `delivery_fee_ngn > 0`, or a `delivery_order` row; otherwise *pickup*.
- Admin has **no render tests**; UI tasks verify via `pnpm typecheck` + `pnpm --filter @ms/admin build` + a documented manual eyeball. Pure helpers (`order-journey.ts`, nav helpers) DO get Vitest unit tests.
- Commands: typecheck `pnpm typecheck`; API tests `pnpm --filter @ms/api test`; DB build `pnpm --filter @ms/db build`; admin build `pnpm --filter @ms/admin build`; admin unit tests `pnpm --filter @ms/admin test`; apply migrations `pnpm db:migrate`.
- Run a single API test file: `pnpm --filter @ms/api exec vitest run test/integration/<file>.ts`.

---

# Phase 1 — Lifecycle + queue reconciliation (the reported bug)

### Task 1: Add `produced_at` / `produced_by_user_id` to `sale_order`

**Files:**
- Modify: `packages/db/src/schema/sale-order.ts:88-89` (add two columns + an index)
- Create: `packages/db/migrations/0060_sale_order_produced_at.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (append entry)

**Interfaces:**
- Produces: `saleOrder.producedAt` (`timestamp, withTimezone, nullable`) and `saleOrder.producedByUserId` (`uuid, nullable, → adminUser.id`) on the Drizzle `saleOrder` table; a partial index `idx_sale_order_preorder_produced`.

- [ ] **Step 1: Add the columns to the Drizzle schema**

In `packages/db/src/schema/sale-order.ts`, immediately after the `fulfilledByUserId` line (currently line 89), add:

```ts
  // Set when a preorder is produced (made / stock deducted) — distinct from
  // fulfilledAt, which means the order is complete (delivered/collected). A
  // delivery preorder is "produced" but not yet "fulfilled".
  producedAt: timestamp("produced_at", { withTimezone: true }),
  producedByUserId: uuid("produced_by_user_id").references(() => adminUser.id),
```

Then in the index block (the `(t) => ({ ... })` at the bottom), add after `idxPreorderStatus`:

```ts
  // Production worklist: open preorders awaiting production.
  idxPreorderProduced: index("idx_sale_order_preorder_produced").on(t.isPreorder, t.producedAt),
```

- [ ] **Step 2: Write the migration SQL**

Create `packages/db/migrations/0060_sale_order_produced_at.sql`:

```sql
ALTER TABLE "sale_order" ADD COLUMN "produced_at" timestamptz;
ALTER TABLE "sale_order" ADD COLUMN "produced_by_user_id" uuid REFERENCES "admin_user"("id");
CREATE INDEX IF NOT EXISTS "idx_sale_order_preorder_produced" ON "sale_order" ("is_preorder","produced_at");
```

- [ ] **Step 3: Append the journal entry**

In `packages/db/migrations/meta/_journal.json`, the `entries` array currently ends with the `0059_alt_phone` object (idx 58). Add a comma + new object right after it, before the closing `]`:

```json
    ,{ "idx": 59, "version": "7", "when": 1783160000000, "tag": "0060_sale_order_produced_at", "breakpoints": true }
```

- [ ] **Step 4: Build the db package to confirm the schema compiles**

Run: `pnpm --filter @ms/db build`
Expected: PASS (no TS errors).

- [ ] **Step 5: Apply the migration against the dev DB**

Run: `pnpm db:up` (if the local Postgres isn't already up) then `pnpm db:migrate`
Expected: output lists `0060_sale_order_produced_at` as applied, no errors. (If no local DB is available, skip this step here — Task 2's testcontainer run applies all migrations and will fail loudly if the SQL or journal is malformed.)

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/sale-order.ts packages/db/migrations/0060_sale_order_produced_at.sql packages/db/migrations/meta/_journal.json
git commit -m "feat(db): add sale_order.produced_at to separate produced from delivered"
```

---

### Task 2: Preorder fulfil sets `produced_at`; queue keys off it

**Files:**
- Modify: `apps/api/src/routes/preorder-shared.ts:20-79` (`listOpenPreorders` filter) and `:86-196` (`fulfilPreorderTx`)
- Test: `apps/api/test/integration/preorders-fulfil.test.ts` (existing — extend), `apps/api/test/integration/helpers.ts` (extend `seedOnlineOrder`)

**Interfaces:**
- Consumes: `saleOrder.producedAt`, `saleOrder.producedByUserId` (Task 1).
- Produces: `fulfilPreorderTx` now sets `producedAt`/`producedByUserId`; for *delivery* orders leaves `status='paid'` and `fulfilledAt=null`; for *pickup* orders sets `status='handed_over'` + `fulfilledAt=now`. `listOpenPreorders` returns orders where `produced_at IS NULL`. `seedOnlineOrder` gains optional `isPreorder` and `producedAt` opts.

- [ ] **Step 1: Extend `seedOnlineOrder` to support preorders**

In `apps/api/test/integration/helpers.ts`, change the `seedOnlineOrder` `opts` type (around line 210-215) to add two optional fields:

```ts
  opts: {
    status: "confirmed" | "paid" | "handed_over" | "out_for_delivery" | "delivered" | "cancelled" | "failed";
    deliveryState?: string;
    deliveryFeeNgn?: number;
    branchId?: string;
    isPreorder?: boolean;
    producedAt?: Date | null;
  },
```

Then in the `.values({ ... })` insert (around line 240-255), change the `isPreorder` line and add `producedAt`:

```ts
      isPreorder: opts.isPreorder ?? false,
      producedAt: opts.producedAt ?? null,
```

- [ ] **Step 2: Write a failing integration test for the delivery-preorder produce semantics**

Append to `apps/api/test/integration/preorders-fulfil.test.ts` a new `describe` block (it reuses the file's imports; add `saleOrder` and `eq` if not already imported — `eq` is imported, add `saleOrder` to the `@ms/db` import). Use the owner queue route `/v1/preorders`:

```ts
describe("online preorder produce semantics", () => {
  // Reuses the same server/cookies/branch/product from the outer suite is not
  // possible across describes; instead spin the shared harness via makeTestApp.
  // To keep it simple we assert against the owner /v1/preorders + /v1/online-orders.
});
```

Because the existing file uses the lower-level `serve`/`call` harness, write this as a NEW dedicated file instead — create `apps/api/test/integration/online-preorder-produce.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Hono } from "hono";
import type { createDbClient } from "@ms/db";
import { makeTestApp, seedOnlineOrder, authOwner } from "./helpers.js";

describe("online preorder produce semantics", () => {
  let app: Hono;
  let db: ReturnType<typeof createDbClient>;
  let container: StartedPostgreSqlContainer;
  let headers: Record<string, string>;

  beforeAll(async () => {
    const ctx = await makeTestApp();
    app = ctx.app; db = ctx.db; container = ctx.container;
    headers = await authOwner(app);
  }, 120_000);
  afterAll(async () => { await container.stop(); }, 30_000);

  async function json<T>(res: Response): Promise<T> { return (await res.json()) as T; }

  it("producing a DELIVERY preorder keeps status=paid, sets produced_at, leaves the preorder queue, stays on the online queue", async () => {
    const seeded = await seedOnlineOrder(db, { status: "paid", isPreorder: true, deliveryState: "Lagos", deliveryFeeNgn: 1500 });

    // Appears in the preorder worklist before produce
    const before = await json<{ data: Array<{ id: string }> }>(
      await app.request("/v1/preorders", { headers }),
    );
    expect(before.data.some((r) => r.id === seeded.id)).toBe(true);

    // Produce it
    const res = await app.request(`/v1/preorders/${seeded.id}/fulfil`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    });
    expect(res.status).toBe(200);
    const body = await json<{ data: { status: string; producedAt: string | null; fulfilledAt: string | null } }>(res);
    expect(body.data.status).toBe("paid");          // delivery: stays paid
    expect(body.data.producedAt).not.toBeNull();     // produced now
    expect(body.data.fulfilledAt).toBeNull();         // NOT delivered yet

    // Gone from the preorder worklist
    const after = await json<{ data: Array<{ id: string }> }>(
      await app.request("/v1/preorders", { headers }),
    );
    expect(after.data.some((r) => r.id === seeded.id)).toBe(false);

    // Still on the online queue (now produced / "Ready")
    const online = await json<{ data: Array<{ id: string; produced_at: string | null }> }>(
      await app.request("/v1/online-orders/active", { headers }),
    );
    const row = online.data.find((r) => r.id === seeded.id);
    expect(row).toBeDefined();
    expect(row!.produced_at).not.toBeNull();
  });

  it("producing a PICKUP preorder hands it over (done) and sets both produced_at and fulfilled_at", async () => {
    const seeded = await seedOnlineOrder(db, { status: "paid", isPreorder: true }); // no delivery → pickup

    const res = await app.request(`/v1/preorders/${seeded.id}/fulfil`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    });
    expect(res.status).toBe(200);
    const body = await json<{ data: { status: string; producedAt: string | null; fulfilledAt: string | null } }>(res);
    expect(body.data.status).toBe("handed_over");
    expect(body.data.producedAt).not.toBeNull();
    expect(body.data.fulfilledAt).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @ms/api exec vitest run test/integration/online-preorder-produce.test.ts`
Expected: FAIL — the delivery case currently returns `status="paid"` but `producedAt` is null (column never set), and `/online-orders/active` rows have no `produced_at` field.

- [ ] **Step 4: Update `fulfilPreorderTx` to set produced_at by fulfilment type**

In `apps/api/src/routes/preorder-shared.ts`, replace the counter-channel logic in `fulfilPreorderTx` (the block currently at lines 136-147). Replace:

```ts
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
```

with:

```ts
    // Pickup orders (no delivery destination — includes counter walkup/whatsapp)
    // complete on produce: customer collects now. Delivery orders are merely
    // *produced* — they still need to go out, so status stays `paid` and
    // fulfilledAt stays null (that now means delivered). produced_at marks the
    // production step for every channel.
    const isDelivery =
      !!o.deliveryAddressFormatted ||
      !!o.deliveryState ||
      o.deliveryFeeNgn > 0;
    const now = new Date();
    const [u] = await tx
      .update(saleOrder)
      .set({
        status: isDelivery ? o.status : ("handed_over" as const),
        producedAt: now,
        producedByUserId: auth.userId,
        fulfilledAt: isDelivery ? o.fulfilledAt : now,
        fulfilledByUserId: isDelivery ? o.fulfilledByUserId : auth.userId,
        updatedAt: now,
      })
      .where(eq(saleOrder.id, id))
      .returning();
```

Delete the now-unused `COUNTER_CHANNELS` const (line 18) and its `const toCounter` reference. Update the `if (!toCounter && autoDispatchEnabled())` guard (line 149) to `if (isDelivery && autoDispatchEnabled())`.

- [ ] **Step 5: Update the open-preorder filter and the already-produced guard**

In `listOpenPreorders` (lines 25-29), change the conditions array:

```ts
  const conds = [
    eq(saleOrder.isPreorder, true),
    eq(saleOrder.status, "paid"),
    isNull(saleOrder.producedAt),
  ];
```

In `fulfilPreorderTx`, change the already-fulfilled guard (line 101) from `if (o.fulfilledAt)` to:

```ts
    if (o.producedAt) throw new BusinessError("conflict", "preorder already produced", 409);
```

- [ ] **Step 6: Run the new test to verify it passes**

Run: `pnpm --filter @ms/api exec vitest run test/integration/online-preorder-produce.test.ts`
Expected: PASS (note: `/online-orders/active` `produced_at` assertion needs Task 3 — if running Task 2 alone, that one assertion fails; run Step 6 again after Task 3, or implement Task 3 before re-running. To keep Task 2 green on its own, temporarily skip the `/online-orders/active` assertions and re-enable them in Task 3.)

- [ ] **Step 7: Run the existing preorder tests to confirm no regression**

Run: `pnpm --filter @ms/api exec vitest run test/integration/preorders-fulfil.test.ts test/integration/preorders.test.ts test/integration/branch-preorders.test.ts test/integration/online-fulfilment.test.ts`
Expected: PASS. The existing walkup-fulfil test still expects `status="handed_over"` and `fulfilledAt != null` — preserved because walkup is pickup.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/preorder-shared.ts apps/api/test/integration/helpers.ts apps/api/test/integration/online-preorder-produce.test.ts
git commit -m "feat(api): preorder fulfil sets produced_at; pickup completes, delivery stays paid"
```

---

### Task 3: Online-orders queue exposes `produced_at` + derived stage

**Files:**
- Modify: `apps/api/src/routes/online-orders-queue.ts:42-110` (`/active` select + response)
- Test: `apps/api/test/integration/online-preorder-produce.test.ts` (re-enable the online-queue assertions from Task 2)

**Interfaces:**
- Consumes: `saleOrder.producedAt`.
- Produces: each `/active` row gains `produced_at: string | null` and `stage: "awaiting_production" | "ready" | "out_for_delivery"`.

- [ ] **Step 1: Add `producedAt` to the select and a derived `stage` to the response**

In `online-orders-queue.ts`, add to the `.select({ ... })` (after `isPreorder: saleOrder.isPreorder,` near line 55):

```ts
        producedAt: saleOrder.producedAt,
```

Then in the `const data = orders.map((o) => { ... })` block, add a stage derivation and two response fields. After the `isDelivery` computation, add:

```ts
      const stage: "awaiting_production" | "ready" | "out_for_delivery" =
        o.status === "out_for_delivery"
          ? "out_for_delivery"
          : o.isPreorder && o.producedAt == null
            ? "awaiting_production"
            : "ready";
```

and in the returned object (after `is_preorder: o.isPreorder,`) add:

```ts
        produced_at: o.producedAt ? (o.producedAt as Date).toISOString() : null,
        stage,
```

- [ ] **Step 2: Re-enable the online-queue assertions and run**

If you skipped the `/online-orders/active` assertions in Task 2 Step 6, re-enable them now. Run:

Run: `pnpm --filter @ms/api exec vitest run test/integration/online-preorder-produce.test.ts test/integration/online-orders-queue.test.ts`
Expected: PASS — produced delivery preorder appears on `/active` with `produced_at != null` and `stage="ready"`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/online-orders-queue.ts apps/api/test/integration/online-preorder-produce.test.ts
git commit -m "feat(api): online-orders queue exposes produced_at + derived stage"
```

---

### Task 4: `advance` rejects an unproduced preorder

**Files:**
- Modify: `apps/api/src/routes/sales.ts:565-618` (the `/:id/advance` handler)
- Test: `apps/api/test/integration/online-preorder-produce.test.ts` (add a case)

**Interfaces:**
- Consumes: `saleOrder.producedAt`, `seedOnlineOrder({ isPreorder, producedAt })`.
- Produces: `PATCH /branches/:branchId/sales/:id/advance` returns `409` when `isPreorder ∧ producedAt == null`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/integration/online-preorder-produce.test.ts`:

```ts
  it("advance is blocked until a preorder is produced, then succeeds", async () => {
    const seeded = await seedOnlineOrder(db, { status: "paid", isPreorder: true, deliveryState: "Lagos", deliveryFeeNgn: 1500 });

    // Before produce: advance is rejected
    const blocked = await app.request(`/v1/branches/${seeded.branchId}/sales/${seeded.id}/advance`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: "{}",
    });
    expect(blocked.status).toBe(409);

    // Produce, then advance succeeds → out_for_delivery
    await app.request(`/v1/preorders/${seeded.id}/fulfil`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    });
    const ok = await app.request(`/v1/branches/${seeded.branchId}/sales/${seeded.id}/advance`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: "{}",
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: { status: string } };
    expect(body.data.status).toBe("out_for_delivery");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ms/api exec vitest run test/integration/online-preorder-produce.test.ts -t "advance is blocked"`
Expected: FAIL — advance currently returns 200 (moves paid→out_for_delivery) even when not produced.

- [ ] **Step 3: Add the guard**

In `sales.ts`, inside the `/:id/advance` transaction, right after the channel check (`if (!["online", "phone"].includes(o.channel)) ...`, ~line 573), add:

```ts
      if (o.isPreorder && o.producedAt == null) {
        throw new BusinessError("conflict", "Produce this preorder before handing it over.", 409);
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @ms/api exec vitest run test/integration/online-preorder-produce.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sales.ts apps/api/test/integration/online-preorder-produce.test.ts
git commit -m "feat(api): advance rejects an unproduced preorder"
```

---

### Task 5: `deriveOrderJourney` keys the produce step off `produced_at`

**Files:**
- Modify: `apps/admin/src/lib/order-journey.ts:32-94`
- Test: Create `apps/admin/src/lib/order-journey.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `OrderJourneyInput` gains `producedAt?: string | null`. For a preorder, the middle ("In production") step is `done` only once `producedAt` is set (not merely because status passed `paid`).

- [ ] **Step 1: Write the failing unit test**

Create `apps/admin/src/lib/order-journey.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveOrderJourney } from "./order-journey.js";

describe("deriveOrderJourney + produced_at", () => {
  it("an unproduced delivery preorder sits on 'In production' (current, not done)", () => {
    const j = deriveOrderJourney({
      status: "paid", channel: "online", isPreorder: true,
      deliveryState: "Lagos", deliveryFeeNgn: 1500, producedAt: null,
    });
    const mid = j.steps.find((s) => s.key === "mid")!;
    expect(mid.label).toBe("In production");
    expect(mid.state).toBe("current");
    expect(j.currentLabel).toBe("In production");
  });

  it("a produced delivery preorder has 'In production' done and 'Out for delivery' current", () => {
    const j = deriveOrderJourney({
      status: "paid", channel: "online", isPreorder: true,
      deliveryState: "Lagos", deliveryFeeNgn: 1500,
      producedAt: "2026-06-29T10:00:00.000Z",
    });
    expect(j.steps.find((s) => s.key === "mid")!.state).toBe("done");
    expect(j.currentLabel).toBe("Out for delivery");
  });

  it("a non-preorder paid delivery order does not require produced_at", () => {
    const j = deriveOrderJourney({
      status: "paid", channel: "online", isPreorder: false,
      deliveryState: "Lagos", deliveryFeeNgn: 1500,
    });
    expect(j.steps.find((s) => s.key === "mid")!.state).toBe("done");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ms/admin exec vitest run src/lib/order-journey.test.ts`
Expected: FAIL — currently `mid.done` is true for any paid order (preorder or not), so the first test's `current` expectation fails.

- [ ] **Step 3: Add `producedAt` to the input and gate the mid step**

In `apps/admin/src/lib/order-journey.ts`, add to `OrderJourneyInput` (after `isPreorder?`):

```ts
  producedAt?: string | null;
```

Then change the `dispatchedDone` computation (lines 67-70). The middle step is "done" when the order has moved past production. For a preorder that means `producedAt` is set OR status already advanced to a dispatch/terminal state; for a non-preorder, the existing status logic stands. Replace:

```ts
  const dispatchedDone =
    track === "delivery"
      ? ["out_for_delivery", "delivered"].includes(o.status)
      : ["handed_over", "delivered"].includes(o.status);
```

with:

```ts
  const statusPastProduction =
    track === "delivery"
      ? ["out_for_delivery", "delivered"].includes(o.status)
      : ["handed_over", "delivered"].includes(o.status);
  // For a preorder the middle "production" step is only done once produced_at is
  // stamped (a paid-but-unproduced preorder is still being made). Non-preorders
  // keep the status-only rule.
  const dispatchedDone = o.isPreorder
    ? !!o.producedAt || statusPastProduction
    : statusPastProduction;
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @ms/admin exec vitest run src/lib/order-journey.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/order-journey.ts apps/admin/src/lib/order-journey.test.ts
git commit -m "feat(admin): journey 'in production' step keys off produced_at"
```

---

### Task 6: Order-detail pages drive produce → hand over → delivered

**Files:**
- Modify: `apps/admin/src/routes/branch/online-order-detail.tsx:48-72` (Sale type), `:300-557` (action area)
- Modify: `apps/admin/src/routes/owner/order-detail.tsx` (same action area — owner twin)
- Create: `apps/admin/src/lib/order-fulfil-action.ts` (shared decision helper)
- Test: Create `apps/admin/src/lib/order-fulfil-action.test.ts`

**Interfaces:**
- Consumes: `deriveOrderJourney` (Task 5), `isDeliveryOrder` from `order-journey.ts`.
- Produces: `nextFulfilAction(order)` → `{ kind: "produce" | "advance" | "none"; label: string }` where `produce` means call the preorder fulfil endpoint and `advance` means call `/advance`.

- [ ] **Step 1: Write the failing unit test**

Create `apps/admin/src/lib/order-fulfil-action.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextFulfilAction } from "./order-fulfil-action.js";

describe("nextFulfilAction", () => {
  const base = { channel: "online", deliveryState: "Lagos", deliveryFeeNgn: 1500 };

  it("unproduced preorder → produce", () => {
    expect(nextFulfilAction({ ...base, status: "paid", isPreorder: true, producedAt: null }))
      .toEqual({ kind: "produce", label: "Fulfil & produce" });
  });
  it("produced delivery preorder at paid → advance (out for delivery)", () => {
    expect(nextFulfilAction({ ...base, status: "paid", isPreorder: true, producedAt: "2026-06-29T10:00:00Z" }))
      .toEqual({ kind: "advance", label: "Mark out for delivery" });
  });
  it("non-preorder paid delivery order → advance", () => {
    expect(nextFulfilAction({ ...base, status: "paid", isPreorder: false, producedAt: null }))
      .toEqual({ kind: "advance", label: "Mark out for delivery" });
  });
  it("paid pickup order → advance (hand over)", () => {
    expect(nextFulfilAction({ channel: "online", status: "paid", isPreorder: false, producedAt: null }))
      .toEqual({ kind: "advance", label: "Mark ready for pickup" });
  });
  it("out_for_delivery → advance (mark delivered)", () => {
    expect(nextFulfilAction({ ...base, status: "out_for_delivery", isPreorder: false, producedAt: null }))
      .toEqual({ kind: "advance", label: "Mark delivered" });
  });
  it("delivered → none", () => {
    expect(nextFulfilAction({ ...base, status: "delivered", isPreorder: false, producedAt: null }))
      .toEqual({ kind: "none", label: "" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ms/admin exec vitest run src/lib/order-fulfil-action.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

Create `apps/admin/src/lib/order-fulfil-action.ts`:

```ts
import { isDeliveryOrder, type OrderJourneyInput } from "./order-journey.js";

export type FulfilActionKind = "produce" | "advance" | "none";
export interface FulfilAction {
  kind: FulfilActionKind;
  label: string;
}

/**
 * The single next fulfilment action for an online order, shared by the owner and
 * branch detail pages so they never drift. A preorder that has not been produced
 * yet needs the produce step (calls the preorder fulfil endpoint); everything
 * else uses the channel-aware advance transition.
 */
export function nextFulfilAction(
  o: OrderJourneyInput & { producedAt?: string | null },
): FulfilAction {
  if (o.isPreorder && !o.producedAt && o.status === "paid") {
    return { kind: "produce", label: "Fulfil & produce" };
  }
  const delivery = isDeliveryOrder(o);
  if (o.status === "paid") {
    return { kind: "advance", label: delivery ? "Mark out for delivery" : "Mark ready for pickup" };
  }
  if (o.status === "out_for_delivery") return { kind: "advance", label: "Mark delivered" };
  if (o.status === "handed_over") return { kind: "advance", label: "Mark collected" };
  return { kind: "none", label: "" };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @ms/admin exec vitest run src/lib/order-fulfil-action.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the branch detail page to the helper**

In `apps/admin/src/routes/branch/online-order-detail.tsx`:

1. Add `producedAt?: string | null;` to the `Sale` interface (after `isPreorder?: boolean;`, line 56).
2. Import the helper at top: `import { nextFulfilAction } from "../../lib/order-fulfil-action.js";`.
3. Add a `produce` handler next to `advance` (after the `advance` function, ~line 154):

```ts
  async function produce(): Promise<void> {
    if (!data) return;
    setAdvanceBusy(true);
    setDeliveryError(null);
    try {
      await api(`/branches/${branchId}/preorders/${orderId}/fulfil`, { method: "PATCH" }, { silentError: true });
      await loadOrder();
    } catch (err) {
      const msg = humanizeError(err);
      setDeliveryError(/unfulfillable|not enough stock/i.test(msg)
        ? "Not enough stock to produce this preorder yet — produce/transfer more first."
        : msg);
    } finally {
      setAdvanceBusy(false);
    }
  }
```

4. Pass `producedAt` into `deriveOrderJourney` — it reads from `data` automatically once the field exists on `Sale` (the helper input is structurally compatible; ensure the object passed to `deriveOrderJourney(data)` includes `producedAt`, which it now does as a `Sale` field).

5. Replace the stage button stack inside `canAct` (lines 507-556, the `isDeliveryOrder ? (...) : (...)` block) with a single helper-driven button:

```tsx
                  {canAct && (() => {
                    const action = nextFulfilAction(data);
                    if (action.kind === "none") return null;
                    const onClick = action.kind === "produce" ? produce : advance;
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          disabled={advanceBusy}
                          onClick={() => void onClick()}
                        >
                          {advanceBusy ? "Saving…" : action.label}
                        </button>
                      </div>
                    );
                  })()}
```

- [ ] **Step 6: Wire the owner detail page identically**

In `apps/admin/src/routes/owner/order-detail.tsx`, apply the same four changes (Sale `producedAt` field, import, `produce` handler using the owner endpoint `/preorders/${orderId}/fulfil`, and the helper-driven button replacing the owner page's stage-button block). Match the owner page's existing `advance`/api call style and capability gate (`orders.manage`).

- [ ] **Step 7: Typecheck, build, and unit-test**

Run: `pnpm typecheck && pnpm --filter @ms/admin exec vitest run src/lib/order-fulfil-action.test.ts src/lib/order-journey.test.ts && pnpm --filter @ms/admin build`
Expected: all PASS.

- [ ] **Step 8: Manual eyeball (documented, admin has no render tests)**

Run `pnpm dev:admin` + a paid online **delivery preorder** in the dev DB. Verify on `/branch/online-orders/<id>`: button reads **"Fulfil & produce"** → after click, journey shows "In production" done and button becomes **"Mark out for delivery"** → then **"Mark delivered"**. Repeat on the owner order-detail page. Note the result in the commit message.

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/lib/order-fulfil-action.ts apps/admin/src/lib/order-fulfil-action.test.ts apps/admin/src/routes/branch/online-order-detail.tsx apps/admin/src/routes/owner/order-detail.tsx
git commit -m "feat(admin): one stage-driven fulfil action (produce -> advance) on both detail pages"
```

---

### Task 7: Online-orders lists show the derived stage

**Files:**
- Modify: `apps/admin/src/routes/branch/online-orders.tsx:9-47` (type + pills), `:126-138` (status cell)
- Modify: `apps/admin/src/routes/owner/online-orders.tsx` (same — owner twin)

**Interfaces:**
- Consumes: `/online-orders/active` rows now carry `stage` + `produced_at` (Task 3).
- Produces: a `stageLabel(stage, status)` rendering replacing the flat "Paid + Preorder pill".

- [ ] **Step 1: Add `stage` to the `ActiveOrder` type (both files)**

In both `branch/online-orders.tsx` and `owner/online-orders.tsx`, add to the `ActiveOrder` interface:

```ts
  produced_at: string | null;
  stage: "awaiting_production" | "ready" | "out_for_delivery";
```

- [ ] **Step 2: Replace the status pill block with a stage-aware label**

In both files, in the status `<td>` (branch lines 126-138), replace the `is_preorder` "Preorder" pill logic so a produced preorder no longer reads as a bare "Paid". Render:

```tsx
                  <td>
                    {o.stage === "awaiting_production" ? (
                      <span className="pill pill--warning">📅 Awaiting production</span>
                    ) : o.stage === "ready" ? (
                      <span className="pill pill--success">Ready · hand over / deliver</span>
                    ) : (
                      statusPill(o.status)
                    )}
                    {o.scheduled_delivery_at && (
                      <span className="pill pill--warning" style={{ marginLeft: 6 }}>Scheduled</span>
                    )}
                  </td>
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm --filter @ms/admin build`
Expected: PASS.

- [ ] **Step 4: Manual eyeball**

In `pnpm dev:admin`, on `/branch/online-orders` and `/owner/online-orders`: an unproduced online preorder shows "📅 Awaiting production"; after producing it (Task 6), the same order shows "Ready · hand over / deliver" — never a bare "Paid + Preorder" again.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/routes/branch/online-orders.tsx apps/admin/src/routes/owner/online-orders.tsx
git commit -m "feat(admin): online-orders lists show derived stage (awaiting production / ready)"
```

---

### Task 8: Preorder + sales lists key off `produced_at`

**Files:**
- Modify: `apps/admin/src/routes/branch/sales.tsx:21-35` (preorder pill), `:61` (`awaitsFulfilment`)
- Verify: `apps/admin/src/routes/branch/preorders.tsx` + `apps/admin/src/routes/owner/preorders.tsx` (copy only — behaviour already correct once API filters on produced_at)

**Interfaces:**
- Consumes: `Sale` rows; the preorder "fulfilled vs pending" distinction now means produced vs unproduced.

- [ ] **Step 1: Add `producedAt` to the sales `Sale` type and re-key the preorder pill**

In `apps/admin/src/routes/branch/sales.tsx`, add `producedAt?: string | null;` to the `Sale` interface (near line 21). Then change the `preorderPill` (lines 31-35) so "fulfilled" reflects produced state:

```tsx
  if (!s.isPreorder) return <span className="pill pill--ink">Sale</span>;
  return s.producedAt ? (
    <span className="pill pill--success">📅 Preorder · produced</span>
  ) : (
    <span className="pill pill--warning">📅 Preorder · awaiting production</span>
  );
```

(If the API `Sale` list source for this page does not yet return `producedAt`, add `produced_at` to that endpoint's select and map it — check the GET that backs `/branch/sales`; mirror the camelCase mapping used for `fulfilledAt` there. If it returns `fulfilledAt` only, add `producedAt` alongside it.)

- [ ] **Step 2: Update the preorders-page copy (both)**

In `apps/admin/src/routes/branch/preorders.tsx` and `apps/admin/src/routes/owner/preorders.tsx`, update the `StatHero` `sub` / empty-state copy to call this the production worklist, e.g. `"Prepaid orders awaiting production at this branch. Producing deducts stock; delivery orders then go out for delivery."` No behaviour change — the API filter from Task 2 already keys the queue off `produced_at`.

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm --filter @ms/admin build`
Expected: PASS.

- [ ] **Step 4: Manual eyeball + full API suite**

In `pnpm dev:admin`: produce a delivery preorder, confirm it leaves the Preorders list and the Today's-sales row reads "Preorder · produced". Then run the whole API suite to catch cross-test regressions:

Run: `pnpm --filter @ms/api test`
Expected: PASS (modulo any pre-existing failures noted in project memory — compare against a clean baseline; do not let a NEW failure through).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/routes/branch/sales.tsx apps/admin/src/routes/branch/preorders.tsx apps/admin/src/routes/owner/preorders.tsx
git commit -m "feat(admin): preorder/sales lists reflect produced (not delivered) state"
```

---

# Phase 2 — Till nav consolidation (13 → 7)

### Task 9: `BranchTabs` shared component + cap-aware item filter

**Files:**
- Create: `apps/admin/src/components/BranchTabs.tsx`
- Create: `apps/admin/src/components/branch-tabs.ts` (pure helper)
- Test: Create `apps/admin/src/components/branch-tabs.test.ts`

**Interfaces:**
- Consumes: `useAuthUser` (capabilities), `Capability` from `@ms/shared`, TanStack `Link`.
- Produces: `visibleTabs(tabs, capabilities)` filter helper, and `<BranchTabs items={...} />` rendering an active-aware tab strip.

- [ ] **Step 1: Write the failing unit test for the filter helper**

Create `apps/admin/src/components/branch-tabs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { visibleTabs, type BranchTab } from "./branch-tabs.js";

const tabs: BranchTab[] = [
  { to: "/branch/online-orders", label: "Online", cap: "sales.view" },
  { to: "/branch/preorders", label: "Preorders", cap: "pos.preorder" },
  { to: "/branch/stock", label: "On hand" }, // no cap → always
];

describe("visibleTabs", () => {
  it("keeps only tabs the user can reach (cap present or no cap)", () => {
    expect(visibleTabs(tabs, ["pos.preorder"]).map((t) => t.label)).toEqual(["Preorders", "On hand"]);
  });
  it("an empty-capability user (owner sentinel) sees all tabs", () => {
    expect(visibleTabs(tabs, []).map((t) => t.label)).toEqual(["Online", "Preorders", "On hand"]);
  });
});
```

(Confirm the empty-capabilities convention against `BranchShell`'s existing `useOnlineOrderSignal` gate: `!user.capabilities.length || includes(...)`. Mirror it: an empty array means "all".)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ms/admin exec vitest run src/components/branch-tabs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `apps/admin/src/components/branch-tabs.ts`:

```ts
import type { Capability } from "@ms/shared";

export interface BranchTab {
  to: string;
  label: string;
  cap?: Capability;
}

/** Tabs the user can reach: no cap = always; empty caps = owner sentinel = all. */
export function visibleTabs(tabs: BranchTab[], capabilities: Capability[]): BranchTab[] {
  if (capabilities.length === 0) return tabs;
  return tabs.filter((t) => !t.cap || capabilities.includes(t.cap));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @ms/admin exec vitest run src/components/branch-tabs.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the component**

Create `apps/admin/src/components/BranchTabs.tsx`:

```tsx
import { Link, useRouterState } from "@tanstack/react-router";
import { useAuthUser } from "../lib/auth.js";
import { visibleTabs, type BranchTab } from "./branch-tabs.js";

/** Sub-page tab strip rendered under a grouped page's header. */
export function BranchTabs({ items }: { items: BranchTab[] }): JSX.Element | null {
  const user = useAuthUser();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const tabs = visibleTabs(items, user.capabilities);
  if (tabs.length <= 1) return null;
  return (
    <nav className="branch-tabs" style={{ display: "flex", gap: 6, margin: "0 0 14px", flexWrap: "wrap" }}>
      {tabs.map((t) => {
        const active = path === t.to || path.startsWith(t.to + "/");
        return (
          <Link
            key={t.to}
            to={t.to}
            className={`btn btn--sm ${active ? "btn--primary" : "btn--subtle"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 6: Typecheck + build**

Run: `pnpm typecheck && pnpm --filter @ms/admin build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/components/BranchTabs.tsx apps/admin/src/components/branch-tabs.ts apps/admin/src/components/branch-tabs.test.ts
git commit -m "feat(admin): BranchTabs shared sub-page tab strip + cap-aware filter"
```

---

### Task 10: Collapse the nav to 7 + prefix-active parents

**Files:**
- Modify: `apps/admin/src/components/BranchShell.tsx:35-49` (NAV array), `:60-115` (badge polling), `:166-200` (render + active)
- Create: `apps/admin/src/components/branch-nav.ts` (pure helpers)
- Test: Create `apps/admin/src/components/branch-nav.test.ts`

**Interfaces:**
- Consumes: `Capability`.
- Produces: `BRANCH_NAV` (7 parents, each with `to`, `label`, `icon`, optional `cap`, optional `caps` for "any of"), `parentVisible(item, caps)`, `isParentActive(item, pathname, groupPaths)`.

- [ ] **Step 1: Write the failing unit test**

Create `apps/admin/src/components/branch-nav.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parentVisible, isParentActive, type BranchNavItem } from "./branch-nav.js";

const orders: BranchNavItem = {
  to: "/branch/online-orders", label: "Orders", icon: "🛒",
  caps: ["sales.view", "pos.preorder"],
  group: ["/branch/online-orders", "/branch/preorders"],
};

describe("parentVisible", () => {
  it("shows when the user has ANY of the parent's caps", () => {
    expect(parentVisible(orders, ["pos.preorder"])).toBe(true);
  });
  it("hides when the user has none of them", () => {
    expect(parentVisible(orders, ["returns.create"])).toBe(false);
  });
  it("empty caps (owner) always shows", () => {
    expect(parentVisible(orders, [])).toBe(true);
  });
});

describe("isParentActive", () => {
  it("is active on any route in the group (incl. detail children)", () => {
    expect(isParentActive(orders, "/branch/preorders")).toBe(true);
    expect(isParentActive(orders, "/branch/online-orders/abc-123")).toBe(true);
    expect(isParentActive(orders, "/branch/stock")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ms/admin exec vitest run src/components/branch-nav.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers + nav data**

Create `apps/admin/src/components/branch-nav.ts`:

```ts
import type { Capability } from "@ms/shared";

export interface BranchNavItem {
  to: string;            // where the parent links (the group's primary route)
  label: string;
  icon: string;
  cap?: Capability;      // single required cap
  caps?: Capability[];   // OR: any-of these caps
  group?: string[];      // route prefixes that mark this parent active
}

/** Visible if the user has the single cap, ANY of `caps`, no cap at all, or is the empty-caps owner. */
export function parentVisible(item: BranchNavItem, capabilities: Capability[]): boolean {
  if (capabilities.length === 0) return true;
  if (item.cap) return capabilities.includes(item.cap);
  if (item.caps) return item.caps.some((c) => capabilities.includes(c));
  return true;
}

/** Active when the current path is the parent's `to` or any route in its group (prefix match). */
export function isParentActive(item: BranchNavItem, pathname: string): boolean {
  const prefixes = item.group ?? [item.to];
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export const BRANCH_NAV: BranchNavItem[] = [
  { to: "/branch/sell", label: "Sell", icon: "🥤", cap: "pos.preorder", group: ["/branch/sell"] },
  { to: "/branch", label: "Today", icon: "🏠", cap: "sales.view", group: ["/branch", "/branch/sales"] },
  { to: "/branch/online-orders", label: "Orders", icon: "🛒", caps: ["sales.view", "pos.preorder"], group: ["/branch/online-orders", "/branch/preorders"] },
  { to: "/branch/stock", label: "Stock", icon: "📊", group: ["/branch/stock", "/branch/transfers"] },
  { to: "/branch/returns", label: "Returns", icon: "↩️", cap: "returns.create", group: ["/branch/returns"] },
  { to: "/branch/shift-start", label: "Shift", icon: "🗂️", caps: ["shift_open.submit", "daily_close.submit"], group: ["/branch/shift-start", "/branch/close", "/branch/closes"] },
  { to: "/branch/device", label: "Device", icon: "📱", group: ["/branch/device", "/branch/queue"] },
];
```

Note: the `Today` parent's `group` includes `/branch` — guard against `/branch` matching every `/branch/*` route. `isParentActive` uses exact-equality OR `startsWith(p + "/")`, so `/branch` matches only `/branch` and `/branch/...`. Because `Today`'s group also lists `/branch/sales` explicitly and every OTHER parent is checked too, ensure the render picks the **most specific** active parent: when multiple parents match (e.g. `/branch/sell` matches both `Sell` and `Today` via `/branch`), prefer the parent whose matched prefix is longest. Add this tie-breaker helper:

```ts
/** The single parent to highlight for a path: the one with the longest matching group prefix. */
export function activeParent(items: BranchNavItem[], pathname: string): BranchNavItem | undefined {
  let best: BranchNavItem | undefined;
  let bestLen = -1;
  for (const item of items) {
    for (const p of item.group ?? [item.to]) {
      if ((pathname === p || pathname.startsWith(p + "/")) && p.length > bestLen) {
        best = item; bestLen = p.length;
      }
    }
  }
  return best;
}
```

Add a test for `activeParent` to `branch-nav.test.ts`:

```ts
import { activeParent } from "./branch-nav.js";
import { BRANCH_NAV } from "./branch-nav.js";

describe("activeParent (most specific wins)", () => {
  it("/branch/sell → Sell, not Today", () => {
    expect(activeParent(BRANCH_NAV, "/branch/sell")?.label).toBe("Sell");
  });
  it("/branch/sales → Today", () => {
    expect(activeParent(BRANCH_NAV, "/branch/sales")?.label).toBe("Today");
  });
  it("/branch (home) → Today", () => {
    expect(activeParent(BRANCH_NAV, "/branch")?.label).toBe("Today");
  });
  it("/branch/preorders → Orders", () => {
    expect(activeParent(BRANCH_NAV, "/branch/preorders")?.label).toBe("Orders");
  });
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @ms/admin exec vitest run src/components/branch-nav.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `BranchShell` to render the 7 parents**

In `apps/admin/src/components/BranchShell.tsx`:
1. Delete the local `NAV` array (lines 35-49) and the `BranchNavLink` interface (28-33).
2. Import: `import { BRANCH_NAV, parentVisible, activeParent } from "./branch-nav.js";` and `import { useRouterState } from "@tanstack/react-router";`.
3. In the component, compute the active parent: `const pathname = useRouterState({ select: (s) => s.location.pathname }); const active = activeParent(BRANCH_NAV, pathname);`
4. Replace the `NAV.filter(...).map(...)` render (lines 166-200) with a render over `BRANCH_NAV.filter((item) => parentVisible(item, user.capabilities))`, using `className={`app-nav__link${active?.to === item.to ? " is-active" : ""}`}` instead of TanStack `activeProps` (which only matches the exact `to`). Keep the badge logic but move it onto the right parents (Task 12 finalizes badges).

- [ ] **Step 6: Typecheck + build**

Run: `pnpm typecheck && pnpm --filter @ms/admin build`
Expected: PASS.

- [ ] **Step 7: Manual eyeball**

In `pnpm dev:admin`, the till sidebar now shows 7 items. Visiting `/branch/preorders` highlights **Orders**; `/branch/transfers` highlights **Stock**; `/branch/sales` highlights **Today**; `/branch/queue` highlights **Device**.

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/components/BranchShell.tsx apps/admin/src/components/branch-nav.ts apps/admin/src/components/branch-nav.test.ts
git commit -m "feat(admin): collapse till nav to 7 parents with prefix-active highlighting"
```

---

### Task 11: Add tab strips to the grouped pages

**Files:**
- Modify: `apps/admin/src/routes/branch/home.tsx`, `branch/sales.tsx`, `branch/online-orders.tsx`, `branch/preorders.tsx`, `branch/stock.tsx`, `branch/transfers.tsx`, `branch/shift-start.tsx`, `branch/close.tsx`, `branch/closes.tsx`, `branch/device.tsx`, `branch/queue.tsx`

**Interfaces:**
- Consumes: `<BranchTabs items={...} />` (Task 9).

- [ ] **Step 1: Define the four tab sets and drop `<BranchTabs>` into each page**

Add `<BranchTabs items={...} />` just under each page's header/`StatHero`. Use these item sets (copy verbatim per group):

```tsx
// Today group — in home.tsx and sales.tsx
<BranchTabs items={[
  { to: "/branch", label: "Overview", cap: "sales.view" },
  { to: "/branch/sales", label: "Today's sales", cap: "sales.view" },
]} />

// Orders group — in online-orders.tsx and preorders.tsx
<BranchTabs items={[
  { to: "/branch/online-orders", label: "Online", cap: "sales.view" },
  { to: "/branch/preorders", label: "Preorders", cap: "pos.preorder" },
]} />

// Stock group — in stock.tsx and transfers.tsx
<BranchTabs items={[
  { to: "/branch/stock", label: "On hand" },
  { to: "/branch/transfers", label: "Incoming", cap: "transfers.receive" },
]} />

// Device group — in device.tsx and queue.tsx
<BranchTabs items={[
  { to: "/branch/device", label: "Device" },
  { to: "/branch/queue", label: "Sync queue" },
]} />
```

(Shift group is handled in Task 13 because its tabs are state-dependent.)

- [ ] **Step 2: Typecheck + build**

Run: `pnpm typecheck && pnpm --filter @ms/admin build`
Expected: PASS.

- [ ] **Step 3: Manual eyeball**

Each grouped page shows its tab strip; clicking a tab navigates to the sibling route and highlights it. The parent nav item stays highlighted throughout (Task 10).

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/routes/branch/home.tsx apps/admin/src/routes/branch/sales.tsx apps/admin/src/routes/branch/online-orders.tsx apps/admin/src/routes/branch/preorders.tsx apps/admin/src/routes/branch/stock.tsx apps/admin/src/routes/branch/transfers.tsx apps/admin/src/routes/branch/device.tsx apps/admin/src/routes/branch/queue.tsx
git commit -m "feat(admin): add sub-page tab strips to grouped till pages"
```

---

### Task 12: Combined Orders badge + Stock incoming badge

**Files:**
- Modify: `apps/admin/src/components/BranchShell.tsx:60-115` (polling), `:166-200` (badge render)

**Interfaces:**
- Consumes: `useOnlineOrderSignal` (online count), preorder poll (existing), a new transfers-to-receive poll.
- Produces: Orders badge = `signal.count + preorderCount`; Stock badge = count of transfers in `dispatched|in_transit|arrived`.

- [ ] **Step 1: Add a transfers-to-receive poll**

In `BranchShell`, add state `const [incomingCount, setIncomingCount] = useState(0);` and an effect mirroring the existing preorder poll (60s interval + on-focus), fetching `/v1/transfers?branch_id=${branchId}` and counting rows whose `status` is `dispatched`, `in_transit`, or `arrived`:

```tsx
  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      try {
        const res = await fetch(`/v1/transfers?branch_id=${branchId}`, { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as { data: Array<{ status: string }> };
        const n = Array.isArray(body.data)
          ? body.data.filter((t) => ["dispatched", "in_transit", "arrived"].includes(t.status)).length
          : 0;
        if (!cancelled) setIncomingCount(n);
      } catch { /* offline — keep last known */ }
    }
    void refresh();
    const id = window.setInterval(() => void refresh(), 60_000);
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [branchId]);
```

- [ ] **Step 2: Compute per-parent badges in the render**

In the `BRANCH_NAV` map, set the badge by parent `to`:

```tsx
            const badge =
              item.to === "/branch/online-orders" ? (signal.count + preorderCount) || null :
              item.to === "/branch/stock" ? (incomingCount || null) :
              null;
```

Keep the existing pill markup; update its `aria-label` to suit ("N orders awaiting attention" / "N transfers to receive").

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm --filter @ms/admin build`
Expected: PASS.

- [ ] **Step 4: Manual eyeball**

With a paid online order + a paid preorder, the **Orders** item shows their combined count. With a dispatched/in-transit transfer to this branch, **Stock** shows an incoming count badge; receiving it clears the badge on next poll/focus.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/components/BranchShell.tsx
git commit -m "feat(admin): combined Orders badge + Stock incoming-transfer badge"
```

---

### Task 13: Smart Shift item (start vs end by state) + Shift tabs

**Files:**
- Create: `apps/admin/src/routes/branch/shift.tsx` (resolver) + route in `apps/admin/src/router.tsx`
- Modify: `apps/admin/src/components/branch-nav.ts` (point Shift parent at the resolver)
- Modify: `branch/shift-start.tsx`, `branch/close.tsx`, `branch/closes.tsx` (contextual tab strip)

**Interfaces:**
- Consumes: `hasOpenShift(branchId: string): Promise<boolean>` from `apps/admin/src/sync/local-shift-open.js` — the exact source `sell.tsx` uses for its shift gate (it `await import("../../sync/local-shift-open.js")` then calls `hasOpenShift`). Do not invent a new endpoint.
- Produces: a `/branch/shift` route that redirects to `/branch/shift-start` (no open shift) or `/branch/close` (open shift); a contextual Shift tab strip driven by the same `hasOpenShift` result.

- [ ] **Step 1: Implement the resolver route**

Create `apps/admin/src/routes/branch/shift.tsx`. It calls `hasOpenShift(branchId)` in an effect, then `useNavigate({ replace: true })`-redirects: `true` → `/branch/close`; `false` → `/branch/shift-start`. Render an `InlineLoader` while the boolean is still `null` (loading), mirroring the `hasShift === null` loading pattern in `sell.tsx:102-109`:

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { InlineLoader } from "../../components/Spinner.js";

export function BranchShiftResolverPage({ branchId }: { branchId: string }): JSX.Element {
  const navigate = useNavigate();
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { hasOpenShift } = await import("../../sync/local-shift-open.js");
      const isOpen = await hasOpenShift(branchId);
      if (cancelled) return;
      setOpen(isOpen);
      void navigate({ to: isOpen ? "/branch/close" : "/branch/shift-start", replace: true });
    })();
    return () => { cancelled = true; };
  }, [branchId, navigate]);
  return <InlineLoader label="Opening shift…" />;
}
```

Register it in `router.tsx` at path `/branch/shift` following the existing `WithBranchId` + `guarded(<L>...)` pattern (mirror `branchShiftStartRoute`), import it via `lazyNamed`, and add the route to the `routeTree` children list.

- [ ] **Step 2: Point the Shift nav parent at the resolver**

In `branch-nav.ts`, change the Shift item's `to` from `/branch/shift-start` to `/branch/shift` (keep the same `group` prefixes so it stays active on start/close/closes). Add `/branch/shift` to its `group` too.

- [ ] **Step 3: Add the contextual Shift tab strip**

In `shift-start.tsx`, `close.tsx`, and `closes.tsx`, resolve `hasOpenShift(branchId)` into local boolean state (same `await import("../../sync/local-shift-open.js")` pattern), then render a `<BranchTabs>` whose items depend on it: when no shift open `[{to:"/branch/shift-start",label:"Start",cap:"shift_open.submit"},{to:"/branch/closes",label:"History"}]`; when open `[{to:"/branch/close",label:"End",cap:"daily_close.submit"},{to:"/branch/closes",label:"History"}]`. While the boolean is still loading, render the no-open variant (or no strip) to avoid a flash.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck && pnpm --filter @ms/admin build`
Expected: PASS.

- [ ] **Step 5: Manual eyeball**

Tapping **Shift** with no open shift lands on Start (tabs: Start · History); with an open shift lands on End (tabs: End · History). History is always reachable.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/routes/branch/shift.tsx apps/admin/src/router.tsx apps/admin/src/components/branch-nav.ts apps/admin/src/routes/branch/shift-start.tsx apps/admin/src/routes/branch/close.tsx apps/admin/src/routes/branch/closes.tsx
git commit -m "feat(admin): smart Shift nav (start/end by state) + contextual shift tabs"
```

---

## Final verification (before declaring done)

- [ ] `pnpm typecheck` — PASS
- [ ] `pnpm --filter @ms/api test` — PASS (no NEW failures vs baseline)
- [ ] `pnpm --filter @ms/admin test` — PASS (journey, fulfil-action, branch-tabs, branch-nav)
- [ ] `pnpm --filter @ms/admin build` — PASS
- [ ] Real-order eyeball: place a real online **delivery preorder** → Preorders/Orders badge increments → open it → "Fulfil & produce" → it leaves the production worklist, online list reads "Ready", journey shows production done → "Mark out for delivery" → "Mark delivered" → gone from active queues. Repeat for a **pickup** online preorder (one tap completes it). Confirm the same on the **owner** screens.
- [ ] Deploy note: this ships migration `0060`; after deploy, tills need a hard PWA refresh.

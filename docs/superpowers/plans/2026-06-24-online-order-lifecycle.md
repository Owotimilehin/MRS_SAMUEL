# Online-order Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make online orders visible and completable end-to-end (owner + till), surface the full Shipbubble rider journey, show customers live stock, close walk-up sales conclusively, and stop abandoned/cancelled orders from polluting counts.

**Architecture:** The `sale_status` enum and `delivery_order` rider state machine already exist; this work *drives* and *surfaces* them. New API: a channel-aware `advance` transition + an online-orders queue feed. Reports and `/pay` are corrected so counter sales terminate and unpaid/cancelled orders drop out. Admin/customer UIs gain queues, badges, toast/chime, advance buttons, and a delivery rider panel (the sale-detail API already returns the full delivery row).

**Tech Stack:** TypeScript monorepo (pnpm). API = Hono + Drizzle (Postgres). Worker = node cron jobs. Admin + Customer = React + TanStack Router. Tests = vitest (API integration in `apps/api/test/integration`, worker in `apps/worker/test`, domain/shared unit).

## Global Constraints

- Run all commands from the worktree root: `C:\Users\owoti\Desktop\MRS SAMUEL FRUIT JUICE\mrs-samuel\.claude\worktrees\online-order-lifecycle`.
- Branch base: origin/master `c055a8b`. Do NOT touch the parent checkout (active Payaza session).
- Low-stock "order now" nudge threshold: `available <= 5`.
- Auto-cancel unpaid `confirmed` online orders after: **60 minutes** (the reservation hold is 30 min).
- Counter / immediate-handover channels: `walkup`, in-store `whatsapp` only. **`chowdeck_pickup` is removed from UI + counter logic; the enum value is KEPT** (no destructive Postgres enum migration).
- Counter sales terminate at `handed_over` (displayed as "Completed").
- Branch staff caps are `pos.sell, pos.preorder, shift_open.submit, sales.view, transfers.receive` (no `orders.manage`). Gate branch fulfilment on `pos.sell` + `requireBranchScope()`; widen ride book/cancel to `requireAnyCapability("orders.manage","pos.sell")`.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit. Use `TZ=UTC` for API/worker tests.
- Money path (Payaza reconcile, refunds) is OUT OF SCOPE — do not modify `reconcile.ts` / payment endpoints.

**Test commands:**
- API: `cd apps/api && TZ=UTC pnpm vitest run test/integration/<file>` (needs the test Postgres the suite already boots).
- Worker: `cd apps/worker && TZ=UTC pnpm vitest run test/<file>`
- Shared/domain: `cd packages/shared && pnpm vitest run` / `cd packages/domain && pnpm vitest run`
- Typecheck: `pnpm -w typecheck`  Build: `pnpm -w build`

---

### Task 1: Customer stock visibility (#1)

Show per-flavour available stock on the storefront (exact count when in stock, "Made to order" otherwise). Availability is the per-flavour pool (`availableAtBranch`, keyed by productId) against the online-default branch — the SAME number checkout uses to decide preorder, so display and behaviour agree. Each `preorder_only` size always shows made-to-order regardless of pool.

**Files:**
- Modify: `apps/api/src/routes/public-catalog.ts` (add `available` to product output)
- Test: `apps/api/test/integration/public-catalog.test.ts` (create if absent)
- Modify: customer product display component (find with grep in Step 6)
- Modify: `apps/customer/src/lib/api/types.ts` (catalog product type)

**Interfaces:**
- Produces (API): each catalog product gains `available: number` (the online-default-branch pool for that product; `0` when no online-default branch or no stock). Variants keep `preorder_only: boolean`.
- Consumes: `availableAtBranch(db, { branchId, productId })` from `@ms/domain`; `branch.isOnlineDefault` to pick the branch.

- [ ] **Step 1: Write the failing API test**

In `apps/api/test/integration/public-catalog.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { makeTestApp, seedCatalog, setOnlineDefaultBranch, addBranchStock } from "./helpers.js";

describe("public catalog stock", () => {
  it("returns per-flavour available against the online-default branch", async () => {
    const { app, db } = await makeTestApp();
    const { productId, branchId } = await seedCatalog(db); // one flavour, one 330ml variant
    await setOnlineDefaultBranch(db, branchId);
    await addBranchStock(db, { branchId, productId, qty: 12 });

    const res = await app.request("/v1/public/catalog");
    const body = await res.json();
    const prod = body.data.find((p: any) => p.id === productId);
    expect(prod.available).toBe(12);
  });
});
```
If `seedCatalog/setOnlineDefaultBranch/addBranchStock` helpers don't exist, add thin wrappers in `helpers.ts` over the existing seed utilities (grep `helpers.ts` for the current catalog/branch/ledger insert helpers and reuse them).

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/api && TZ=UTC pnpm vitest run test/integration/public-catalog.test.ts`
Expected: FAIL — `prod.available` is `undefined`.

- [ ] **Step 3: Implement `available` in the catalog route**

In `public-catalog.ts`, after products + `variantsByProduct` are assembled and before returning, resolve the online-default branch once and attach the pool:
```ts
import { availableAtBranch } from "@ms/domain";
// ...
const [onlineBranch] = await db
  .select({ id: branch.id })
  .from(branch)
  .where(eq(branch.isOnlineDefault, true))
  .limit(1);
// attach to each product in the output list:
for (const p of out) {
  p.available = onlineBranch
    ? await availableAtBranch(db, { branchId: onlineBranch.id, productId: p.id })
    : 0;
}
```
Add `available: number` to the `CatalogProductOut` type in this file. Import `branch` from `@ms/db` and `eq` from `drizzle-orm` if not already imported.

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/api && TZ=UTC pnpm vitest run test/integration/public-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/routes/public-catalog.ts apps/api/test/integration/public-catalog.test.ts apps/api/test/integration/helpers.ts
git commit -m "feat(api): expose per-flavour available stock in public catalog"
```

- [ ] **Step 6: Wire the customer UI**

Find the product card/size display: `grep -rn "preorder_only\|preorderOnly\|size_ml\|variants" apps/customer/src/components apps/customer/src/routes | grep -i "product\|catalog\|card\|menu"`.
Add `available?: number` to the catalog product type in `apps/customer/src/lib/api/types.ts`. In the size/variant render, apply:
```tsx
function stockLabel(available: number | undefined, preorderOnly: boolean): JSX.Element {
  if (preorderOnly || (available ?? 0) <= 0) {
    return <span className="stock stock--made">Made to order — we can prepare more for you</span>;
  }
  if (available! <= 5) {
    return <span className="stock stock--low">{available} available — order now</span>;
  }
  return <span className="stock stock--ok">{available} available</span>;
}
```
Place it under each size row (per-size: pass that variant's `preorder_only`, and the product's `available`). Add minimal styles matching the existing storefront tokens (reuse an existing badge/pill class if one exists — grep `stock` / `badge` in customer styles first).

- [ ] **Step 7: Verify build + commit**

Run: `cd apps/customer && pnpm build`  Expected: build succeeds.
```bash
git add apps/customer/src
git commit -m "feat(customer): show per-size available stock + made-to-order line"
```

---

### Task 2: Honest awaiting count + counter sales close conclusively (#7, Rev B)

Redefine `online_pending` to *paid, non-preorder, not-yet-delivered/cancelled* online orders only (drop `confirmed`). Make counter channels terminate at `handed_over` inside `/pay`. Drop `chowdeck_pickup` from the counter set + the `/pay` channel zod enum.

**Files:**
- Modify: `apps/api/src/routes/reports.ts:345-349` (`onlinePendingRow` query)
- Modify: `apps/api/src/routes/sales.ts` (`/pay` finalisation ~440-445; `immediateHandover` ~267-268; channel zod ~32)
- Test: `apps/api/test/integration/reports-overview.test.ts` (create if absent) and `apps/api/test/integration/sales-flow.test.ts` (existing; add a case)

**Interfaces:**
- Produces: `/reports/overview` → `fulfilment.online_pending` excludes `confirmed`. Walk-up `/pay` returns a sale with `status: "handed_over"`.
- Consumes: existing `saleOrder` schema.

- [ ] **Step 1: Failing test — awaiting excludes unpaid confirmed**

In `apps/api/test/integration/reports-overview.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeTestApp, seedOnlineOrder, authOwner } from "./helpers.js";

describe("overview online_pending", () => {
  it("counts paid undelivered online orders but not unpaid confirmed ones", async () => {
    const { app, db } = await makeTestApp();
    await seedOnlineOrder(db, { status: "confirmed" }); // abandoned, unpaid
    await seedOnlineOrder(db, { status: "paid" });       // real awaiting
    const res = await app.request("/v1/reports/overview", { headers: await authOwner(db) });
    const body = await res.json();
    expect(body.data.fulfilment.online_pending).toBe(1);
  });
});
```
Add `seedOnlineOrder({ status })` to `helpers.ts` if missing (insert a `sale_order` with `channel:'online', isPreorder:false`, given status).

- [ ] **Step 2: Run, verify fail**

Run: `cd apps/api && TZ=UTC pnpm vitest run test/integration/reports-overview.test.ts`
Expected: FAIL — returns 2 (confirmed counted).

- [ ] **Step 3: Fix the query**

In `reports.ts`, change the `onlinePendingRow` query status filter from
`status IN ('confirmed','paid','handed_over','out_for_delivery')` to
`status IN ('paid','out_for_delivery')`
(paid = awaiting dispatch/handover; out_for_delivery = in flight; both are still "to fulfil". Exclude `confirmed` (unpaid) and `handed_over` because a counter handover is terminal — see Step 6.)

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/api && TZ=UTC pnpm vitest run test/integration/reports-overview.test.ts`
Expected: PASS.

- [ ] **Step 5: Failing test — counter sale terminates at handed_over**

In `apps/api/test/integration/sales-flow.test.ts` add:
```ts
it("walk-up sale terminates at handed_over after pay", async () => {
  const { app, db } = await makeTestApp();
  const { saleId, headers } = await seedConfirmedWalkupSale(db); // existing helper or thin wrapper
  const res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/pay`, {
    method: "PATCH", headers, body: "{}",
  });
  const body = await res.json();
  expect(body.data.status).toBe("handed_over");
});
```
(Reuse the file's existing walk-up seed/auth helpers; match its current pattern for `branchId`/headers.)

- [ ] **Step 6: Run fail, then implement counter-terminal at /pay**

Run the test → FAIL (`paid`). In `sales.ts` `/pay`, after computing the paid update, advance counter channels to terminal in the SAME transaction:
```ts
const counterChannels = new Set(["walkup", "whatsapp"]); // chowdeck_pickup removed
const finalStatus = counterChannels.has(o.channel) ? "handed_over" as const : "paid" as const;
// use finalStatus in the .set({ status: finalStatus, paymentStatus: "paid", ... })
```
Also update `immediateHandover` (~line 267) to `o.channel === "walkup"` only (drop `chowdeck_pickup`), and remove `chowdeck_pickup` from the `/pay` request channel zod enum (~line 32) → `z.enum(["walkup","online","phone","whatsapp"])`. Leave the `customerSource` mapping (`: "chowdeck"`) and `chowdeck_external` payment method untouched.

- [ ] **Step 7: Run pass + full sales suite**

Run: `cd apps/api && TZ=UTC pnpm vitest run test/integration/sales-flow.test.ts test/integration/reports-overview.test.ts`
Expected: PASS (and no regressions in sales-flow).

- [ ] **Step 8: Commit**
```bash
git add apps/api/src/routes/reports.ts apps/api/src/routes/sales.ts apps/api/test/integration
git commit -m "fix(api): honest online_pending + counter sales terminate at handed_over; drop chowdeck counter"
```

---

### Task 3: Auto-cancel abandoned unpaid online orders (#6/#7)

A worker sweep marks `confirmed` online orders older than 60 minutes (unpaid, no live payment) as `cancelled` with reason `payment_expired` and releases any reservation. Reuses the worker's existing reservation/cron plumbing.

**Files:**
- Create: `apps/worker/src/jobs/expire-unpaid-orders.ts`
- Modify: worker job registry (find with grep — e.g. `apps/worker/src/index.ts` / `outbox.ts` cron list)
- Test: `apps/worker/test/expire-unpaid-orders.test.ts`

**Interfaces:**
- Produces: `expireUnpaidOrders(db, now?: Date): Promise<number>` — returns count cancelled.
- Consumes: `saleOrder`, `stockReservation` from `@ms/db`.

- [ ] **Step 1: Failing test**

In `apps/worker/test/expire-unpaid-orders.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeTestDb, insertSaleOrder } from "./helpers.js"; // match existing worker test helpers
import { expireUnpaidOrders } from "../src/jobs/expire-unpaid-orders.js";

describe("expireUnpaidOrders", () => {
  it("cancels unpaid confirmed online orders older than 60m, leaves paid + recent alone", async () => {
    const db = await makeTestDb();
    const old = new Date(Date.now() - 61 * 60_000);
    const recent = new Date(Date.now() - 5 * 60_000);
    const a = await insertSaleOrder(db, { channel: "online", status: "confirmed", createdAt: old });
    await insertSaleOrder(db, { channel: "online", status: "confirmed", createdAt: recent });
    await insertSaleOrder(db, { channel: "online", status: "paid", createdAt: old });

    const n = await expireUnpaidOrders(db);
    expect(n).toBe(1);
    const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, a));
    expect(row.status).toBe("cancelled");
    expect(row.cancelReason).toBe("payment_expired");
  });
});
```
If the worker test suite has no DB harness, mirror the API integration harness setup (grep `apps/worker/test` for existing `makeTestDb`/helpers; reuse them).

- [ ] **Step 2: Run, verify fail**

Run: `cd apps/worker && TZ=UTC pnpm vitest run test/expire-unpaid-orders.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the job**
```ts
import { and, eq, lt, sql } from "drizzle-orm";
import { saleOrder, stockReservation, type DbClient } from "@ms/db";

const WINDOW_MS = 60 * 60_000;

/** Cancel unpaid 'confirmed' online orders past the payment window; free holds. */
export async function expireUnpaidOrders(db: DbClient, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  return db.transaction(async (tx) => {
    const stale = await tx
      .update(saleOrder)
      .set({ status: "cancelled", cancelReason: "payment_expired", cancelledAt: now, updatedAt: now })
      .where(and(
        eq(saleOrder.channel, "online"),
        eq(saleOrder.status, "confirmed"),
        eq(saleOrder.paymentStatus, "pending"),
        lt(saleOrder.createdAtLocal, cutoff),
      ))
      .returning({ id: saleOrder.id });
    for (const s of stale) {
      await tx.delete(stockReservation).where(eq(stockReservation.saleOrderId, s.id));
    }
    return stale.length;
  });
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/worker && TZ=UTC pnpm vitest run test/expire-unpaid-orders.test.ts`
Expected: PASS.

- [ ] **Step 5: Register on the cron**

Find the worker's job scheduler (grep `setInterval\|cron\|every\|runJob` in `apps/worker/src`). Register `expireUnpaidOrders(db)` on a 5-minute interval, wrapped in the existing per-job isolation (`runJob`) so a failure can't crash the loop. Match the registration style of a neighbouring job (e.g. the reservation sweep).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm -w typecheck`  Expected: clean.
```bash
git add apps/worker/src apps/worker/test
git commit -m "feat(worker): auto-cancel abandoned unpaid online orders after 60m"
```

---

### Task 4: Channel-aware `advance` transition + branch-scoped ride booking (#4, #5)

Add one branch-scoped, channel-aware fulfilment transition on the sales sub-router, and widen ride book/cancel so branch staff can use them.

**Files:**
- Modify: `apps/api/src/routes/sales.ts` (add `PATCH /:id/advance`)
- Modify: `apps/api/src/routes/delivery-admin.ts:79,146` (`requireCapability("orders.manage")` → `requireAnyCapability("orders.manage","pos.sell")`; add `requireBranchScope()` if not already on the router)
- Test: `apps/api/test/integration/online-fulfilment.test.ts` (create)

**Interfaces:**
- Produces: `PATCH /v1/branches/:branchId/sales/:saleId/advance` → advances to the next legal status for the order's fulfilment type; returns `{ data: <updated sale_order> }`. 409 on illegal transition; 403 on branch mismatch.
- Fulfilment type: an online order is **delivery** if `deliveryAddressFormatted` OR `deliveryState` is set OR `deliveryFeeNgn > 0` OR a `delivery_order` row exists; else **pickup**.
- Legal transitions — delivery: `paid → out_for_delivery → delivered`; pickup: `paid → handed_over → delivered`.

- [ ] **Step 1: Failing tests**

In `apps/api/test/integration/online-fulfilment.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeTestApp, seedOnlineOrder, authOwner, authBranchStaff } from "./helpers.js";

describe("online order advance", () => {
  it("delivery order: paid -> out_for_delivery -> delivered", async () => {
    const { app, db } = await makeTestApp();
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "paid", deliveryState: "Lagos", deliveryFeeNgn: 1500 });
    const h = await authOwner(db);
    let res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/advance`, { method: "PATCH", headers: h, body: "{}" });
    expect((await res.json()).data.status).toBe("out_for_delivery");
    res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/advance`, { method: "PATCH", headers: h, body: "{}" });
    expect((await res.json()).data.status).toBe("delivered");
  });

  it("pickup order: paid -> handed_over -> delivered", async () => {
    const { app, db } = await makeTestApp();
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "paid" }); // no delivery signals
    const h = await authOwner(db);
    let res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/advance`, { method: "PATCH", headers: h, body: "{}" });
    expect((await res.json()).data.status).toBe("handed_over");
  });

  it("rejects advancing a delivered order", async () => {
    const { app, db } = await makeTestApp();
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "delivered" });
    const res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/advance`, { method: "PATCH", headers: await authOwner(db), body: "{}" });
    expect(res.status).toBe(409);
  });

  it("forbids a branch_staff from advancing another branch's order", async () => {
    const { app, db } = await makeTestApp();
    const { saleId, branchId } = await seedOnlineOrder(db, { status: "paid" });
    const otherStaff = await authBranchStaff(db, { branchId: "different" });
    const res = await app.request(`/v1/branches/${branchId}/sales/${saleId}/advance`, { method: "PATCH", headers: otherStaff, body: "{}" });
    expect(res.status).toBe(403);
  });
});
```
Extend `seedOnlineOrder` to accept `{ deliveryState?, deliveryFeeNgn? }`. Add `authBranchStaff(db,{branchId})` if missing (mirror `authOwner`).

- [ ] **Step 2: Run, verify fail**

Run: `cd apps/api && TZ=UTC pnpm vitest run test/integration/online-fulfilment.test.ts`
Expected: FAIL — 404 (route missing).

- [ ] **Step 3: Implement `/advance`**

Add to `saleRoutes` in `sales.ts` (the router is already mounted under `/v1/branches/:branchId/sales`). Put `requireBranchScope()` before the capability gate:
```ts
r.patch("/:id/advance", requireBranchScope(), requireCapability("pos.sell"), async (c) => {
  const id = c.req.param("id");
  if (!id) throw new BusinessError("validation_failed", "id required", 400);
  const updated = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
    if (!o) throw new BusinessError("not_found", "sale not found", 404);
    if (!["online", "phone"].includes(o.channel)) {
      throw new BusinessError("conflict", `not an online order: ${o.channel}`, 409);
    }
    const { deliveryOrder } = await import("@ms/db");
    const [del] = await tx.select({ id: deliveryOrder.id }).from(deliveryOrder).where(eq(deliveryOrder.saleOrderId, id)).limit(1);
    const isDelivery = !!o.deliveryAddressFormatted || !!o.deliveryState || o.deliveryFeeNgn > 0 || !!del;
    const path = isDelivery
      ? { paid: "out_for_delivery", out_for_delivery: "delivered" }
      : { paid: "handed_over", handed_over: "delivered" };
    const next = (path as Record<string, string>)[o.status];
    if (!next) throw new BusinessError("conflict", `cannot advance from ${o.status}`, 409);
    const now = new Date();
    const patch: Record<string, unknown> = { status: next, updatedAt: now };
    if (next === "out_for_delivery") patch["outForDeliveryAt"] = now;
    if (next === "delivered") patch["fulfilledAt"] = now;
    const [u] = await tx.update(saleOrder).set(patch).where(eq(saleOrder.id, id)).returning();
    if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);
    return u;
  });
  await writeAudit(db, c, { action: "sale.advance", entityType: "sale_order", entityId: id, after: updated });
  return c.json({ data: updated });
});
```
Import `requireBranchScope` from `../middleware/scope.js` if not already. Add an `"sale.advance"` humanizer entry in `apps/admin/src/lib/audit-humanize.ts` (e.g. `"Order advanced"`).

- [ ] **Step 4: Widen ride book/cancel for branch staff**

In `delivery-admin.ts`, change the two `requireCapability("orders.manage")` (book ~79, cancel ~146) to `requireAnyCapability("orders.manage", "pos.sell")` and ensure `requireBranchScope()` runs on the router (it has `:branchId` in its mount path). Import `requireAnyCapability` from `../middleware/auth.js`.

- [ ] **Step 5: Run, verify pass**

Run: `cd apps/api && TZ=UTC pnpm vitest run test/integration/online-fulfilment.test.ts`
Expected: PASS (all 4).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm -w typecheck`  Expected: clean.
```bash
git add apps/api/src/routes/sales.ts apps/api/src/routes/delivery-admin.ts apps/admin/src/lib/audit-humanize.ts apps/api/test/integration/online-fulfilment.test.ts apps/api/test/integration/helpers.ts
git commit -m "feat(api): channel-aware online-order advance + branch-scoped ride booking"
```

---

### Task 5: Online Orders queue feed API (#2, #3)

One endpoint backs the owner + branch queue screens, the nav badge count, and the new-order toast/chime delta.

**Files:**
- Create: `apps/api/src/routes/online-orders-queue.ts`
- Modify: `apps/api/src/test-app.ts` (mount at `/v1/online-orders` after the existing `paymentsAdminRoutes` mount — Hono matches both sub-apps at that prefix; the production app builder is `test-app.ts`)
- Test: `apps/api/test/integration/online-orders-queue.test.ts`

**Interfaces:**
- Produces:
  - `GET /v1/online-orders/active` → `{ data: Array<{ id, order_number, branch_id, status, channel, total_ngn, created_at_local, customer_name, customer_phone, is_delivery, delivery_status }> }`, newest first. Owner/admin/manager = all branches; branch staff = own branch only (filter by `auth.branchId`).
  - `GET /v1/online-orders/active-count?since=<ISO>` → `{ data: { count: number, newest: string | null, new_since: number } }` where `count` = active awaiting (paid/out_for_delivery online), `newest` = max `created_at_local`, `new_since` = how many created after `since` (drives toast/chime).
- "Active" = `channel IN ('online','phone') AND status IN ('paid','out_for_delivery')`.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from "vitest";
import { makeTestApp, seedOnlineOrder, authOwner, authBranchStaff } from "./helpers.js";

describe("online orders queue", () => {
  it("lists active online orders newest-first", async () => {
    const { app, db } = await makeTestApp();
    await seedOnlineOrder(db, { status: "paid" });
    await seedOnlineOrder(db, { status: "confirmed" }); // not active
    const res = await app.request("/v1/online-orders/active", { headers: await authOwner(db) });
    const body = await res.json();
    expect(body.data.length).toBe(1);
  });

  it("active-count reports new_since", async () => {
    const { app, db } = await makeTestApp();
    const since = new Date(Date.now() - 1000).toISOString();
    await seedOnlineOrder(db, { status: "paid" });
    const res = await app.request(`/v1/online-orders/active-count?since=${encodeURIComponent(since)}`, { headers: await authOwner(db) });
    const body = await res.json();
    expect(body.data.count).toBe(1);
    expect(body.data.new_since).toBe(1);
  });

  it("branch staff only see their branch", async () => {
    const { app, db } = await makeTestApp();
    const { branchId } = await seedOnlineOrder(db, { status: "paid" });
    const res = await app.request("/v1/online-orders/active", { headers: await authBranchStaff(db, { branchId: "other" }) });
    expect((await res.json()).data.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd apps/api && TZ=UTC pnpm vitest run test/integration/online-orders-queue.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Implement the router**

Create `online-orders-queue.ts` exporting `onlineOrdersQueueRoutes(db)`. Use `requireAuth()` + `requireCapability("sales.view")` (branch staff have it). Branch filter:
```ts
const auth = c.get("auth");
const branchScoped = auth.role === "branch_staff" ? auth.branchId : null;
```
`active` query (Drizzle or raw SQL) joins `customer` for name/phone, left-joins latest `delivery_order` for `delivery_status`, computes `is_delivery` like Task 4, filters active + optional branch, orders by `created_at_local desc`. `active-count` reads `count`, `max(created_at_local)`, and `count(created_at_local > since)`.

- [ ] **Step 4: Mount + run pass**

In `test-app.ts`, after the `paymentsAdminRoutes` line add:
```ts
app.route("/v1/online-orders", onlineOrdersQueueRoutes(db));
```
Run: `cd apps/api && TZ=UTC pnpm vitest run test/integration/online-orders-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/routes/online-orders-queue.ts apps/api/src/test-app.ts apps/api/test/integration/online-orders-queue.test.ts
git commit -m "feat(api): online-orders queue feed + active-count for badge/toast"
```

---

### Task 6: Owner order-detail — advance buttons + delivery rider panel (#5, Rev A)

The sale-detail API already returns the full `delivery` row; this is frontend-only.

**Files:**
- Modify: `apps/admin/src/routes/owner/order-detail.tsx`
- Create: `apps/admin/src/components/DeliveryStatusPanel.tsx` (shared by owner + branch + can inform customer copy)

**Interfaces:**
- Consumes: `data.status`, `data.channel`, delivery signals, and `data.delivery` = `{ status, riderName, riderPhone, riderVehicle, trackingUrl, assignedAt, pickedUpAt, deliveredAt, cancelledAt, failedAt, failReason } | null`.
- Produces: `<DeliveryStatusPanel delivery={...} onRebook={...} />`; `advance()` → `PATCH /branches/${branchId}/sales/${saleId}/advance`.

- [ ] **Step 1: Build `DeliveryStatusPanel`**

Render a rider-journey timeline from `delivery.status` with human labels:
```tsx
const RIDER_LABELS: Record<string, string> = {
  searching_rider: "Finding a rider…",
  assigned: "Rider assigned",
  picked_up: "Rider picked up the order",
  in_transit: "On the way",
  delivered: "Delivered",
  cancelled: "Rider cancelled",
  failed: "Delivery failed / returned",
};
```
Show rider name/phone/vehicle when present, a tracking-URL link when present, and — when `status` is `cancelled` or `failed` — a warning block with a **Re-book rider** button (`onRebook`). No delivery row → render nothing (or "No rider booked").

- [ ] **Step 2: Add advance action + panel to owner order-detail**

Add an `advance()` mutation calling the Task-4 endpoint, then refetch. Render channel/booking-aware buttons:
- If `data.delivery` exists and its status is live (`searching_rider|assigned|picked_up|in_transit`): hide manual advance, show the panel (webhook drives it) + a small "Force delivered" fallback.
- Else show: delivery order → **Mark out for delivery** / **Mark delivered**; pickup → **Mark ready** / **Mark collected**, per current `data.status`.
Render `<DeliveryStatusPanel delivery={data.delivery} onRebook={bookRide} />` (reuse the existing `bookRide` flow already in this file). Keep the existing cancel-refund + book/cancel-ride controls.

- [ ] **Step 3: Build the admin app**

Run: `cd apps/admin && pnpm build`  Expected: build succeeds.

- [ ] **Step 4: Commit**
```bash
git add apps/admin/src/routes/owner/order-detail.tsx apps/admin/src/components/DeliveryStatusPanel.tsx
git commit -m "feat(admin): owner order advance buttons + delivery rider panel"
```

---

### Task 7: Branch online-order detail page + branch queue (#4)

Give branch staff a real online-order workspace for their branch.

**Files:**
- Create: `apps/admin/src/routes/branch/online-orders.tsx` (queue list)
- Create: `apps/admin/src/routes/branch/online-order-detail.tsx` (detail + fulfilment)
- Modify: branch router registration (find with grep — `routeTree`/route config for `apps/admin/src/routes/branch`)
- Modify: `apps/admin/src/components/BranchShell.tsx` (nav entry)

**Interfaces:**
- Consumes: `GET /online-orders/active` (queue), `GET /branches/:branchId/sales/:saleId` (detail incl `delivery`), `PATCH .../advance`, delivery `options/book/cancel`.
- Produces: branch routes mirroring the owner detail but branch-scoped (no refund controls).

- [ ] **Step 1: Branch queue list**

`online-orders.tsx`: fetch `/online-orders/active` (server already scopes branch staff to their branch), render newest-first cards (order #, customer, items count, status pill, `delivery_status` chip) linking to the detail route. Empty-state copy: "No online orders awaiting fulfilment."

- [ ] **Step 2: Branch detail page**

`online-order-detail.tsx`: fetch `/branches/${branchId}/sales/${saleId}`; render customer card (name/phone/email/address), items, the **advance** buttons (reuse the logic from Task 6), ride **book/cancel** (reuse the owner flow's calls), and `<DeliveryStatusPanel>`. Do NOT render cancel-refund / payment-accept (owner-only).

- [ ] **Step 3: Register routes + nav**

Add both routes to the branch route tree and a "Online orders" item to `BranchShell.tsx` nav.

- [ ] **Step 4: Build + commit**

Run: `cd apps/admin && pnpm build`  Expected: succeeds.
```bash
git add apps/admin/src/routes/branch apps/admin/src/components/BranchShell.tsx
git commit -m "feat(admin): branch online-order queue + detail with branch-scoped fulfilment"
```

---

### Task 8: New-order signals — badges + toast + chime (#2, #3)

A shared poll hook drives a nav badge, a banner toast, and a till chime off `active-count`.

**Files:**
- Create: `apps/admin/src/hooks/useOnlineOrderSignal.ts`
- Modify: `apps/admin/src/components/Shell.tsx` + `apps/admin/src/components/BranchShell.tsx` (badge + toast + chime mount)
- Create: `apps/admin/src/routes/owner/online-orders.tsx` (owner queue screen) + register + nav badge

**Interfaces:**
- Produces: `useOnlineOrderSignal(): { count: number; newCount: number; acknowledge: () => void }` — polls `GET /online-orders/active-count?since=<lastSeen>` every 25s; persists `lastSeen` (max `newest`) in `localStorage`; `newCount` = orders since last acknowledge.
- Consumes: the Task-5 endpoint.

- [ ] **Step 1: Build the hook**

Poll every 25s (guard against overlap; pause when `document.hidden`). On a response with `new_since > 0`, set `newCount` and fire side-effects (toast + chime) ONCE per new batch. Chime: a short WebAudio beep (no asset) behind a `localStorage` on/off flag (`onlineOrderChime`, default on); only on till shells. Degrade silently on fetch error (offline till).

- [ ] **Step 2: Owner queue screen**

`owner/online-orders.tsx`: fetch `/online-orders/active`, render the queue (newest-first) with links to `owner/order-detail`. Register the route + add a nav item with the live badge (count from the hook) in `Shell.tsx`.

- [ ] **Step 3: Wire badge + toast + chime into both shells**

In `Shell.tsx` (owner) and `BranchShell.tsx` (till), call the hook, show a red count badge on the "Online orders" nav item, and render a dismissible banner ("🔔 New online order — tap to view") when `newCount > 0`; clicking routes to the queue and calls `acknowledge()`. Mount the chime only in `BranchShell`.

- [ ] **Step 4: Build + commit**

Run: `cd apps/admin && pnpm build`  Expected: succeeds.
```bash
git add apps/admin/src/hooks/useOnlineOrderSignal.ts apps/admin/src/components/Shell.tsx apps/admin/src/components/BranchShell.tsx apps/admin/src/routes/owner/online-orders.tsx
git commit -m "feat(admin): online-order nav badge, new-order toast + till chime"
```

---

### Task 9: Remove chowdeck pickup from the till UI (#cleanup)

API counter logic + zod were handled in Task 2; this removes the remaining UI surfaces. Keep the enum value and the `chowdeck_external` payment method / `chowdeck` customer source.

**Files:**
- Modify: `apps/admin/src/routes/branch/sell.tsx:37,646` (Channel type + `<option>`)
- Modify: `apps/admin/src/sync/local-sale.ts:15` (channel union)
- Modify: `apps/admin/src/routes/branch/sale-detail.tsx:54,215` (channel union + `canHandOver` set)
- Modify: `apps/api/src/routes/preorder-shared.ts:18` (`COUNTER_CHANNELS` drop `chowdeck_pickup`)
- Modify: `apps/admin/src/routes/owner/order-detail.tsx:590` (drop the `chowdeck_pickup` guard term)

**Interfaces:** none new — narrowing existing channel unions to `"walkup" | "whatsapp"` for counter contexts (keep `online`/`phone` where present).

- [ ] **Step 1: Edit the surfaces**

Remove the `<option value="chowdeck_pickup">Chowdeck pickup</option>` and drop `"chowdeck_pickup"` from each `Channel`/union and from `["walkup","whatsapp","chowdeck_pickup"]` sets (→ `["walkup","whatsapp"]`). In `preorder-shared.ts` set `COUNTER_CHANNELS = new Set(["walkup","whatsapp"])`.

- [ ] **Step 2: Typecheck + build**

Run: `pnpm -w typecheck && cd apps/admin && pnpm build`  Expected: clean + succeeds.

- [ ] **Step 3: Commit**
```bash
git add apps/admin/src apps/api/src/routes/preorder-shared.ts
git commit -m "chore: remove chowdeck pickup from till UI + counter logic (enum value retained)"
```

---

### Task 10: Customer tracking — delivery rider panel (Rev A)

Surface the rider journey on the customer order-tracking page. The tracking API already returns `out_for_delivery_at` / `delivered_at`; add rider fields it doesn't yet expose.

**Files:**
- Modify: `apps/api/src/routes/public-orders.ts` (tracking `GET /:orderNumber` response ~700-709 — add `delivery` rider block)
- Modify: `apps/customer/src/routes/order/$orderNumber` tracking component (grep to confirm path) + `apps/customer/src/lib/api/types.ts`
- Test: `apps/api/test/integration/online-order.test.ts` (existing — add tracking rider assertion)

**Interfaces:**
- Produces (API): tracking response gains `delivery: { status, rider_name, rider_phone, rider_vehicle, tracking_url } | null` from the latest `delivery_order`.
- Consumes (customer): renders a compact rider timeline (reuse the `RIDER_LABELS` map from Task 6, duplicated client-side in customer — different app, no shared import).

- [ ] **Step 1: Failing API test**

Add to `online-order.test.ts`: seed a paid online order + a `delivery_order` with `status:"in_transit"`, rider name set; GET `/v1/public/orders/:orderNumber`; assert `body.data.delivery.status === "in_transit"` and `rider_name` present.

- [ ] **Step 2: Run fail → implement**

Run the test (FAIL — `delivery` undefined). In `public-orders.ts` tracking handler, select the latest `delivery_order` for the sale (same pattern as `sales.ts` detail) and add the `delivery` block to the JSON. Run → PASS.

- [ ] **Step 3: Customer UI**

Add `delivery` to the tracking type; render a rider-status line + tracking link beneath the existing timeline when `delivery` is non-null. Build: `cd apps/customer && pnpm build`.

- [ ] **Step 4: Commit**
```bash
git add apps/api/src/routes/public-orders.ts apps/customer/src apps/api/test/integration/online-order.test.ts
git commit -m "feat: surface delivery rider journey on customer tracking page"
```

---

## Final verification (after all tasks)

- [ ] `pnpm -w typecheck` — clean
- [ ] `cd apps/api && TZ=UTC pnpm vitest run` — green (note any PRE-EXISTING failures vs new)
- [ ] `cd apps/worker && TZ=UTC pnpm vitest run` — green
- [ ] `cd packages/shared && pnpm vitest run && cd ../domain && pnpm vitest run` — green
- [ ] `pnpm -w build` — all apps build
- [ ] Manual smoke notes for the owner: place a test online order → it appears in the queue with badge + toast/chime → advance through to delivered → drops from `online_pending`; cancel/abandon → leaves the count. 🔴 PWA hard-refresh tills.

## Self-review notes

- **Spec coverage:** #1→T1, #2/#3→T5+T8, #4→T4+T7, #5→T4+T6, #6→T3 (+existing cancel-refund), #7→T2+T3, Rev A→T6+T7+T10, Rev B→T2, chowdeck removal→T2(api)+T9(ui).
- **Type consistency:** `advance` endpoint path `/branches/:branchId/sales/:saleId/advance` used identically in T4/T6/T7; `DeliveryStatusPanel` props (`delivery`,`onRebook`) consistent T6→T7; `RIDER_LABELS` defined in T6 (admin) and re-declared in T10 (customer, separate app — intentional, no cross-app import).
- **No destructive migration:** `chowdeck_pickup` enum value retained; no schema migration in this plan (all columns used already exist).

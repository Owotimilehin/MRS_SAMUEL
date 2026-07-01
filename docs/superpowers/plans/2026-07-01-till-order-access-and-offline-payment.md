# Till Order Access, Payment Follow-up & Offline Payment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the till (branch_staff) owner-level visibility of online orders, the ability to re-check Payaza and record offline (transfer/cash) payments, and make stuck-payment states honest — while keeping fulfilment gated on paid.

**Architecture:** Widen the existing online-orders queue feed for the till (list only, not the badge count); grant `branch_staff` the `orders.view`/`orders.manage` capabilities admins already hold; make `verifyAndReconcile` also heal `reconcile_needed` orders; add one new `record-payment` endpoint + shared money helper for offline payments; extend the two till order screens. No DB migration.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM (Postgres), React + TanStack Router (admin PWA), Vitest.

## Global Constraints

- No database migration. Verified on prod 2026-07-01: `payment.processor` is `text`, `payment.method` enum already includes `transfer`/`cash`, `payment.collected_by_user_id` (uuid) exists, `sale_order.cancel_reason` is free text.
- Money mutations must be CAS-guarded (`WHERE status = ... RETURNING`) so concurrent presses / a racing Payaza webhook can never double-pay or double-deduct stock.
- Force-accepting a *mismatched* Payaza amount stays owner-only (`orders.accept_payment`). The till gets re-check and record-offline-payment only.
- Fulfilment (produce/hand-over/deliver/`fulfilPreorderTx`) stays gated on `status = 'paid'` — do not change it.
- The new-order chime / nav badge must keep counting `paid` arrivals only. Only the *list* widens.
- Offline payment records `processor: 'manual'` — never labelled Payaza.
- Follow existing code patterns: `BusinessError(code, message, httpStatus)` for errors, `writeAudit(db, c, {...})` for audit, `outboxEvent` insert for Telegram, snake_case API responses.

---

### Task 1: Grant branch_staff order capabilities

**Files:**
- Modify: `packages/shared/src/permissions.ts:107-113` (BRANCH_STAFF_CAPS)
- Test: `packages/shared/src/permissions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveCapabilities("branch_staff")` now includes `"orders.view"` and `"orders.manage"`. Later tasks rely on `requireCapability("orders.manage")` passing for a branch_staff till.

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/permissions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveCapabilities } from "./permissions.js";

describe("branch_staff order follow-up capabilities", () => {
  it("branch_staff can view and manage orders (re-check / record payment)", () => {
    const caps = resolveCapabilities("branch_staff");
    expect(caps).toContain("orders.view");
    expect(caps).toContain("orders.manage");
  });

  it("branch_staff still cannot force-accept a mismatched payment (owner-only)", () => {
    const caps = resolveCapabilities("branch_staff");
    expect(caps).not.toContain("orders.accept_payment");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/permissions.test.ts -t "branch_staff order follow-up"`
Expected: FAIL — `expected [...] to contain "orders.view"`.

- [ ] **Step 3: Add the two capabilities**

In `packages/shared/src/permissions.ts`, change `BRANCH_STAFF_CAPS` (currently lines 107-113) to:

```ts
const BRANCH_STAFF_CAPS: Capability[] = [
  "pos.sell",
  "pos.preorder",
  "shift_open.submit",
  "sales.view",
  "transfers.receive",
  // The till attends to online orders directly, so it needs the same order
  // visibility + follow-up powers admins/managers hold: see every order state
  // and re-check Payaza / record an offline (transfer/cash) payment. Force-
  // accepting a MISMATCHED Payaza amount stays owner-only (orders.accept_payment).
  "orders.view",
  "orders.manage",
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/permissions.test.ts`
Expected: PASS (all permissions tests green).

- [ ] **Step 5: Rebuild the shared package (admin/api import the built output)**

Run: `cd packages/shared && npm run build`
Expected: exits 0, `dist/permissions.js` regenerated.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/permissions.ts packages/shared/src/permissions.test.ts packages/shared/dist
git commit -m "feat(perms): branch_staff gets orders.view + orders.manage for till order follow-up"
```

---

### Task 2: Widen the till's online-orders list (keep the badge count paid-only)

**Files:**
- Modify: `apps/api/src/routes/online-orders-queue.ts:21-39` (statuses + list where-clause)
- Test: `apps/api/test/integration/online-orders-queue.test.ts` (add cases; create if absent — check first with `ls apps/api/test/integration | grep online`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GET /v1/online-orders/active` returns orders in `confirmed`, `reconcile_needed`, `paid`, `out_for_delivery` (branch-scoped for branch_staff). `GET /v1/online-orders/active-count` is UNCHANGED (still paid/out_for_delivery only). Each list row keeps its existing fields plus the existing `stage` field; awaiting-payment rows carry `status: "confirmed" | "reconcile_needed"`.

- [ ] **Step 1: Write the failing test**

First check for an existing test file: `ls apps/api/test/integration | grep -i online`. If `online-orders-queue.test.ts` exists, append; otherwise create it following the pattern of a sibling integration test (they build the app via `createTestApp`, seed with helpers, and call routes with an auth cookie/header). Add:

```ts
it("till /active lists awaiting-payment orders (confirmed + reconcile_needed), branch-scoped", async () => {
  // Seed one paid, one confirmed, one reconcile_needed online order in branch A,
  // and one confirmed online order in branch B. (Use the suite's existing order
  // seeding helper; set channel='online' and the given status.)
  const res = await tillClient.get("/v1/online-orders/active"); // branch_staff scoped to branch A
  const numbers = res.data.map((o: { order_number: string }) => o.order_number);
  expect(numbers).toContain(paidA.orderNumber);
  expect(numbers).toContain(confirmedA.orderNumber);
  expect(numbers).toContain(reconcileA.orderNumber);
  expect(numbers).not.toContain(confirmedB.orderNumber); // branch scope holds
});

it("badge count stays paid-only after the list widens", async () => {
  // With the same seed as above (confirmed + reconcile_needed present in branch A),
  // the count must only include paid/out_for_delivery.
  const res = await tillClient.get("/v1/online-orders/active-count");
  expect(res.data.count).toBe(1); // only paidA
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/online-orders-queue.test.ts -t "awaiting-payment"`
Expected: FAIL — confirmed/reconcile_needed orders are absent from `/active`.

- [ ] **Step 3: Split the status lists so only the list widens**

In `apps/api/src/routes/online-orders-queue.ts`, replace lines 21-22:

```ts
  const ACTIVE_CHANNELS = ["online", "phone"] as const;
  const ACTIVE_STATUSES = ["paid", "out_for_delivery"] as const;
```

with:

```ts
  const ACTIVE_CHANNELS = ["online", "phone"] as const;
  // Counted for the nav badge / new-order chime — only orders actually ready to
  // fulfil. Unpaid orders must never trip a "new order!" alert.
  const ACTIVE_STATUSES = ["paid", "out_for_delivery"] as const;
  // Shown in the till's Online list — widened so staff SEE (not fulfil) orders
  // still awaiting payment and can follow up. Fulfilment stays gated on 'paid'.
  const LIST_STATUSES = ["confirmed", "reconcile_needed", "paid", "out_for_delivery"] as const;
```

Then in the `/active` handler's `baseWhere` (line 37) change `ACTIVE_STATUSES` to `LIST_STATUSES`:

```ts
    const baseWhere = and(
      inArray(saleOrder.channel, [...ACTIVE_CHANNELS]),
      inArray(saleOrder.status, [...LIST_STATUSES]),
      branchScoped ? eq(saleOrder.branchId, branchScoped) : undefined,
    );
```

Leave the `/active-count` handler's `baseWhere` (around line 146) on `ACTIVE_STATUSES` — do not touch it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/integration/online-orders-queue.test.ts`
Expected: PASS (both new cases + existing cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/online-orders-queue.ts apps/api/test/integration/online-orders-queue.test.ts
git commit -m "feat(api): till online list shows awaiting-payment orders; badge stays paid-only"
```

---

### Task 3: Re-check heals a stuck `reconcile_needed` order

**Files:**
- Modify: `apps/api/src/payments/reconcile.ts:160-173` (`verifyAndReconcile`)
- Test: `apps/api/test/unit/reconcile.test.ts`

**Interfaces:**
- Consumes: `applyPayazaConfirmation(tx, order, confirmed)` (existing), `verifyPayazaTransaction`, `isPayazaSuccess` (existing imports).
- Produces: `verifyAndReconcile(db, orderNumber)` now also acts on a `reconcile_needed` order: Payaza-Completed-and-full → `paid`; Payaza-Completed-but-short → stays `reconcile_needed`; Payaza-not-completed → returns `{ kind: "not_completed" }` and leaves status untouched (no auto-cancel). The existing `/online-orders/:id/recheck` handler already calls this — no handler change needed.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/unit/reconcile.test.ts` (follow the file's existing mocking of `verifyPayazaTransaction`):

```ts
it("verifyAndReconcile heals a reconcile_needed order that Payaza reports paid in full", async () => {
  // Seed an online order, total 8500, currently status='reconcile_needed'.
  mockPayaza({ status: "Completed", amountNgn: 8600, feeNgn: 100, netNgn: 8500 });
  const outcome = await verifyAndReconcile(db, order.orderNumber);
  expect(outcome.kind).toBe("paid");
  const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, order.id));
  expect(row.status).toBe("paid");
  expect(row.paymentStatus).toBe("paid");
});

it("verifyAndReconcile leaves a reconcile_needed order unchanged when Payaza shows no payment", async () => {
  // status='reconcile_needed', Payaza reports not completed.
  mockPayaza({ status: "Pending" });
  const outcome = await verifyAndReconcile(db, order.orderNumber);
  expect(outcome.kind).toBe("not_completed");
  const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, order.id));
  expect(row.status).toBe("reconcile_needed"); // NOT auto-cancelled
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/unit/reconcile.test.ts -t "reconcile_needed"`
Expected: FAIL — first case: `applyPayazaConfirmation` early-returns `already_processed` (status !== 'confirmed'), so status stays `reconcile_needed`, not `paid`.

- [ ] **Step 3: Add the CAS-guarded nudge in verifyAndReconcile**

In `apps/api/src/payments/reconcile.ts`, replace the body of `verifyAndReconcile` (lines 168-172) so a `reconcile_needed` order is nudged back to `confirmed` (CAS-guarded) before `applyPayazaConfirmation` acts. Ensure `and` is imported from `drizzle-orm` (line 1 already imports `and, eq`).

```ts
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.orderNumber, orderNumber));
    if (!o) return { kind: "order_not_found" };

    // A previously-stuck order (flagged reconcile_needed by the old exact-equality
    // reconciliation, or a genuine earlier shortfall since topped up) must be
    // re-openable: nudge it back to 'confirmed' so applyPayazaConfirmation's guard
    // acts on it. CAS-guarded so a concurrent caller can't double-apply. Only
    // reached when Payaza already reports success (checked above), so we never
    // reopen an order that has no money behind it.
    const orderForConfirmation =
      o.status === "reconcile_needed"
        ? (await tx
            .update(saleOrder)
            .set({ status: "confirmed", updatedAt: new Date() })
            .where(and(eq(saleOrder.id, o.id), eq(saleOrder.status, "reconcile_needed")))
            .returning())[0] ?? o
        : o;

    return applyPayazaConfirmation(tx, orderForConfirmation, confirmed);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/unit/reconcile.test.ts`
Expected: PASS (new cases + existing reconcile cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/payments/reconcile.ts apps/api/test/unit/reconcile.test.ts
git commit -m "feat(payments): re-check heals a stuck reconcile_needed order (no auto-cancel when unpaid)"
```

---

### Task 4: Offline payment — shared money helper

**Files:**
- Modify: `apps/api/src/payments/reconcile.ts` (add `applyOfflinePayment`)
- Test: `apps/api/test/unit/reconcile.test.ts`

**Interfaces:**
- Consumes: `saleOrder`, `saleOrderItem`, `payment`, `stockLedger`, `stockReservation`, `outboxEvent` (already imported at top of reconcile.ts).
- Produces:
  ```ts
  export interface OfflinePaymentInput {
    method: "transfer" | "cash";
    amountNgn: number;      // the amount received now
    collectedByUserId: string | null;
  }
  export async function applyOfflinePayment(
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
    order: typeof saleOrder.$inferSelect,
    input: OfflinePaymentInput,
  ): Promise<ReconcileOutcome>;
  ```
  Behaviour: CAS-flip `confirmed`|`reconcile_needed` → `paid`; insert a `payment` row (`method`, `processor: 'manual'`, `amountNgn`, `collectedByUserId`, `paidAt: now`); non-preorder writes sale `stockLedger` rows + deletes `stockReservation`; preorder skips stock (joins preorder queue); emits `sale.preorder_paid`/`sale.paid_online`. Idempotent: an already-`paid` order returns `{ kind: "already_processed", status }`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/unit/reconcile.test.ts`:

```ts
it("applyOfflinePayment marks a confirmed non-preorder paid via transfer and deducts stock", async () => {
  // Seed confirmed online non-preorder, total 3500, one item qty 1 at a branch with stock.
  const outcome = await db.transaction((tx) =>
    applyOfflinePayment(tx, order, { method: "transfer", amountNgn: 3500, collectedByUserId: staffId }),
  );
  expect(outcome.kind).toBe("paid");
  const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, order.id));
  expect(row.status).toBe("paid");
  const pays = await db.select().from(payment).where(eq(payment.saleOrderId, order.id));
  expect(pays).toHaveLength(1);
  expect(pays[0].method).toBe("transfer");
  expect(pays[0].processor).toBe("manual");
  const ledger = await db.select().from(stockLedger).where(eq(stockLedger.sourceId, order.id));
  expect(ledger.length).toBeGreaterThan(0); // stock deducted for the sold line
});

it("applyOfflinePayment on a reconcile_needed preorder pays it WITHOUT moving stock", async () => {
  // Seed reconcile_needed online preorder (isPreorder=true), total 8500.
  const outcome = await db.transaction((tx) =>
    applyOfflinePayment(tx, preorder, { method: "transfer", amountNgn: 8500, collectedByUserId: staffId }),
  );
  expect(outcome.kind).toBe("paid");
  const ledger = await db.select().from(stockLedger).where(eq(stockLedger.sourceId, preorder.id));
  expect(ledger).toHaveLength(0); // preorder defers stock to fulfilment
});

it("applyOfflinePayment is idempotent (no second payment on an already-paid order)", async () => {
  const paidOrder = { ...order, status: "paid" as const };
  const outcome = await db.transaction((tx) =>
    applyOfflinePayment(tx, paidOrder, { method: "cash", amountNgn: 3500, collectedByUserId: staffId }),
  );
  expect(outcome.kind).toBe("already_processed");
  const pays = await db.select().from(payment).where(eq(payment.saleOrderId, order.id));
  expect(pays.length).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/unit/reconcile.test.ts -t "applyOfflinePayment"`
Expected: FAIL — `applyOfflinePayment is not a function` / not exported.

- [ ] **Step 3: Implement applyOfflinePayment**

Append to `apps/api/src/payments/reconcile.ts` (after `applyPayazaConfirmation`). It mirrors that function's paid branch but with a manual payment row and no amount-verification:

```ts
export interface OfflinePaymentInput {
  method: "transfer" | "cash";
  amountNgn: number;
  collectedByUserId: string | null;
}

/**
 * Record a payment received OUTSIDE Payaza (bank transfer / cash) and mark the
 * order paid. Used when the customer paid the whole amount, or topped up a
 * shortfall, by a non-Payaza means. Mirrors applyPayazaConfirmation's paid
 * branch: CAS flip, one payment row (processor 'manual'), stock for a non-
 * preorder, preorder-paid/paid-online outbox event. Idempotent.
 */
export async function applyOfflinePayment(
  tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
  order: typeof saleOrder.$inferSelect,
  input: OfflinePaymentInput,
): Promise<ReconcileOutcome> {
  const o = order;
  if (o.status !== "confirmed" && o.status !== "reconcile_needed") {
    return { kind: "already_processed", status: o.status };
  }

  const won = await tx
    .update(saleOrder)
    .set({ status: "paid", paymentStatus: "paid", feeShortfallNgn: null, updatedAt: new Date() })
    .where(
      and(
        eq(saleOrder.id, o.id),
        inArray(saleOrder.status, ["confirmed", "reconcile_needed"]),
      ),
    )
    .returning({ id: saleOrder.id });
  if (won.length === 0) return { kind: "already_processed", status: o.status };

  if (!o.isPreorder) {
    const items = await tx.select().from(saleOrderItem).where(eq(saleOrderItem.saleOrderId, o.id));
    for (const it of items) {
      await tx.insert(stockLedger).values({
        locationType: "branch",
        locationId: o.branchId,
        productId: it.productId,
        variantId: it.variantId ?? null,
        delta: -it.quantity,
        sourceType: "sale",
        sourceId: o.id,
        note: `Offline (${input.method}) sale ${o.orderNumber}`,
      });
    }
    await tx.delete(stockReservation).where(eq(stockReservation.saleOrderId, o.id));
  }

  await tx.insert(payment).values({
    saleOrderId: o.id,
    method: input.method,
    amountNgn: input.amountNgn,
    status: "paid",
    processor: "manual",
    collectedByUserId: input.collectedByUserId,
    paidAt: new Date(),
  });

  await tx.insert(outboxEvent).values({
    eventType: o.isPreorder ? "sale.preorder_paid" : "sale.paid_online",
    payload: {
      sale_order_id: o.id,
      order_number: o.orderNumber,
      branch_id: o.branchId,
      customer_id: o.customerId,
      total_ngn: o.totalNgn,
      payment_method: input.method,
      offline: true,
      scheduled_delivery_at: o.scheduledDeliveryAt ? o.scheduledDeliveryAt.toISOString() : null,
      delivery_state: o.deliveryState ?? null,
    },
  });

  return { kind: "paid", orderNumber: o.orderNumber, amountNgn: o.totalNgn, isPreorder: o.isPreorder };
}
```

Add `inArray` to the drizzle import on line 1: `import { and, eq, inArray } from "drizzle-orm";`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/unit/reconcile.test.ts`
Expected: PASS (all three new cases + existing).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/payments/reconcile.ts apps/api/test/unit/reconcile.test.ts
git commit -m "feat(payments): applyOfflinePayment — record transfer/cash payment, mark order paid"
```

---

### Task 5: `record-payment` endpoint

**Files:**
- Modify: `apps/api/src/routes/payments-admin.ts` (add route + import `applyOfflinePayment`)
- Test: `apps/api/test/integration/payments-admin.test.ts`

**Interfaces:**
- Consumes: `applyOfflinePayment` (Task 4), `loadOnlineOrder` (existing local helper), `writeAudit` (existing import).
- Produces: `POST /v1/online-orders/:id/record-payment` gated `orders.manage`. Body `{ method: "transfer"|"cash", amount_ngn?: number }`. Returns `{ data: { status: "paid" } }`. 403 for a user without `orders.manage`; 409 if order not in `confirmed`/`reconcile_needed`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/integration/payments-admin.test.ts`:

```ts
it("branch_staff can record an offline transfer payment and the order goes paid", async () => {
  // Seed confirmed online order in the till's branch.
  const res = await tillClient.post(`/v1/online-orders/${order.id}/record-payment`, {
    method: "transfer",
  });
  expect(res.status).toBe(200);
  const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, order.id));
  expect(row.status).toBe("paid");
});

it("record-payment rejects a caller lacking orders.manage", async () => {
  const res = await noCapsClient.post(`/v1/online-orders/${order.id}/record-payment`, { method: "cash" }, { expectError: true });
  expect(res.status).toBe(403);
});

it("record-payment 409s when the order is already paid", async () => {
  const res = await tillClient.post(`/v1/online-orders/${paidOrder.id}/record-payment`, { method: "cash" }, { expectError: true });
  expect(res.status).toBe(409);
});
```

(Use the suite's existing client/seed helpers; `tillClient` = a branch_staff-authenticated client scoped to the order's branch. If the suite lacks one, build it the same way the file already builds its owner/admin clients but with role `branch_staff`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/payments-admin.test.ts -t "record"`
Expected: FAIL — 404 (route not mounted).

- [ ] **Step 3: Add the route**

In `apps/api/src/routes/payments-admin.ts`, add `applyOfflinePayment` to the reconcile import:

```ts
import { applyPayazaConfirmation, verifyAndReconcile, applyOfflinePayment } from "../payments/reconcile.js";
```

Then add this handler inside `paymentsAdminRoutes`, after the `/:id/recheck` route (around line 70):

```ts
  /**
   * POST /:id/record-payment
   * Record a payment received OUTSIDE Payaza (bank transfer / cash) and mark the
   * order paid. Available to the till (orders.manage) — the staff attending the
   * order confirm the money landed. Handles a full off-Payaza payment on a
   * 'confirmed' order AND a top-up on a 'reconcile_needed' order. Fulfilment
   * still gates on 'paid'. Force-accepting a MISMATCHED Payaza amount stays the
   * owner-only /accept action.
   */
  r.post("/:id/record-payment", requireCapability("orders.manage"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);

    const body = (await c.req.json().catch(() => ({}))) as {
      method?: string;
      amount_ngn?: number;
    };
    const method = body.method;
    if (method !== "transfer" && method !== "cash") {
      throw new BusinessError("validation_failed", "method must be 'transfer' or 'cash'", 400);
    }

    const o = await loadOnlineOrder(id);
    if (o.status !== "confirmed" && o.status !== "reconcile_needed") {
      throw new BusinessError("conflict", `cannot record a payment from status '${o.status}'`, 409);
    }

    const auth = c.get("auth");
    const amountNgn =
      typeof body.amount_ngn === "number" && body.amount_ngn > 0 ? Math.round(body.amount_ngn) : o.totalNgn;

    const outcome = await db.transaction(async (tx) => {
      const [fresh] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
      if (!fresh) throw new BusinessError("not_found", "order not found", 404);
      return applyOfflinePayment(tx, fresh, {
        method,
        amountNgn,
        collectedByUserId: auth.userId ?? null,
      });
    });

    if (outcome.kind !== "paid" && outcome.kind !== "already_processed") {
      throw new BusinessError("conflict", `record-payment returned: ${outcome.kind}`, 409);
    }

    await writeAudit(db, c, {
      action: "sale_order.record_offline_payment",
      entityType: "sale_order",
      entityId: id,
      after: { orderNumber: o.orderNumber, method, amountNgn, outcome: outcome.kind },
    });

    return c.json({ data: { status: "paid" } });
  });
```

Verify the auth object's user-id field name — grep `c.get("auth")` usages in this file / middleware for the exact property (`auth.userId` vs `auth.user.id`) and match it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/integration/payments-admin.test.ts`
Expected: PASS (three new cases + existing).

- [ ] **Step 5: Add the audit humaniser label**

Grep for where audit actions are humanised (`grep -rn "sale_order.accept_payment" apps/`). In that humaniser map add:

```ts
  "sale_order.record_offline_payment": "Recorded offline payment",
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/payments-admin.ts apps/api/test/integration/payments-admin.test.ts apps/admin/src/lib/audit-humanize.ts
git commit -m "feat(api): record-payment endpoint for offline (transfer/cash) online-order payments"
```

(Adjust the humaniser path in the `git add` to wherever the grep found it.)

---

### Task 6: `cancel-unpaid` endpoint (resolve to Unpaid without a phantom refund)

**Files:**
- Modify: `apps/api/src/routes/payments-admin.ts` (add route)
- Test: `apps/api/test/integration/payments-admin.test.ts`

**Interfaces:**
- Consumes: `loadOnlineOrder`, `writeAudit`, `stockReservation` (already imported in this file).
- Produces: `POST /v1/online-orders/:id/cancel-unpaid` gated `orders.manage`. Cancels a `confirmed`/`reconcile_needed` order with `cancel_reason: 'payment_not_received'`, releases the reservation, leaves `refund_owed_ngn` NULL. 409 from any other status. Returns `{ data: { status: "cancelled" } }`.

**Why a separate endpoint (not cancel-refund):** `cancel-refund` always sets
`refundOwedNgn = totalNgn`. For a never-paid order that would fabricate a refund the
business does not owe. `cancel-unpaid` owes nothing.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/integration/payments-admin.test.ts`:

```ts
it("cancel-unpaid cancels a confirmed order with no refund owed", async () => {
  const res = await tillClient.post(`/v1/online-orders/${order.id}/cancel-unpaid`, {});
  expect(res.status).toBe(200);
  const [row] = await db.select().from(saleOrder).where(eq(saleOrder.id, order.id));
  expect(row.status).toBe("cancelled");
  expect(row.cancelReason).toBe("payment_not_received");
  expect(row.refundOwedNgn).toBeNull(); // no phantom refund liability
});

it("cancel-unpaid refuses a paid order (must use cancel-refund)", async () => {
  const res = await tillClient.post(`/v1/online-orders/${paidOrder.id}/cancel-unpaid`, {}, { expectError: true });
  expect(res.status).toBe(409);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/payments-admin.test.ts -t "cancel-unpaid"`
Expected: FAIL — 404 (route not mounted).

- [ ] **Step 3: Add the route**

In `apps/api/src/routes/payments-admin.ts`, after the `record-payment` route add:

```ts
  /**
   * POST /:id/cancel-unpaid
   * Resolve a genuinely unpaid online order to "Unpaid — no payment received".
   * Only for 'confirmed' / 'reconcile_needed' orders; owes NO refund (unlike
   * cancel-refund, which is for paid orders). Releases the reservation.
   */
  r.post("/:id/cancel-unpaid", requireCapability("orders.manage"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);

    const auth = c.get("auth");
    const o = await loadOnlineOrder(id);
    if (o.status !== "confirmed" && o.status !== "reconcile_needed") {
      throw new BusinessError(
        "conflict",
        `cannot cancel-unpaid from status '${o.status}' — a paid order uses cancel-refund`,
        409,
      );
    }

    const updated = await db.transaction(async (tx) => {
      const [won] = await tx
        .update(saleOrder)
        .set({
          status: "cancelled",
          cancelReason: "payment_not_received",
          cancelledByUserId: auth.userId,
          cancelledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(saleOrder.id, id),
            inArray(saleOrder.status, ["confirmed", "reconcile_needed"]),
          ),
        )
        .returning();
      if (!won) throw new BusinessError("conflict", "order changed — reload and retry", 409);
      await tx.delete(stockReservation).where(eq(stockReservation.saleOrderId, id));
      return won;
    });

    await writeAudit(db, c, {
      action: "sale_order.cancel_unpaid",
      entityType: "sale_order",
      entityId: id,
      after: { orderNumber: o.orderNumber, status: "cancelled", reason: "payment_not_received" },
    });

    return c.json({ data: { status: updated.status } });
  });
```

Ensure `and` and `inArray` are in this file's `drizzle-orm` import (add them if absent).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/integration/payments-admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the audit humaniser label**

In the same humaniser map touched in Task 5, add:

```ts
  "sale_order.cancel_unpaid": "Cancelled — unpaid",
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/payments-admin.ts apps/api/test/integration/payments-admin.test.ts apps/admin/src/lib/audit-humanize.ts
git commit -m "feat(api): cancel-unpaid resolves a never-paid order without a phantom refund"
```

---

### Task 7: Till UI — split Online list + re-check / record-payment / cancel-unpaid actions

**Files:**
- Modify: `apps/admin/src/routes/branch/online-orders.tsx` (group Awaiting-payment vs Ready)
- Modify: `apps/admin/src/routes/branch/online-order-detail.tsx` (Re-check + Record-payment buttons)
- Test: manual (admin PWA has no render-test harness — see memory `project_straws_shipped`). Verify via typecheck + build + incognito load.

**Interfaces:**
- Consumes: `GET /online-orders/active` (now returns `confirmed`/`reconcile_needed` rows — Task 2), `POST /online-orders/:id/recheck` (heals reconcile_needed — Task 3), `POST /online-orders/:id/record-payment` (Task 5), `POST /online-orders/:id/cancel-unpaid` (Task 6), `can("orders.manage")` from the admin permission hook.
- Produces: till UI surface. No downstream consumer.

- [ ] **Step 1: Group the list by payment state**

In `apps/admin/src/routes/branch/online-orders.tsx`, partition the fetched rows into `awaitingPayment = rows.filter(o => o.status === "confirmed" || o.status === "reconcile_needed")` and `ready = rows.filter(o => o.status === "paid" || o.status === "out_for_delivery")`. Render `awaitingPayment` first under a heading **"Awaiting payment"** (with a `pill--warning`/`pill--danger` status pill via the existing `statusPill`), then the existing worklist under **"Ready to make / deliver"**. Extend `statusPill` (currently handles paid/out_for_delivery/handed_over/delivered/confirmed) to also render `reconcile_needed` → `<span className="pill pill--danger">Payment needs checking</span>`.

- [ ] **Step 2: Add Re-check + Record-payment to the detail page**

In `apps/admin/src/routes/branch/online-order-detail.tsx`, when `data.status` is `confirmed` or `reconcile_needed` and `can("orders.manage")`, show two controls:

```tsx
async function recheckPayment(): Promise<void> {
  setActBusy(true); setErr(null);
  try {
    await api(`/online-orders/${orderId}/recheck`, { method: "POST", body: "{}" });
    await load();
  } catch (e) { setErr(humanizeError(e)); } finally { setActBusy(false); }
}

async function recordPayment(method: "transfer" | "cash"): Promise<void> {
  setActBusy(true); setErr(null);
  try {
    await api(`/online-orders/${orderId}/record-payment`, {
      method: "POST",
      body: JSON.stringify({ method }),
    });
    await load();
  } catch (e) { setErr(humanizeError(e)); } finally { setActBusy(false); }
}
```

Also add a **"Cancel — unpaid"** control (confirm first via the existing `ConfirmModal` pattern in the file) → calls `POST /online-orders/${orderId}/cancel-unpaid` then `load()`. Use it only when staff have confirmed no money came by Payaza or transfer.

```tsx
async function cancelUnpaid(): Promise<void> {
  setActBusy(true); setErr(null);
  try {
    await api(`/online-orders/${orderId}/cancel-unpaid`, { method: "POST", body: "{}" });
    await load();
  } catch (e) { setErr(humanizeError(e)); } finally { setActBusy(false); }
}
```

Render (inside the awaiting-payment branch): a **"Re-check payment"** button → `recheckPayment()`, a **"Record payment received"** control offering **Transfer** and **Cash** → `recordPayment(...)`, and a **"Cancel — unpaid"** button → `cancelUnpaid()`. Reuse the page's existing `api`, `humanizeError`, `can`, and busy/error state patterns (match the sibling `advance`/`produce` handlers already in the file). Keep the produce/hand-over actions gated on `paid` as they already are.

- [ ] **Step 3: Typecheck**

Run: `cd apps/admin && npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 4: Build**

Run: `cd apps/admin && npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/routes/branch/online-orders.tsx apps/admin/src/routes/branch/online-order-detail.tsx
git commit -m "feat(till): show awaiting-payment orders + re-check / record-offline-payment actions"
```

---

### Task 8: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Run the whole API test suite**

Run: `cd apps/api && npx vitest run`
Expected: PASS. Note any pre-existing failures unrelated to this change (compare against memory: some integration tests have known-flaky seeding).

- [ ] **Step 2: Run shared + typecheck across touched packages**

Run: `cd packages/shared && npx vitest run && cd ../../apps/admin && npx tsc --noEmit && cd ../api && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 3: Confirm fulfilment is still paid-gated (regression guard)**

Grep to confirm no fulfilment path was loosened: `grep -n "status.*paid\|=== \"paid\"" apps/api/src/routes/preorder-shared.ts apps/api/src/routes/sales.ts | head`. `fulfilPreorderTx` and produce/hand-over/deliver must still require `paid`. This is a read-only check; do not change these.

- [ ] **Step 4: Final commit if any lint fixups were needed**

```bash
git add -A && git commit -m "chore: lint/typecheck fixups for till order access" || echo "nothing to commit"
```

---

## Deployment note

Push to `master` triggers auto-deploy (per project memory: push-to-master → deploy.yml, not CI-gated). No migration in this plan, so no schema step. After deploy, existing tills need a PWA hard-refresh / "Refresh app" to load the new bundle. Not eyeball-tested until a real till + a real awaiting-payment order are exercised.

## Post-ship manual check (SO-2026-00666)

Independent of this plan, SO-2026-00666 (paid ₦8,500 net, stuck reconcile_needed, due 08:00) should be cleared now via the owner **Accept payment** action. Once this plan ships, the same order could alternatively be cleared by the till's new **Re-check payment** button (Task 3 heals it) since Payaza reports it Completed-in-full.

# Payaza Payment Reliability & Reconciliation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make online card-payment confirmation self-healing (no completed payment is lost if the webhook never fires) and give the owner in-app tools to resolve mismatched/bad payments.

**Architecture:** Extract the webhook's "mark paid" money-logic into one shared, tested core (`reconcile.ts`). A worker sweep + an on-view re-verify both call it as a safety net. New owner-facing admin endpoints (re-check / accept / cancel-refund / mark-refunded) and a Needs-attention queue let the owner resolve `reconcile_needed` and refund-owed orders. Spec: `docs/superpowers/specs/2026-06-22-payaza-payment-reconciliation-design.md`.

**Tech Stack:** Hono + Drizzle + Zod (API), pino (logging), Vitest + testcontainers (tests), TanStack Router + React (admin), worker poll loop.

## Global Constraints

- Money is integer naira (`*_ngn`); Payaza verify returns `amount_received` in full naira units (already handled by `verifyPayazaTransaction`).
- The webhook/cron/on-view/admin paths MUST all flip an order to paid through the SINGLE function `applyPayazaConfirmation` — never duplicate the ledger/payment logic.
- `applyPayazaConfirmation` is idempotent: it acts ONLY when `order.status === "confirmed"`; any other status is a no-op.
- Reservation hold is 30 min (`public-orders.ts:442`). The sweep cadence is 2 min.
- New migration is `0055_refund_owed`; add a `meta/_journal.json` entry with `when` strictly greater than `1782980000000` (the 0054 watermark) or Drizzle silently skips it. Rebuild `@ms/db` after schema edits.
- Admin endpoints are online-channel only (`channel === "online"`); till sales keep using `sales.ts`.
- Run tests with `TZ=UTC`. Pre-existing unrelated failures to ignore: `shipbubble-live.ts` typecheck (2), and the `online-order` "live options/fallback" integration test (1, env-flag).
- Follow existing patterns: `writeAudit(db, c, {...})` (see `sales.ts:355`), route mounting in `test-app.ts`, `requireAuth()/requireCapability()` (see `delivery-admin.ts`), tx-typed helpers (see `activateSubscriptionFromPayment` in `lib/subscriptions.ts`).

---

### Task 1: Migration `0055_refund_owed` + schema column

**Files:**
- Create: `packages/db/migrations/0055_refund_owed.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (append entry)
- Modify: `packages/db/src/schema/sale-order.ts` (add column)

**Interfaces:**
- Produces: `saleOrder.refundOwedNgn` (nullable integer) on the Drizzle `sale_order` table.

- [ ] **Step 1: Write the migration SQL**

```sql
-- packages/db/migrations/0055_refund_owed.sql
ALTER TABLE "sale_order" ADD COLUMN "refund_owed_ngn" integer;
```

- [ ] **Step 2: Append the journal entry**

In `packages/db/migrations/meta/_journal.json`, after the `0054_branch_online_default` entry, append:
```json
,{ "idx": 54, "version": "7", "when": 1783010000000, "tag": "0055_refund_owed", "breakpoints": true }
```
(Confirm `when` 1783010000000 > the 0054 value 1782980000000.)

- [ ] **Step 3: Add the schema column**

In `packages/db/src/schema/sale-order.ts`, add to the `saleOrder` table definition (near the other nullable money/meta columns):
```ts
  refundOwedNgn: integer("refund_owed_ngn"),
```
Ensure `integer` is imported from `drizzle-orm/pg-core` (it almost certainly already is).

- [ ] **Step 4: Rebuild @ms/db and apply the migration to dev**

Run: `pnpm --filter @ms/db build && pnpm --filter @ms/db migrate` (or the repo's migrate script with `DATABASE_URL` exported).
Expected: migration `0055_refund_owed` applies; `\d sale_order` shows `refund_owed_ngn`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/0055_refund_owed.sql packages/db/migrations/meta/_journal.json packages/db/src/schema/sale-order.ts
git commit -m "feat(db): refund_owed_ngn on sale_order (migration 0055)"
```

---

### Task 2: Shared reconcile core + unit tests

**Files:**
- Create: `apps/api/src/payments/reconcile.ts`
- Test: `apps/api/test/unit/reconcile.test.ts`

**Interfaces:**
- Consumes: `verifyPayazaTransaction`, `isPayazaSuccess`, `PayazaTransactionStatus` from `../payments/payaza.js`; `saleOrder, saleOrderItem, payment, stockLedger, stockReservation, outboxEvent` from `@ms/db`; `isOutsideLagos` from `@ms/shared`; `autoDispatchEnabled` from `../lib/delivery-flags.js`.
- Produces:
  ```ts
  export type ReconcileOutcome =
    | { kind: "order_not_found" }
    | { kind: "already_processed"; status: string }
    | { kind: "not_completed"; payazaStatus: string }
    | { kind: "amount_mismatch"; expectedNgn: number; reportedNgn: number }
    | { kind: "paid"; orderNumber: string; amountNgn: number; isPreorder: boolean };

  // tx is the Drizzle transaction handle (same type the existing
  // db.transaction(async (tx) => …) callbacks receive; mirror the param typing
  // used by activateSubscriptionFromPayment in lib/subscriptions.ts).
  export async function applyPayazaConfirmation(
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
    order: typeof saleOrder.$inferSelect,
    confirmed: PayazaTransactionStatus,
    opts?: { acceptReportedAmount?: boolean },
  ): Promise<ReconcileOutcome>;

  export async function verifyAndReconcile(
    db: DbClient,
    orderNumber: string,
  ): Promise<ReconcileOutcome>;
  ```
- `applyPayazaConfirmation` logic (lifted verbatim from the current `webhooks-payaza.ts` transaction body):
  - if `order.status !== "confirmed"` → `{ kind: "already_processed", status: order.status }`.
  - if `!opts?.acceptReportedAmount` AND `confirmed.amountNgn != null` AND `confirmed.amountNgn !== order.totalNgn` → set `reconcile_needed`, insert `sale.amount_mismatch` outbox event, return `{ kind: "amount_mismatch", expectedNgn: order.totalNgn, reportedNgn: confirmed.amountNgn }`.
  - else: if `!order.isPreorder` ledger out each item (`delta: -qty`, `sourceType: "sale"`) + delete reservation; insert `payment` (`method:"card"`, `amountNgn: confirmed.amountNgn ?? order.totalNgn` when `acceptReportedAmount`, else `order.totalNgn`, `processor:"payaza"`, `paidAt: new Date()`); set `status:"paid", paymentStatus:"paid"`; insert `sale.preorder_paid`/`sale.paid_online` event; optional `delivery.request` when `autoDispatchEnabled()` and not preorder/scheduled/outsideLagos. Return `{ kind:"paid", orderNumber, amountNgn, isPreorder }`.
- `verifyAndReconcile`: `const confirmed = await verifyPayazaTransaction(orderNumber);` if `!isPayazaSuccess(confirmed.status)` return `{ kind:"not_completed", payazaStatus: confirmed.status }`; else `db.transaction` → load order by `orderNumber` → if none `{kind:"order_not_found"}` else `applyPayazaConfirmation(tx, order, confirmed)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/unit/reconcile.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyPayazaConfirmation } from "../../src/payments/reconcile.js";

// Minimal fake tx: records inserts/updates and returns a seeded order.
function fakeTx(order: any) {
  const calls: any = { inserts: [], updates: [], deletes: [] };
  const tx = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(order ? [order] : []) }) }),
    insert: (t: any) => ({ values: (v: any) => { calls.inserts.push({ t, v }); return Promise.resolve(); } }),
    update: (t: any) => ({ set: (v: any) => ({ where: () => { calls.updates.push({ t, v }); return Promise.resolve(); } }) }),
    delete: (t: any) => ({ where: () => { calls.deletes.push({ t }); return Promise.resolve(); } }),
  };
  return { tx, calls };
}
const baseOrder = {
  id: "o1", orderNumber: "SO-1", status: "confirmed", totalNgn: 3500,
  isPreorder: false, branchId: "b1", customerId: "c1",
  scheduledDeliveryAt: null, deliveryState: "Lagos",
};

describe("applyPayazaConfirmation", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("no-ops when the order is already paid", async () => {
    const { tx, calls } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder, status: "paid" } as any,
      { status: "Completed", amountNgn: 3500, processorReference: "P-1", authorization: null },
    );
    expect(r).toEqual({ kind: "already_processed", status: "paid" });
    expect(calls.updates).toHaveLength(0);
  });

  it("parks reconcile_needed when the amount differs", async () => {
    const { tx, calls } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      { status: "Completed", amountNgn: 3000, processorReference: "P-1", authorization: null },
    );
    expect(r).toEqual({ kind: "amount_mismatch", expectedNgn: 3500, reportedNgn: 3000 });
    expect(calls.inserts.some((i: any) => i.v.eventType === "sale.amount_mismatch")).toBe(true);
  });

  it("marks an in-stock order paid and ledgers stock", async () => {
    const { tx, calls } = fakeTx(null);
    // one item returned by the item select — extend fakeTx select to vary by table if needed
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      { status: "Completed", amountNgn: 3500, processorReference: "P-1", authorization: null },
    );
    expect(r.kind).toBe("paid");
    expect(calls.inserts.some((i: any) => i.v.status === "paid" && i.v.processor === "payaza")).toBe(true);
  });

  it("accepts the reported amount when acceptReportedAmount=true (override mismatch)", async () => {
    const { tx } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      { status: "Completed", amountNgn: 3000, processorReference: "P-1", authorization: null },
      { acceptReportedAmount: true },
    );
    expect(r.kind).toBe("paid");
  });
});
```
(Note: the in-stock test needs the item `select` to return one row. Extend `fakeTx` so `select().from(t)` checks the table identity and returns `[{ productId:"p1", variantId:null, quantity:1 }]` for `saleOrderItem`, `[order]` for `saleOrder`, `[]` otherwise. Write that into the test before implementing.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run test/unit/reconcile.test.ts`
Expected: FAIL — `applyPayazaConfirmation` not found.

- [ ] **Step 3: Implement `reconcile.ts`**

Move the transaction body of the current `webhooks-payaza.ts` (lines that load the order, do the amount guard, ledger/payment/paid/events, and `delivery.request`) into `applyPayazaConfirmation`, parameterised by `opts.acceptReportedAmount`. Add `verifyAndReconcile`. Keep imports identical to what the webhook used.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/unit/reconcile.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/payments/reconcile.ts apps/api/test/unit/reconcile.test.ts
git commit -m "feat(payaza): shared reconcile core (applyPayazaConfirmation + verifyAndReconcile)"
```

---

### Task 3: Refactor the webhook onto the shared core

**Files:**
- Modify: `apps/api/src/routes/webhooks-payaza.ts`
- Test: `apps/api/test/integration/online-order.test.ts` (regression — already covers webhook→paid)

**Interfaces:**
- Consumes: `applyPayazaConfirmation` from `../payments/reconcile.js`.

- [ ] **Step 1: Replace the inline transaction with the shared core**

Keep the inbound logging, JSON/reference parsing, the `try/catch` around `verifyPayazaTransaction`, the `not completed` early return, and `SUB_` routing. Replace the `const outcome = await db.transaction(...)` block with:
```ts
const outcome = await db.transaction(async (tx) => {
  const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.orderNumber, reference));
  if (!o) return { kind: "order_not_found" as const };
  return applyPayazaConfirmation(tx, o, confirmed);
});
```
Map the existing per-outcome `logger` switch onto the `ReconcileOutcome` kinds (`not_completed` is already handled before the tx; keep `order_not_found`, `already_processed`, `amount_mismatch`, `paid`). Remove now-unused imports (`saleOrderItem`, `payment`, `stockLedger`, `stockReservation`, `isOutsideLagos`, `autoDispatchEnabled`) that moved into `reconcile.ts` — keep `saleOrder`, `outboxEvent` only if still referenced (they are not after this change except `saleOrder` for the lookup).

- [ ] **Step 2: Typecheck**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | grep -v shipbubble-live`
Expected: no new errors.

- [ ] **Step 3: Run the webhook integration regression**

Run: `cd apps/api && TZ=UTC npx vitest run test/integration/online-order.test.ts`
Expected: same 14 pass / 1 pre-existing fail as before; the webhook→paid + amount-mismatch cases still pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/webhooks-payaza.ts
git commit -m "refactor(payaza): webhook uses shared reconcile core"
```

---

### Task 4: Worker reconcile sweep

**Files:**
- Create: `apps/worker/src/jobs/payaza-reconcile.ts`
- Modify: `apps/worker/src/index.ts` (timer + invocation)
- Test: `apps/worker/test/payaza-reconcile.test.ts`

**Interfaces:**
- **LOCKED DECISION (do not re-derive):** the worker is deliberately free of any `@ms/api` dependency (it depends only on `@ms/db`/`@ms/domain`/`@ms/shared` and mirrors api helpers locally). It therefore CANNOT import `apps/api/src/payments/reconcile.ts`. To keep the SINGLE money path, the sweep does NOT re-implement the ledger/payment logic. Instead it **selects** stuck orders via `@ms/db` and **re-fires the api webhook over HTTP** for each — `POST {INTERNAL_API_URL}/v1/webhooks/payaza` with JSON body `{ "transaction_reference": "<orderNumber>" }`. The webhook then runs the one shared reconcile core (verify + `applyPayazaConfirmation`). This reuses the money path with zero duplication and respects the worker's no-api-import architecture.
- New env var `INTERNAL_API_URL` (default `http://api:3001` — the compose-network api address). Add it to `apps/worker` compose `environment` block (Task 4 Step 4) and to `packages/shared/src/env-keys.ts`.
- The worker-emitted `sale.reconciled_paid` event from the original spec is DROPPED: a recovered order flips to paid inside the webhook, which already emits the normal `sale.paid_online`/`sale.preorder_paid` notification, so the owner is still alerted. (Task 8 therefore adds only `sale.refund_owed`.)
- Produces: `export async function sweepStuckPayazaOrders(db: DbClient, now?: Date): Promise<number>;` — returns the count of orders it re-fired the webhook for.
- Selection: `saleOrder` where `channel = "online"`, `status = "confirmed"`, `createdAt < now - 90s`, AND an un-expired `stockReservation` exists (`expiresAt > now`). For each eligible order, `await fetch(...)` the webhook (best-effort: log + continue on a non-2xx or thrown error; one failed POST must not abort the sweep). Return the number of orders POSTed.

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/test/payaza-reconcile.test.ts
import { describe, it, expect, vi } from "vitest";
import { sweepStuckPayazaOrders } from "../src/jobs/payaza-reconcile.js";
// Stub global fetch (vi.stubGlobal("fetch", vi.fn())) + a fake db whose query
// returns one eligible order ("SO-1") and excludes ineligible ones (expired
// reservation / too-recent / not online / not confirmed). Assert: fetch was
// called once, to a URL ending "/v1/webhooks/payaza", with a body containing
// transaction_reference "SO-1"; and the function returns 1.
```
(Mirror the mocking style of `apps/worker/test/subscription-billing.test.ts` for the db fake. The selection logic — eligibility filtering — is what this test must exercise, so build the fake db to return a representative row set and assert only eligible orders are POSTed.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run test/payaza-reconcile.test.ts`
Expected: FAIL — function not found.

- [ ] **Step 3: Implement the sweep** — selection query (the eligibility filter above) + per-order `await fetch(\`${process.env.INTERNAL_API_URL || "http://api:3001"}/v1/webhooks/payaza\`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ transaction_reference: o.orderNumber }) })` wrapped in try/catch (log warn + continue on failure). Return the count POSTed.

- [ ] **Step 4: Wire into the worker loop**

In `apps/worker/src/index.ts`: add `const PAYAZA_RECONCILE_INTERVAL_MS = 120_000;` near the other interval consts (line ~18-22), a `let lastPayazaReconcileAt = 0;`, and inside the `while` loop (mirroring the delivery-watchdog block at lines 70-75):
```ts
if (now - lastPayazaReconcileAt > PAYAZA_RECONCILE_INTERVAL_MS) {
  try {
    const n = await sweepStuckPayazaOrders(db);
    if (n > 0) logger.info({ reconciled: n }, "payaza reconcile sweep recovered orders");
  } catch (err) {
    logger.error({ err }, "payaza reconcile sweep error");
  }
  lastPayazaReconcileAt = now;
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd apps/worker && npx vitest run test/payaza-reconcile.test.ts && npx tsc --noEmit`
Expected: PASS, no new type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/jobs/payaza-reconcile.ts apps/worker/src/index.ts apps/worker/test/payaza-reconcile.test.ts
git commit -m "feat(payaza): 2-min worker sweep recovers stuck confirmed online orders"
```

---

### Task 5: On-view re-verify on the tracking endpoint

**Files:**
- Modify: `apps/api/src/routes/public-orders.ts` (the `GET /:orderNumber` tracking handler, ~line 539+)
- Test: `apps/api/test/integration/online-order.test.ts` (add a case)

**Interfaces:**
- Consumes: `verifyAndReconcile` from `../payments/reconcile.js`.

- [ ] **Step 1: Write the failing test**

Add to `online-order.test.ts`: create an online order (status `confirmed`) with a live reservation; stub Payaza `verifyPayazaTransaction` to return `Completed` matching the total; `GET /v1/public/orders/:orderNumber?phone=…`; expect the returned `status` to be `"paid"` (the on-view re-verify flipped it). Run it; expect FAIL.

- [ ] **Step 2: Implement the re-verify**

Near the top of the tracking handler, after loading the order but before building the response: if `o.channel === "online" && o.status === "confirmed"` and its reservation is still live, wrap a best-effort call:
```ts
try {
  await verifyAndReconcile(db, o.orderNumber);
} catch (err) {
  logger.warn({ err, orderNumber: o.orderNumber }, "tracking on-view re-verify failed (non-fatal)");
}
// re-read the order so the response reflects any flip
[o] = await db.select().from(saleOrder).where(eq(saleOrder.orderNumber, orderNumber));
```
(Use `let` for the order binding; import `logger`.)

- [ ] **Step 3: Run the test**

Run: `cd apps/api && TZ=UTC npx vitest run test/integration/online-order.test.ts`
Expected: the new case PASSES; existing cases unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/public-orders.ts apps/api/test/integration/online-order.test.ts
git commit -m "feat(payaza): tracking page re-verifies unpaid online orders on view"
```

---

### Task 6: Capability + admin reconciliation endpoints

**Files:**
- Modify: `packages/shared/src/permissions.ts` (add capability)
- Create: `apps/api/src/routes/payments-admin.ts`
- Modify: `apps/api/src/test-app.ts` (mount) and the prod app file if separate
- Test: `apps/api/test/integration/payments-admin.test.ts`

**Interfaces:**
- Produces capability `"orders.accept_payment"` (added to `CAPABILITIES`; owner auto-gets it via `owner: [...CAPABILITIES]`; do NOT add to other roles).
- Endpoints under `/v1/online-orders`, `requireAuth()` then per-route capability:
  - `POST /:id/recheck` (`orders.manage`) → `verifyAndReconcile(db, order.orderNumber)`; returns `{ data: { status, outcome } }`.
  - `POST /:id/accept` (`orders.accept_payment`) → load order; require `channel==="online"` and `status==="confirmed"|"reconcile_needed"` (else 409); `db.transaction` → re-set status to `confirmed` if it was `reconcile_needed` (so the idempotent core will act) then `applyPayazaConfirmation(tx, order, await verifyPayazaTransaction(orderNumber), { acceptReportedAmount: true })`; `writeAudit`. Returns `{ data: { status: "paid" } }`.
  - `POST /:id/cancel-refund` (`orders.manage`), body `{ reason: string }` → load order; reject terminal/**fulfilled** (`["handed_over","delivered","cancelled","failed","refunded"]`) with 409 — this path is for paid-but-UNFULFILLED orders ONLY; a refund for a delivered order is a *return* via the existing `returns.ts`/`sale_return` system, NOT this endpoint. In a tx: restore stock if it was `paid` (mirror `sales.ts:554-576` ledger restore), delete reservation, set `status:"cancelled"`, `cancelReason: reason`, `cancelledByUserId: auth.userId`, `refundOwedNgn: o.totalNgn`; insert `sale.refund_owed` outbox event; `writeAudit`. Returns `{ data: { status: "cancelled", refund_owed_ngn } }`.
  - `POST /:id/mark-refunded` (`orders.accept_payment`) → set `refundOwedNgn: null`; `writeAudit`. Returns `{ data: { ok: true } }`.

- [ ] **Step 1: Add the capability + write failing endpoint test**

Add `"orders.accept_payment"` to `CAPABILITIES` in `permissions.ts`. Then write `payments-admin.test.ts` (mirror an existing integration test's app/seed bootstrap, e.g. `delivery-admin` or `sales` integration tests):
- seed an owner + an online order in `reconcile_needed` (totalNgn 3500), stub `verifyPayazaTransaction` → `Completed`/3000.
- `POST /v1/online-orders/:id/accept` as owner → 200, order becomes `paid`.
- `POST /v1/online-orders/:id/cancel-refund` on a fresh `confirmed` order → 200, `refund_owed_ngn === totalNgn`, status `cancelled`.
- `POST /:id/recheck` on a `confirmed` order with Payaza `Completed`/match → flips `paid`.
- auth: a `branch_staff` (no `orders.accept_payment`) calling `/accept` → 403.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && TZ=UTC npx vitest run test/integration/payments-admin.test.ts`
Expected: FAIL — route not mounted.

- [ ] **Step 3: Implement `payments-admin.ts`** (the four routes above; mirror `delivery-admin.ts` for structure, `sales.ts` cancel for the ledger-restore, `writeAudit(db, c, {...})` for audit).

- [ ] **Step 4: Mount the route**

In `apps/api/src/test-app.ts` (and the prod app builder if it is a separate file — grep `payazaWebhookRoutes` to find both): `app.route("/v1/online-orders", paymentsAdminRoutes(db));` with the import.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd apps/api && TZ=UTC npx vitest run test/integration/payments-admin.test.ts && npx tsc --noEmit 2>&1 | grep -v shipbubble-live`
Expected: PASS; no new type errors. Also run shared tests: `cd packages/shared && npx vitest run` (capability list).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/permissions.ts apps/api/src/routes/payments-admin.ts apps/api/src/test-app.ts apps/api/test/integration/payments-admin.test.ts
git commit -m "feat(payaza): admin recheck/accept/cancel-refund/mark-refunded endpoints"
```

---

### Task 7: Needs-attention bucket in the review inbox

**Files:**
- Modify: `apps/api/src/routes/review.ts`
- Test: `apps/api/test/integration/` (add a review case or extend an existing review test)

**Interfaces:**
- Produces: `data.payment_attention: Array<{ id, order_number, status, total_ngn, refund_owed_ngn, reported_ngn }>` in the `GET /v1/review` response.

- [ ] **Step 1: Write the failing test** — seed one `reconcile_needed` online order + one cancelled order with `refundOwedNgn` set; `GET /v1/review`; expect both in `payment_attention`. Run → FAIL.

- [ ] **Step 2: Implement** — add a query selecting online `saleOrder` where `status = 'reconcile_needed'` OR `refundOwedNgn IS NOT NULL`; map to the shape above (pull `reported_ngn` from the latest `payment.amountNgn` or leave null); add to the `data` object next to `transfer_variances` / `return_approvals`.

- [ ] **Step 3: Run the test** → PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/review.ts apps/api/test/integration/
git commit -m "feat(payaza): surface reconcile_needed + refund-owed in Needs-review"
```

---

### Task 8: Telegram notifications

**Files:**
- Modify: `apps/worker/src/outbox.ts` (add two `format` cases)

**Interfaces:**
- Consumes event type `sale.refund_owed` (emitted in Task 6). (`sale.reconciled_paid` was dropped in Task 4 — recovered orders fire the normal `sale.paid_online`.)

- [ ] **Step 1: Add the case** in the `format` switch (mirror `sale.amount_mismatch` at `outbox.ts:339`):
```ts
case "sale.refund_owed":
  return {
    chatIds: [owner],
    text:
      `💸 *Refund owed*\n` +
      `${p["order_number"]} — ₦${p["refund_owed_ngn"]} to refund in the Payaza dashboard.\n` +
      `Mark it refunded once done.\n` +
      `👉 ${ADMIN_URL}/owner/orders/${p["sale_order_id"]}`,
  };
```
(Confirm the admin order path matches the real route — grep the admin router for the online order detail path; adjust if it differs.)

- [ ] **Step 2: Typecheck + worker tests**

Run: `cd apps/worker && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/outbox.ts
git commit -m "feat(payaza): Telegram alerts for refund-owed + recovered payment"
```

---

### Task 9: Admin UI — actions + Needs-attention badge

**Files:**
- Modify: `apps/admin/src/routes/owner/order-detail.tsx` (action panel)
- Modify: the admin Needs-review page + nav (count badge) — grep `review` under `apps/admin/src/routes` to locate.
- Modify: `apps/admin/src/lib/api.ts` (add the 4 endpoint helpers) — match existing helper style.

**Interfaces:**
- Consumes: `/v1/online-orders/:id/recheck|accept|cancel-refund|mark-refunded` and the `payment_attention` field from `/v1/review`.

- [ ] **Step 1: Build the action panel** — REQUIRED SUB-SKILL when implementing this task: use **frontend-design**. On `order-detail.tsx`, for an online order, render:
  - status pill incl. `reconcile_needed`; a "Refund owed ₦X" badge when `refund_owed_ngn`.
  - an "Expected ₦X · Payaza reported ₦Y" row when mismatched.
  - buttons (with a confirm dialog each, reuse the existing `ConfirmModal`): **Re-check payment** (`orders.manage`), **Accept as paid** (owner only — gate on capability), **Cancel & mark refund owed** (reason prompt), **Mark refunded** (owner only). Each calls its endpoint, shows loading, then re-fetches the order.
  - respect existing admin design tokens; match the page's existing card/button styling.

- [ ] **Step 2: Needs-attention badge** — surface `payment_attention.length` as a count badge on the Needs-review nav item and render the bucket rows (order number, amounts, state) with links to the order, matching the existing review-page layout.

- [ ] **Step 3: Typecheck + build + lint**

Run: `cd apps/admin && npx tsc --noEmit && pnpm build && npx eslint src/routes/owner/order-detail.tsx`
Expected: PASS; no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/
git commit -m "feat(payaza): admin payment-resolution actions + needs-attention badge"
```

---

### Task 10: Full-suite verification

- [ ] **Step 1:** `cd apps/api && TZ=UTC npx vitest run test/unit/reconcile.test.ts test/unit/payaza.test.ts test/integration/payments-admin.test.ts test/integration/online-order.test.ts` — all green except the known pre-existing online-order live-options fail.
- [ ] **Step 2:** `cd apps/worker && npx vitest run` and `cd packages/shared && npx vitest run` — green.
- [ ] **Step 3:** `cd apps/api && npx tsc --noEmit 2>&1 | grep -v shipbubble-live` and `cd apps/admin && npx tsc --noEmit` — no new errors.
- [ ] **Step 4:** `pnpm -w lint` — no new errors beyond the documented pre-existing set.
- [ ] **Step 5 (manual, post-deploy):** complete one real ₦ payment → webhook `PAID` log; then place an order, suppress/skip the webhook, and confirm the 2-min sweep recovers it (log `recovered orders`) and the tracking page shows paid.

---

## Self-Review

**Spec coverage:** reliability core → Task 2; webhook refactor → Task 3; cron sweep → Task 4; on-view re-verify → Task 5; admin endpoints + capability → Task 6; needs-attention → Task 7; refund-owed column → Task 1, set in Task 6, shown in Tasks 7+9; notifications → Task 8; admin UI → Task 9; verification → Task 10. All spec sections mapped.

**Placeholder scan:** the one open implementation decision is Task 4's import location (worker ↔ api shared code) — it carries an explicit "confirm at implementation" instruction with a concrete check (`grep from "../../api"`) and two named fallbacks, not a vague TODO.

**Type consistency:** `applyPayazaConfirmation` / `verifyAndReconcile` / `ReconcileOutcome` names and the `kind` values are identical across Tasks 2, 3, 4, 5, 6. `refundOwedNgn` (schema) ↔ `refund_owed_ngn` (SQL/JSON) consistent. Capability `orders.accept_payment` consistent across Task 6 + 9.

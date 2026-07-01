# Payaza Fee-Aware Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop every online (Payaza) order showing "reconciliation needed" by reconciling on the NET amount the business actually receives, capture Payaza's fee/gross/net breakdown per order, and show it on the order detail — while keeping the Payaza fee entirely out of revenue/analytics.

**Architecture:** Payaza charges the customer `product total + fee` and always deducts its fee, so what settles is `net = customerPaid − payazaFee`. We enrich the Payaza verify-parser to read the fee/settlement fields (defensively, plus raw JSON), persist `fee/gross/net` on the payment row and a `fee_shortfall_ngn` on the order, and change reconciliation from strict `reported === total` to `net ≥ total`. Revenue keeps summing `payment.amount_ngn` which stays equal to the product total, so analytics never see the fee.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM (Postgres), Vitest, TanStack Router (admin React app).

## Global Constraints

- **Never hardcode the fee.** Payaza decides the transaction fee per transaction; always read it from the transaction data. (spec Part 1)
- **Only the business's money enters analytics.** Revenue/sales/dashboards/daily-close/reports count the product total (`payment.amount_ngn` = `sale_order.total_ngn`) only. `fee_ngn`/`gross_ngn` are display/reconciliation-only and are never summed into any money figure. (spec Part 7)
- **Money is stored as integer naira** (`*_ngn` integer columns), matching the existing schema. No floats.
- **Migration numbering:** Local is behind prod. Prod already has `0062_checkout_attempt_log`. Before creating the migration, `git pull` and confirm the highest migration; this plan uses **0063**. The migration's `_journal.json` `when` timestamp MUST be strictly greater than the current max `when` in `_journal.json` — a lower timestamp is silently skipped by Drizzle (past prod outage). Current max is `1783190000000` (0061); use a larger value.
- **TDD:** failing test first, minimal implementation, green, commit — every task.
- Run API tests from `apps/api` with `npx vitest run <path>`; run with `TZ=UTC` where date logic is involved (not needed here).

---

### Task 1: Migration — payment breakdown columns + order fee-shortfall

**Files:**
- Create: `packages/db/migrations/0063_payaza_fee_breakdown.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (append entry)
- Modify: `packages/db/src/schema/payment.ts`
- Modify: `packages/db/src/schema/sale-order.ts:57` area (add column near the other `*Ngn` columns)

**Interfaces:**
- Produces: new nullable columns
  - `payment.fee_ngn` (int), `payment.gross_ngn` (int), `payment.net_ngn` (int), `payment.raw_breakdown` (jsonb)
  - `sale_order.fee_shortfall_ngn` (int)
- Drizzle field names later tasks rely on: `payment.feeNgn`, `payment.grossNgn`, `payment.netNgn`, `payment.rawBreakdown`, `saleOrder.feeShortfallNgn`.

- [ ] **Step 1: Sync and confirm migration number**

```bash
cd "$(git rev-parse --show-toplevel)"
git pull --ff-only
ls packages/db/migrations/*.sql | sort | tail -3
```

Expected: highest existing migration is `0062_checkout_attempt_log` (or higher). If the highest is ≥ 0063, bump this task's filename/number accordingly and use the next free number everywhere in this plan.

- [ ] **Step 2: Write the migration SQL**

Create `packages/db/migrations/0063_payaza_fee_breakdown.sql`:

```sql
ALTER TABLE "payment" ADD COLUMN "fee_ngn" integer;
ALTER TABLE "payment" ADD COLUMN "gross_ngn" integer;
ALTER TABLE "payment" ADD COLUMN "net_ngn" integer;
ALTER TABLE "payment" ADD COLUMN "raw_breakdown" jsonb;
ALTER TABLE "sale_order" ADD COLUMN "fee_shortfall_ngn" integer;
```

- [ ] **Step 3: Append the journal entry**

In `packages/db/migrations/meta/_journal.json`, after the `0061_variance_loss` entry (idx 60), append:

```json
    ,{ "idx": 61, "version": "7", "when": 1783250000000, "tag": "0063_payaza_fee_breakdown", "breakpoints": true }
```

Verify `1783250000000` is strictly greater than every existing `when` in the file. If a synced repo already has entries past idx 60 (e.g. checkout log 0062), use the next `idx` and a `when` greater than the current max.

- [ ] **Step 4: Add the Drizzle columns to the payment schema**

In `packages/db/src/schema/payment.ts`, add inside the `payment` table object, after `paidAt`:

```ts
  feeNgn: integer("fee_ngn"),
  grossNgn: integer("gross_ngn"),
  netNgn: integer("net_ngn"),
  rawBreakdown: jsonb("raw_breakdown"),
```

Update the import line to include `jsonb`:

```ts
import { pgTable, uuid, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
```

- [ ] **Step 5: Add the Drizzle column to the sale_order schema**

In `packages/db/src/schema/sale-order.ts`, add near the other money columns (after `refundOwedNgn` at line ~98):

```ts
  feeShortfallNgn: integer("fee_shortfall_ngn"),
```

- [ ] **Step 6: Typecheck the db package**

Run: `npx tsc -p packages/db/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations/0063_payaza_fee_breakdown.sql packages/db/migrations/meta/_journal.json packages/db/src/schema/payment.ts packages/db/src/schema/sale-order.ts
git commit -m "feat(db): payment fee/gross/net breakdown + sale_order fee_shortfall (0063)"
```

---

### Task 2: Enrich the Payaza verify-parser with fee/gross/net + raw

**Files:**
- Modify: `apps/api/src/payments/payaza.ts` (interface `PayazaTransactionStatus`, function `verifyPayazaTransaction`)
- Test: `apps/api/test/unit/payaza-parse.test.ts` (create)

**Interfaces:**
- Produces: extended `PayazaTransactionStatus`:
  ```ts
  export interface PayazaTransactionStatus {
    status: string;
    amountNgn: number | null;      // gross the customer paid (amount_received) — unchanged meaning
    feeNgn: number | null;         // Payaza's transaction fee for this charge, if reported
    netNgn: number | null;         // settled to business; Payaza's settlement field or amountNgn - feeNgn
    processorReference: string | null;
    authorization: { token: string; reusable: boolean } | null;
    raw: unknown;                  // verbatim parsed body for audit/display
  }
  ```
- The parser reads the fee defensively from any of: `data.fee`, `data.charge`, `data.transaction_fee`, `data.processor_fee` (first numeric wins). Net from `data.settlement_amount` / `data.amount_settled` if present, else `amountNgn - feeNgn` when both known, else `null`.

**Note (spec step 0):** field names are read defensively so the code does not depend on one exact name. Task 7 verifies against a real transaction and, if the real field differs, adds it to the candidate list.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/unit/payaza-parse.test.ts`. This tests the pure parsing of a Payaza-shaped body. Extract the body→status mapping into an exported pure function `parsePayazaBody(status, text)` so it is testable without HTTP (Step 3 refactors `verifyPayazaTransaction` to call it).

```ts
import { describe, it, expect } from "vitest";
import { parsePayazaBody } from "../../src/payments/payaza.js";

describe("parsePayazaBody", () => {
  it("reads gross, fee, and derives net from a fee-inclusive success body", () => {
    const body = JSON.stringify({
      success: true,
      data: {
        transaction_status: "Completed",
        amount_received: 3600,
        fee: 100,
        transaction_reference: "P-C-1",
      },
    });
    const s = parsePayazaBody(200, body);
    expect(s.status).toBe("Completed");
    expect(s.amountNgn).toBe(3600); // gross
    expect(s.feeNgn).toBe(100);
    expect(s.netNgn).toBe(3500); // 3600 - 100
    expect(s.processorReference).toBe("P-C-1");
  });

  it("prefers an explicit settlement field for net when present", () => {
    const body = JSON.stringify({
      success: true,
      data: { transaction_status: "Completed", amount_received: 3600, charge: 100, settlement_amount: 3500 },
    });
    const s = parsePayazaBody(200, body);
    expect(s.netNgn).toBe(3500);
    expect(s.feeNgn).toBe(100);
  });

  it("leaves fee and net null when Payaza reports no fee field (fallback path)", () => {
    const body = JSON.stringify({
      success: true,
      data: { transaction_status: "Completed", amount_received: 3500 },
    });
    const s = parsePayazaBody(200, body);
    expect(s.amountNgn).toBe(3500);
    expect(s.feeNgn).toBeNull();
    expect(s.netNgn).toBeNull();
  });

  it("throws on 401/403/5xx (real upstream errors)", () => {
    expect(() => parsePayazaBody(401, "nope")).toThrow(/payaza verify failed/);
  });

  it("returns raw for display", () => {
    const body = JSON.stringify({ success: true, data: { transaction_status: "Completed", amount_received: 3600, fee: 100 } });
    const s = parsePayazaBody(200, body);
    expect(s.raw).toMatchObject({ data: { fee: 100 } });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run test/unit/payaza-parse.test.ts`
Expected: FAIL — `parsePayazaBody` is not exported.

- [ ] **Step 3: Implement the parser**

In `apps/api/src/payments/payaza.ts`:

1. Extend the interface (replace the existing `PayazaTransactionStatus`):

```ts
export interface PayazaTransactionStatus {
  status: string;
  amountNgn: number | null;
  feeNgn: number | null;
  netNgn: number | null;
  processorReference: string | null;
  authorization: { token: string; reusable: boolean } | null;
  raw: unknown;
}
```

2. Add the exported pure parser (place above `verifyPayazaTransaction`):

```ts
/** Pure body→status mapping, split out so it is unit-testable without HTTP.
 *  `httpStatus` is the fetch status; 401/403/5xx are hard errors (throw so the
 *  webhook 500s and Payaza retries). A 4xx JSON envelope is a legitimate
 *  "not confirmed yet" answer and falls through to a non-"Completed" status. */
export function parsePayazaBody(httpStatus: number, text: string): PayazaTransactionStatus {
  if (httpStatus === 401 || httpStatus === 403 || httpStatus >= 500) {
    throw new Error(`payaza verify failed: ${httpStatus} ${text}`);
  }
  let body: {
    success?: boolean;
    data?: {
      transaction_status?: string;
      amount_received?: number;
      // Payaza decides the fee per transaction — read it, never hardcode.
      // Field name confirmed against a real transaction in Task 7; read
      // candidates defensively so a naming variant does not silently drop it.
      fee?: number;
      charge?: number;
      transaction_fee?: number;
      processor_fee?: number;
      settlement_amount?: number;
      amount_settled?: number;
      transaction_reference?: string;
      merchant_transaction_reference?: string;
      authorization?: { authorization_code?: string; reusable?: boolean };
    } | null;
  };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`payaza verify failed: ${httpStatus} ${text}`);
  }
  const d = body.data ?? {};
  const num = (v: unknown): number | null => (typeof v === "number" ? Math.round(v) : null);
  const gross = num(d.amount_received);
  const feeNgn = num(d.fee) ?? num(d.charge) ?? num(d.transaction_fee) ?? num(d.processor_fee);
  const settlement = num(d.settlement_amount) ?? num(d.amount_settled);
  const netNgn = settlement ?? (gross != null && feeNgn != null ? gross - feeNgn : null);
  const authCode = d.authorization?.authorization_code;
  return {
    status: d.transaction_status ?? (body.success ? "Completed" : "PENDING"),
    amountNgn: gross,
    feeNgn,
    netNgn,
    processorReference: d.transaction_reference ?? d.merchant_transaction_reference ?? null,
    authorization: authCode ? { token: authCode, reusable: d.authorization?.reusable ?? false } : null,
    raw: body,
  };
}
```

3. Refactor `verifyPayazaTransaction` to use it — replace its body-parsing block (from `const text = await res.text();` through the final `return {...}`) with:

```ts
  const text = await res.text();
  return parsePayazaBody(res.status, text);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run test/unit/payaza-parse.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Fix any callers broken by the new required fields**

The reconcile unit test and any other callers build a `PayazaTransactionStatus` literal. They now miss `feeNgn`/`netNgn`/`raw`. Task 3 updates the reconcile test; for now confirm the typecheck surface:

Run: `cd apps/api && npx tsc --noEmit`
Expected: errors ONLY in `test/unit/reconcile.test.ts` (fixed in Task 3) and possibly `lib/subscriptions.ts` (see below). If `activateSubscriptionFromPayment` destructures `PayazaTransactionStatus`, it still compiles (new fields are additive); no change needed unless tsc flags it.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/payments/payaza.ts apps/api/test/unit/payaza-parse.test.ts
git commit -m "feat(payments): parse Payaza fee/gross/net + raw breakdown from verify response"
```

---

### Task 3: Fee-aware reconciliation (NET ≥ total) + persist breakdown

**Files:**
- Modify: `apps/api/src/payments/reconcile.ts`
- Test: `apps/api/test/unit/reconcile.test.ts`

**Interfaces:**
- Consumes: `PayazaTransactionStatus` (with `feeNgn`, `netNgn`, `amountNgn`, `raw`) from Task 2; `payment.feeNgn/grossNgn/netNgn/rawBreakdown`, `saleOrder.feeShortfallNgn` from Task 1.
- Produces: updated `ReconcileOutcome`:
  ```ts
  export type ReconcileOutcome =
    | { kind: "order_not_found" }
    | { kind: "already_processed"; status: string }
    | { kind: "not_completed"; payazaStatus: string }
    | { kind: "underpaid"; totalNgn: number; netNgn: number; shortfallNgn: number }
    | { kind: "paid"; orderNumber: string; amountNgn: number; isPreorder: boolean };
  ```
  (`amount_mismatch` is replaced by `underpaid`.)
- Reconcile rule: `effectiveNet = netNgn ?? amountNgn ?? totalNgn`. Paid when `effectiveNet >= totalNgn - TOLERANCE`; else `underpaid`. `TOLERANCE = 1` (naira). When `netNgn` is null (no fee field), `effectiveNet` falls back to `amountNgn` (gross ≥ total still kills false positives — spec fallback).

- [ ] **Step 1: Update the failing tests**

In `apps/api/test/unit/reconcile.test.ts`:

1. Add a helper to build a full status (the literal now needs the new fields). At the top, after imports:

```ts
function status(over: Partial<{ amountNgn: number | null; feeNgn: number | null; netNgn: number | null }>) {
  return {
    status: "Completed",
    amountNgn: 3600,
    feeNgn: 100,
    netNgn: 3500,
    processorReference: "P-1",
    authorization: null,
    raw: { data: { amount_received: 3600, fee: 100 } },
    ...over,
  } as const;
}
```

2. Replace the "parks reconcile_needed when the amount differs" test with a net-based one:

```ts
  it("parks underpaid when NET is below the product total", async () => {
    const { tx, calls } = fakeTx(null);
    // Customer paid 3400 gross, fee 100 -> net 3300 < total 3500.
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      status({ amountNgn: 3400, feeNgn: 100, netNgn: 3300 }),
    );
    expect(r).toEqual({ kind: "underpaid", totalNgn: 3500, netNgn: 3300, shortfallNgn: 200 });
    expect(calls.inserts.some((i: any) => i.v.eventType === "sale.fee_shortfall")).toBe(true);
    // Order flagged reconcile_needed with the shortfall recorded.
    expect(calls.updates.some((u: any) => u.v.status === "reconcile_needed" && u.v.feeShortfallNgn === 200)).toBe(true);
  });

  it("marks PAID when NET meets the product total even though gross is fee-inclusive", async () => {
    const { tx, calls } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      status({ amountNgn: 3600, feeNgn: 100, netNgn: 3500 }),
    );
    expect(r.kind).toBe("paid");
    // ANALYTICS BOUNDARY: revenue figure (amount_ngn) is the product total, NOT the gross.
    expect(
      calls.inserts.some(
        (i: any) => i.t === payment && i.v.status === "paid" && i.v.amountNgn === 3500 && i.v.grossNgn === 3600 && i.v.feeNgn === 100 && i.v.netNgn === 3500,
      ),
    ).toBe(true);
  });

  it("falls back to gross>=total when Payaza reports no fee (net null)", async () => {
    const { tx } = fakeTx(null);
    const r = await applyPayazaConfirmation(
      tx as any, { ...baseOrder } as any,
      status({ amountNgn: 3500, feeNgn: null, netNgn: null }),
    );
    expect(r.kind).toBe("paid");
  });
```

3. Update the three remaining existing tests that pass a bare status literal (`already paid`, the happy-path paid test, preorder test, acceptReportedAmount test, CAS-loser test) to use `status({...})`. For example the happy-path becomes `status({ amountNgn: 3600, netNgn: 3500 })` and keep its assertion `i.v.amountNgn === 3500` (product total). The `acceptReportedAmount` test: pass `status({ amountNgn: 3400, netNgn: 3300 })` and expect `r.kind === "paid"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run test/unit/reconcile.test.ts`
Expected: FAIL — `underpaid` outcome and new payment columns not yet implemented.

- [ ] **Step 3: Implement fee-aware reconcile**

In `apps/api/src/payments/reconcile.ts`:

1. Replace the `ReconcileOutcome` type's `amount_mismatch` member with:

```ts
  | { kind: "underpaid"; totalNgn: number; netNgn: number; shortfallNgn: number }
```

2. Replace the mismatch block (the `if (!opts?.acceptReportedAmount && confirmed.amountNgn != null && confirmed.amountNgn !== o.totalNgn) { ... }` block) with a NET-based check:

```ts
  // What actually settles to the business = net (customer-paid minus Payaza's
  // fee). Payaza always deducts its fee, so the order is "paid in full" only
  // when net >= product total. Fall back to gross when Payaza reports no fee
  // field (still kills false positives; loses exact underpayment detection).
  const TOLERANCE = 1; // naira, absorbs Payaza's kobo rounding
  const effectiveNet = confirmed.netNgn ?? confirmed.amountNgn ?? o.totalNgn;
  if (!opts?.acceptReportedAmount && effectiveNet < o.totalNgn - TOLERANCE) {
    const shortfallNgn = o.totalNgn - effectiveNet;
    const won = await tx
      .update(saleOrder)
      .set({ status: "reconcile_needed", feeShortfallNgn: shortfallNgn, updatedAt: new Date() })
      .where(and(eq(saleOrder.id, o.id), eq(saleOrder.status, "confirmed")))
      .returning({ id: saleOrder.id });
    if (won.length === 0) return { kind: "already_processed", status: o.status };
    await tx.insert(outboxEvent).values({
      eventType: "sale.fee_shortfall",
      payload: {
        sale_order_id: o.id,
        order_number: o.orderNumber,
        total_ngn: o.totalNgn,
        gross_ngn: confirmed.amountNgn,
        fee_ngn: confirmed.feeNgn,
        net_ngn: effectiveNet,
        shortfall_ngn: shortfallNgn,
        payaza_reference: confirmed.processorReference ?? null,
      },
    });
    return { kind: "underpaid", totalNgn: o.totalNgn, netNgn: effectiveNet, shortfallNgn };
  }
```

3. In the `paid` path, when inserting the `payment` row, add the breakdown columns and keep `amountNgn` as the product total (analytics boundary). Also clear any prior shortfall. Replace the payment insert and the `amountNgn` computation:

```ts
  // amount_ngn stays the product total (the business's money) so revenue
  // reports that SUM(payment.amount_ngn) never include Payaza's fee.
  await tx.insert(payment).values({
    saleOrderId: o.id,
    method: "card",
    amountNgn: o.totalNgn,
    grossNgn: confirmed.amountNgn ?? null,
    feeNgn: confirmed.feeNgn ?? null,
    netNgn: confirmed.netNgn ?? (confirmed.amountNgn != null && confirmed.feeNgn != null ? confirmed.amountNgn - confirmed.feeNgn : null),
    rawBreakdown: confirmed.raw ?? null,
    status: "paid",
    processor: "payaza",
    processorReference: confirmed.processorReference ?? null,
    paidAt: new Date(),
  });
```

Remove the now-unused `const amountNgn = opts?.acceptReportedAmount ? ... : o.totalNgn;` line and change the final `paid` return to use `o.totalNgn`:

```ts
  return { kind: "paid", orderNumber: o.orderNumber, amountNgn: o.totalNgn, isPreorder: o.isPreorder };
```

Also add `feeShortfallNgn: null` to the `confirmed → paid` status UPDATE `.set({...})` so a re-reconciled order clears a stale shortfall:

```ts
    .set({ status: "paid", paymentStatus: "paid", feeShortfallNgn: null, updatedAt: new Date() })
```

- [ ] **Step 4: Update the webhook + any switch over `amount_mismatch`**

In `apps/api/src/routes/webhooks-payaza.ts:128`, rename the `case "amount_mismatch":` to `case "underpaid":` and update its log fields:

```ts
      case "underpaid":
        logger.warn(
          { requestId, reference, totalNgn: outcome.totalNgn, netNgn: outcome.netNgn, shortfallNgn: outcome.shortfallNgn },
          "payaza webhook: UNDERPAID — parked for reconcile",
        );
        break;
```

Search for other consumers: `cd apps/api && grep -rn "amount_mismatch" src/`. Update any remaining switch arms (e.g. payaza-reconcile job, admin recheck) the same way; if a handler only logs, mirror the webhook change.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run test/unit/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 6: Full API typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors. Fix any remaining `amount_mismatch` references or missing status fields.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/payments/reconcile.ts apps/api/test/unit/reconcile.test.ts apps/api/src/routes/webhooks-payaza.ts
git commit -m "feat(payments): reconcile on NET>=total, record fee shortfall, keep fee out of revenue"
```

---

### Task 4: Expose the breakdown on the order-detail API

**Files:**
- Modify: `apps/api/src/routes/sales.ts:819-838` (order-detail response)
- Test: `apps/api/test/integration/payments-admin.test.ts` (add an assertion) OR a focused unit if integration is heavy — see Step 1.

**Interfaces:**
- Consumes: `payment.feeNgn/grossNgn/netNgn`, `saleOrder.feeShortfallNgn`.
- Produces: order-detail JSON now includes `feeNgn`, `grossNgn`, `netNgn` (from latest payment) alongside existing `reportedNgn`, and `feeShortfallNgn` (already flows via `...o`). UI (Task 5) consumes these.

- [ ] **Step 1: Write the failing integration assertion**

Open `apps/api/test/integration/payments-admin.test.ts`. Find a test that pays an online order via Payaza confirmation and then GETs the owner order detail. Add assertions after the detail fetch (adapt variable names to the file):

```ts
    // Breakdown surfaced for the owner order detail.
    expect(detail.data.grossNgn).toBe(3600);
    expect(detail.data.feeNgn).toBe(100);
    expect(detail.data.netNgn).toBe(3500);
    expect(detail.data.feeShortfallNgn ?? null).toBeNull();
```

If no such test exists, add one modeled on the existing "webhook marks order paid" integration test, seeding a Payaza confirm of `{ amount_received: 3600, fee: 100 }` for a `total_ngn: 3500` order, then GET `/v1/sales/orders/:id` (use the route the owner detail page calls — confirm the exact path in `sales.ts`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/payments-admin.test.ts`
Expected: FAIL — `grossNgn`/`feeNgn`/`netNgn` undefined on the response.

- [ ] **Step 3: Implement — widen the latest-payment select and response**

In `apps/api/src/routes/sales.ts`, change the `latestPayment` select (line ~822) to include the new columns:

```ts
    const [latestPayment] = await db
      .select({
        amountNgn: payment.amountNgn,
        feeNgn: payment.feeNgn,
        grossNgn: payment.grossNgn,
        netNgn: payment.netNgn,
      })
      .from(payment)
      .where(eq(payment.saleOrderId, id))
      .orderBy(descFn(payment.createdAt))
      .limit(1);
```

And extend the returned `data` object (line ~837):

```ts
        reportedNgn: latestPayment?.amountNgn ?? null,
        grossNgn: latestPayment?.grossNgn ?? null,
        feeNgn: latestPayment?.feeNgn ?? null,
        netNgn: latestPayment?.netNgn ?? null,
```

(`feeShortfallNgn` already comes through `...o`.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run test/integration/payments-admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sales.ts apps/api/test/integration/payments-admin.test.ts
git commit -m "feat(api): expose Payaza fee/gross/net breakdown on order detail"
```

---

### Task 5: Order-detail money breakdown UI (owner + branch)

**Files:**
- Modify: `apps/admin/src/routes/owner/order-detail.tsx` (money block ~lines 505-518 and the type ~lines 37-40)
- Modify: `apps/admin/src/routes/branch/online-order-detail.tsx` (same money block, if present)

**Interfaces:**
- Consumes: order-detail JSON `grossNgn`, `feeNgn`, `netNgn`, `feeShortfallNgn`, `totalNgn`, `subtotalNgn`, `deliveryFeeNgn` from Task 4.
- Produces: none (leaf UI).

This is a React/UI task with no unit test harness for rendering (per project history, admin has no render tests). Verify by typecheck + build + visual read.

- [ ] **Step 1: Extend the local order type**

In `apps/admin/src/routes/owner/order-detail.tsx`, add to the data interface (near lines 37-40):

```ts
  grossNgn: number | null;
  feeNgn: number | null;
  netNgn: number | null;
  feeShortfallNgn: number | null;
```

- [ ] **Step 2: Render the breakdown for card orders**

Replace the Subtotal/Delivery/Total block (around lines 505-518) so that, when `data.paymentMethod === "card"` and `data.grossNgn != null`, it shows the full breakdown; otherwise it renders today's Subtotal/Delivery/Total unchanged. Use the existing `ngn()` formatter and the surrounding row markup style. Example inner rows to add after the existing Total row:

```tsx
{data.paymentMethod === "card" && data.grossNgn != null && (
  <>
    <div className="row"><span>Payaza fee (customer paid)</span><span>{data.feeNgn != null ? ngn(data.feeNgn) : "—"}</span></div>
    <div className="row"><span>Customer paid (gross)</span><span>{ngn(data.grossNgn)}</span></div>
    <div className="row"><span>Net settled to you</span><span>{data.netNgn != null ? ngn(data.netNgn) : "—"}</span></div>
    {data.feeShortfallNgn != null && data.feeShortfallNgn > 0 && (
      <div className="row" style={{ color: "var(--danger, #c0392b)", fontWeight: 600 }}>
        <span>Shortfall (loss)</span><span>-{ngn(data.feeShortfallNgn)}</span>
      </div>
    )}
  </>
)}
```

Match the actual class names / inline-style pattern already used in that block (the file uses inline styles at lines ~506-517 — mirror them rather than introducing `className="row"` if the file doesn't use it).

- [ ] **Step 3: Mirror on the branch online-order detail**

Apply the same type extension + breakdown block to `apps/admin/src/routes/branch/online-order-detail.tsx` if it renders a money summary. If it does not show a money block, skip (note it in the commit body).

- [ ] **Step 4: Typecheck + build the admin app**

Run: `cd apps/admin && npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/routes/owner/order-detail.tsx apps/admin/src/routes/branch/online-order-detail.tsx
git commit -m "feat(admin): show Payaza fee/gross/net + shortfall breakdown on order detail"
```

---

### Task 6: Surface shortfall in the owner review inbox

**Files:**
- Modify: `apps/api/src/routes/review.ts:45-79` (reported/shortfall enrichment)
- Modify: `apps/admin/src/routes/owner/review.tsx` (show shortfall + net)
- Test: `apps/api/test/integration/review.test.ts`

**Interfaces:**
- Consumes: `saleOrder.feeShortfallNgn`, `payment.netNgn`.
- Produces: each review row gains `net_ngn` and `shortfall_ngn`.

- [ ] **Step 1: Write the failing assertion**

In `apps/api/test/integration/review.test.ts`, in the test that lists a reconcile-flagged order, add:

```ts
    expect(row.shortfall_ngn).toBe(200);
    expect(row.net_ngn).toBe(3300);
```

(Seed the flagged order with `fee_shortfall_ngn = 200` and a payment `net_ngn = 3300`, matching the underpaid Task 3 scenario.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/review.test.ts`
Expected: FAIL — `shortfall_ngn`/`net_ngn` undefined.

- [ ] **Step 3: Implement the enrichment**

In `apps/api/src/routes/review.ts`, extend the payment select (line ~52) to include `netNgn: payment.netNgn`, build a `netByOrderId` lookup alongside `reportedByOrderId`, and add to each row (line ~79):

```ts
      net_ngn: netByOrderId.get(o.id) ?? null,
      shortfall_ngn: o.feeShortfallNgn ?? null,
```

(`o.feeShortfallNgn` requires the review query to select the order's `feeShortfallNgn`; add it to that select if it uses an explicit column list.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run test/integration/review.test.ts`
Expected: PASS.

- [ ] **Step 5: Show it in the review UI**

In `apps/admin/src/routes/owner/review.tsx`, add a "Shortfall" figure to each flagged row where `shortfall_ngn > 0`, styled as a loss (reuse the danger color pattern from Task 5). Keep it minimal — one line per row.

- [ ] **Step 6: Typecheck admin + API**

Run: `cd apps/admin && npx tsc --noEmit` and `cd apps/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/review.ts apps/admin/src/routes/owner/review.tsx apps/api/test/integration/review.test.ts
git commit -m "feat(review): surface fee shortfall + net on the owner reconcile inbox"
```

---

### Task 7: Confirm Payaza's real field names against a live transaction (spec step 0)

**Files:** none (verification) — may result in a one-line change to `apps/api/src/payments/payaza.ts` candidate list.

**Interfaces:** none.

This closes the one empirical unknown: which exact field name Payaza uses for the fee/settlement. The defensive parser (Task 2) already reads several candidates and retains `raw`, so the code works regardless; this task confirms the primary field so we know net is exact (not the gross fallback).

- [ ] **Step 1: Pull a real completed transaction's raw body**

Pick a recent real paid online order number (e.g. `SO-2026-00380` from project history). Query Payaza's transaction-query endpoint the same way `verifyPayazaTransaction` does, and inspect the raw JSON. Options:
  - If prod access is available: run a small script or `curl` from the API server with the live `PAYAZA_PUBLIC_KEY`, hitting `${PAYAZA_API_BASE}/merchant-collection/transfer_notification_controller/merchant/transaction-query?merchant_reference=SO-2026-00380`.
  - Or read the `payment.raw_breakdown` column of a newly-paid order once this ships to prod.

- [ ] **Step 2: Confirm the fee + settlement field names**

Check the `data` object for the actual keys carrying the fee and the settled amount. Compare to the candidate lists in `parsePayazaBody` (`fee`/`charge`/`transaction_fee`/`processor_fee`; `settlement_amount`/`amount_settled`).

- [ ] **Step 3: If the real field differs, add it**

If Payaza uses a key not in the candidate list, add it to the appropriate `num(d.<key>) ?? ...` chain in `parsePayazaBody`, add a test case in `payaza-parse.test.ts` with the real shape, run `npx vitest run test/unit/payaza-parse.test.ts`, and commit:

```bash
git add apps/api/src/payments/payaza.ts apps/api/test/unit/payaza-parse.test.ts
git commit -m "fix(payments): read Payaza's actual fee field name <name> confirmed from live txn"
```

If the candidates already match, record the confirmed field name in the commit message of a docs note or leave a comment — no code change needed.

---

## Verification (whole feature)

- [ ] `cd apps/api && npx vitest run test/unit/payaza-parse.test.ts test/unit/reconcile.test.ts test/integration/payments-admin.test.ts test/integration/review.test.ts` — all green.
- [ ] `cd apps/api && npx tsc --noEmit` — clean.
- [ ] `cd apps/admin && npx tsc --noEmit && npm run build` — clean.
- [ ] Manual: a fee-inclusive paid order shows **no** "reconciliation needed" and displays the full breakdown; an underpaid order flags with a visible shortfall.
- [ ] Analytics boundary: confirm a revenue/daily-close figure for a paid card order equals the product total (not the gross) — spot-check on the dashboard.

## Self-review notes (coverage vs spec)

- Spec Part 1 (capture) → Task 2. Part 2 (persist) → Task 1 + Task 3 payment insert. Part 3 (net rule) → Task 3. Part 4 (order-detail UI) → Task 4 + Task 5. Part 5 (checkout unchanged) → no task, by design. Part 6 (review/report) → Task 6. Part 7 (analytics boundary) → enforced in Task 3 (amount_ngn = total) with an explicit assertion, plus whole-feature verification. Step 0 → Task 7.

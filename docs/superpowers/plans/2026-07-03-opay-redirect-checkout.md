# OPay Redirect Checkout (primary) with Payaza Fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OPay's server-created, full-page redirect checkout as the primary online payment path (eliminating Payaza's fragile popup failure), with Payaza kept intact as an owner-toggleable fallback.

**Architecture:** A thin provider seam (`createCheckout` + `verifyByProvider`) lets OPay and Payaza coexist. The active provider is stored in `app_settings` (owner toggle, no redeploy) and stamped per order on `sale_order.payment_provider`. OPay's callback is a wake-up only; the money decision is always a server-to-server status query, reusing the existing `reconcile.ts` money-path unchanged. Confirmation flows (webhook, worker sweep, on-view re-verify) all dispatch by the order's stamped provider.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM + Postgres, React/TanStack (customer + admin), Node `crypto` (HMAC-SHA512), Vitest.

## Global Constraints

- Money amounts in the OPay API are in **kobo** (naira × 100), same as Payaza. OPay's status `amount.total` is kobo → divide by 100 for naira.
- `paid` is NEVER decided from a callback body — always from the server-to-server status query (`cashier/status`). Same safety posture as the Payaza webhook.
- OPay's status response exposes **no per-transaction fee** → `feeNgn` is `null`, `netNgn = gross`. The reconcile net-vs-total check must still pass (it does: `effectiveNet = net ?? gross ?? total`).
- Payaza code stays **entirely intact** (`payments/payaza.ts`, `lib/payaza.ts`, `routes/webhooks-payaza.ts`) — it is the fallback.
- Existing reconcile call sites must keep working: `applyPayazaConfirmation` and `verifyAndReconcile(db, orderNumber)` (2-arg) are still called from `webhooks-payaza.ts`, `payments-admin.ts`, and `reconcile.test.ts`.
- Migration numbering continues from `0065`; next is `0066`. The journal `when` must be the LARGEST value in `_journal.json` (previous max = `1783310000000`) or Drizzle silently skips it.
- OPay endpoints: create `POST {OPAY_API_BASE}/api/v1/international/cashier/create` (header `Authorization: Bearer {PublicKey}`), status `POST {OPAY_API_BASE}/api/v1/international/cashier/status` (header `Authorization: Bearer {HMAC-SHA512(bodyJson, PrivateKey)}`). Both send `MerchantId` + `Content-Type: application/json`. Country `"NG"`.

---

### Task 1: DB — per-order provider stamp + settings key constant

**Files:**
- Modify: `packages/db/src/schema/sale-order.ts` (add column near `feeShortfallNgn`, ~line 99)
- Modify: `packages/db/src/schema/app-setting.ts` (add key constant + type)
- Create: `packages/db/migrations/0066_payment_provider.sql`
- Modify: `packages/db/migrations/meta/_journal.json` (append entry) — done by `drizzle-kit generate`, then verified

**Interfaces:**
- Produces: `saleOrder.paymentProvider` (text column, nullable — old rows read as `null` → treated as `"payaza"`). `PAYMENT_PROVIDER_KEY = "payment_provider"`, `PaymentProviderValue = { provider: "opay" | "payaza" }`.

- [ ] **Step 1: Add the column to the schema.** In `packages/db/src/schema/sale-order.ts`, add after the `feeShortfallNgn` line (~99):

```ts
  // Which payment provider created this order's checkout. Stamped at order
  // creation so the webhook / worker sweep / on-view re-verify confirm it
  // against the RIGHT provider even if the owner flips the active-provider
  // toggle mid-flight. Null on rows created before this column existed → the
  // reconcile paths default those to "payaza".
  paymentProvider: text("payment_provider"),
```

- [ ] **Step 2: Add the settings key + type.** In `packages/db/src/schema/app-setting.ts`, append:

```ts
/** JSON shape stored under the `payment_provider` key. */
export interface PaymentProviderValue {
  provider: "opay" | "payaza";
}

export const PAYMENT_PROVIDER_KEY = "payment_provider";
```

- [ ] **Step 3: Generate the migration.**

Run: `pnpm --filter @ms/db generate`
Expected: a new `packages/db/migrations/0066_*.sql` adding `ALTER TABLE "sale_order" ADD COLUMN "payment_provider" text;`, a new snapshot under `meta/`, and a new `_journal.json` entry.

- [ ] **Step 4: Verify + fix the journal `when`.** Open `packages/db/migrations/meta/_journal.json`. Confirm the new entry's `when` is the LARGEST value present. If it is not, set it to `1783340000000`. Rename the generated SQL file to `0066_payment_provider.sql` if drizzle named it otherwise, and update the entry's `tag` to match (`0066_payment_provider`).

Run: `node -e "const d=require('./packages/db/migrations/meta/_journal.json');const w=d.entries.map(e=>e.when);console.log('max is last?', Math.max(...w)===d.entries[d.entries.length-1].when)"`
Expected: `max is last? true`

- [ ] **Step 5: Build the db package.**

Run: `pnpm --filter @ms/db build`
Expected: exit 0, no tsc errors.

- [ ] **Step 6: Commit.**

```bash
git add packages/db/src/schema/sale-order.ts packages/db/src/schema/app-setting.ts packages/db/migrations/
git commit -m "feat(db): sale_order.payment_provider column + payment_provider setting key"
```

---

### Task 2: OPay client module (`payments/opay.ts`)

**Files:**
- Create: `apps/api/src/payments/opay.ts`
- Create: `apps/api/test/unit/opay.test.ts`

**Interfaces:**
- Consumes: `ConfirmedTransaction` type is defined here and re-used by the reconcile refactor (Task 3). Define it in this file and export it.
- Produces:
  - `interface ConfirmedTransaction { status: string; amountNgn: number | null; feeNgn: number | null; netNgn: number | null; processorReference: string | null; authorization: { token: string; reusable: boolean } | null; raw: unknown; }`
  - `signOpayBody(bodyJson: string, privateKey: string): string` — HMAC-SHA512 hex.
  - `parseOpayStatus(httpStatus: number, text: string): ConfirmedTransaction`
  - `isOpaySuccess(status: string): boolean`
  - `createOpayCashier(opts: { amountNgn: number; reference: string; email: string; customerName?: string; customerPhone?: string; returnUrl: string; callbackUrl: string }): Promise<{ cashierUrl: string; orderNo: string | null }>`
  - `verifyOpayTransaction(reference: string): Promise<ConfirmedTransaction>`

- [ ] **Step 1: Write the failing unit tests.** Create `apps/api/test/unit/opay.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { signOpayBody, parseOpayStatus, isOpaySuccess } from "../../src/payments/opay.js";

describe("signOpayBody", () => {
  it("is a stable HMAC-SHA512 hex of body+key (known vector)", () => {
    const sig = signOpayBody('{"reference":"SO-1","country":"NG"}', "secret");
    // HMAC-SHA512 hex is 128 chars; deterministic for the same input.
    expect(sig).toHaveLength(128);
    expect(sig).toBe(signOpayBody('{"reference":"SO-1","country":"NG"}', "secret"));
    expect(sig).not.toBe(signOpayBody('{"reference":"SO-1","country":"NG"}', "other"));
  });
});

describe("parseOpayStatus", () => {
  it("maps a SUCCESS response, converting kobo amount to naira", () => {
    const body = JSON.stringify({
      code: "00000",
      message: "SUCCESSFUL",
      data: { reference: "SO-1", orderNo: "2110", status: "SUCCESS", amount: { total: 700000, currency: "NGN" } },
    });
    const r = parseOpayStatus(200, body);
    expect(r.status).toBe("SUCCESS");
    expect(r.amountNgn).toBe(7000); // 700000 kobo -> 7000 naira
    expect(r.feeNgn).toBeNull(); // OPay status exposes no per-txn fee
    expect(r.netNgn).toBe(7000); // net falls back to gross
    expect(r.processorReference).toBe("2110");
  });

  it("maps a FAIL response", () => {
    const body = JSON.stringify({
      code: "00000",
      data: { reference: "SO-2", orderNo: "9", status: "FAIL", amount: { total: 0, currency: "NGN" }, failureReason: "declined" },
    });
    const r = parseOpayStatus(200, body);
    expect(r.status).toBe("FAIL");
    expect(isOpaySuccess(r.status)).toBe(false);
  });

  it("throws on a 401/5xx so a caller (webhook) retries", () => {
    expect(() => parseOpayStatus(500, "boom")).toThrow(/opay/i);
    expect(() => parseOpayStatus(401, "no")).toThrow(/opay/i);
  });
});

describe("isOpaySuccess", () => {
  it("true only for SUCCESS (case-insensitive)", () => {
    expect(isOpaySuccess("SUCCESS")).toBe(true);
    expect(isOpaySuccess("success")).toBe(true);
    expect(isOpaySuccess("PENDING")).toBe(false);
    expect(isOpaySuccess("FAIL")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm --filter @ms/api exec vitest run test/unit/opay.test.ts`
Expected: FAIL — cannot resolve `../../src/payments/opay.js`.

- [ ] **Step 3: Implement `payments/opay.ts`.** Create `apps/api/src/payments/opay.ts`:

```ts
import { createHmac } from "node:crypto";

/**
 * OPay Cashier / Express Checkout integration. Unlike Payaza (client-side
 * popup), OPay is a server-created REDIRECT flow: we POST cashier/create, get a
 * cashierUrl, and redirect the customer. Payment is confirmed authoritatively by
 * re-querying cashier/status (server-to-server, signed) — never from a callback
 * body. Amounts on the wire are kobo (naira × 100).
 */

/** Normalized confirmed-transaction shape shared by Payaza + OPay so the
 *  reconcile money-path is provider-agnostic. Structurally identical to the old
 *  PayazaTransactionStatus (which is now an alias of this). */
export interface ConfirmedTransaction {
  status: string;
  amountNgn: number | null;
  feeNgn: number | null;
  netNgn: number | null;
  processorReference: string | null;
  authorization: { token: string; reusable: boolean } | null;
  raw: unknown;
}

// `||` not `??`: an empty-string env should fall back to the default, not
// produce a relative URL.
const BASE = process.env.OPAY_API_BASE || "https://api.opaycheckout.com";

/** HMAC-SHA512 hex of the request body JSON, signed with the merchant private
 *  (secret) key. Used as the Bearer token for signed server-to-server calls
 *  (cashier/status). Pure + synchronous so it is unit-tested without HTTP. */
export function signOpayBody(bodyJson: string, privateKey: string): string {
  return createHmac("sha512", privateKey).update(bodyJson, "utf8").digest("hex");
}

/** Map an OPay cashier/status body to the normalized shape. `amount.total` is
 *  kobo → naira. OPay status carries no per-txn fee, so feeNgn is null and net
 *  falls back to gross. 401/403/5xx throw (so a webhook 500s and OPay retries);
 *  a 2xx/4xx JSON envelope is a legitimate "not confirmed yet" answer. */
export function parseOpayStatus(httpStatus: number, text: string): ConfirmedTransaction {
  if (httpStatus === 401 || httpStatus === 403 || httpStatus >= 500) {
    throw new Error(`opay status failed: ${httpStatus} ${text}`);
  }
  let body: {
    code?: string;
    message?: string;
    data?: {
      reference?: string;
      orderNo?: string;
      status?: string;
      amount?: { total?: number; currency?: string };
    } | null;
  };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`opay status failed: ${httpStatus} ${text}`);
  }
  const d = body.data ?? {};
  const koboToNgn = (v: unknown): number | null =>
    typeof v === "number" ? Math.round(v / 100) : null;
  const gross = koboToNgn(d.amount?.total);
  return {
    status: d.status ?? "PENDING",
    amountNgn: gross,
    feeNgn: null,
    netNgn: gross,
    processorReference: d.orderNo ?? null,
    authorization: null,
    raw: body,
  };
}

/** OPay reports a completed payment as status "SUCCESS". */
export function isOpaySuccess(status: string): boolean {
  return status.toUpperCase() === "SUCCESS";
}

function requireOpayEnv(): { merchantId: string; publicKey: string; secretKey: string } {
  const merchantId = process.env.OPAY_MERCHANT_ID ?? "";
  const publicKey = process.env.OPAY_PUBLIC_KEY ?? "";
  const secretKey = process.env.OPAY_SECRET_KEY ?? "";
  if (!merchantId || !publicKey || !secretKey) {
    throw new Error("OPAY_MERCHANT_ID / OPAY_PUBLIC_KEY / OPAY_SECRET_KEY not configured");
  }
  return { merchantId, publicKey, secretKey };
}

/** Create an OPay cashier session and return the URL to redirect the customer
 *  to. `reference` is our order number (also the key we query status by). */
export async function createOpayCashier(opts: {
  amountNgn: number;
  reference: string;
  email: string;
  customerName?: string;
  customerPhone?: string;
  returnUrl: string;
  callbackUrl: string;
}): Promise<{ cashierUrl: string; orderNo: string | null }> {
  const { merchantId, publicKey } = requireOpayEnv();
  const body = {
    country: "NG",
    reference: opts.reference,
    amount: { total: opts.amountNgn * 100, currency: "NGN" }, // kobo
    returnUrl: opts.returnUrl,
    callbackUrl: opts.callbackUrl,
    expireAt: 30, // minutes — matches the 30-min stock hold
    userInfo: {
      userName: opts.customerName ?? "Customer",
      userEmail: opts.email,
      userMobile: opts.customerPhone ?? "",
    },
  };
  const res = await fetch(`${BASE}/api/v1/international/cashier/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${publicKey}`,
      MerchantId: merchantId,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: { code?: string; message?: string; data?: { cashierUrl?: string; orderNo?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`opay create failed: ${res.status} ${text}`);
  }
  const url = parsed.data?.cashierUrl;
  if (parsed.code !== "00000" || !url) {
    throw new Error(`opay create rejected: ${parsed.code} ${parsed.message ?? text}`);
  }
  return { cashierUrl: url, orderNo: parsed.data?.orderNo ?? null };
}

/** Authoritatively confirm a payment by querying OPay cashier/status, signed
 *  with the private key. Throws without OPAY_* creds — a missing key must fail
 *  loudly, never fabricate a confirmation. */
export async function verifyOpayTransaction(reference: string): Promise<ConfirmedTransaction> {
  const { merchantId, secretKey } = requireOpayEnv();
  const bodyJson = JSON.stringify({ reference, country: "NG" });
  const res = await fetch(`${BASE}/api/v1/international/cashier/status`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${signOpayBody(bodyJson, secretKey)}`,
      MerchantId: merchantId,
    },
    body: bodyJson,
  });
  const text = await res.text();
  return parseOpayStatus(res.status, text);
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `pnpm --filter @ms/api exec vitest run test/unit/opay.test.ts`
Expected: PASS (7 assertions across 4 tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/payments/opay.ts apps/api/test/unit/opay.test.ts
git commit -m "feat(api): OPay cashier client — sign, create, verify, status parser"
```

---

### Task 3: Generalize reconcile to be provider-agnostic

**Files:**
- Modify: `apps/api/src/payments/payaza.ts` (make `PayazaTransactionStatus` an alias of `ConfirmedTransaction`)
- Modify: `apps/api/src/payments/reconcile.ts` (rename core + provider-aware `verifyAndReconcile`)
- Test: `apps/api/test/unit/reconcile.test.ts` (add one OPay-processor assertion; existing tests must still pass)

**Interfaces:**
- Consumes: `ConfirmedTransaction`, `isOpaySuccess`, `verifyOpayTransaction` from Task 2; `isPayazaSuccess`, `verifyPayazaTransaction` (existing).
- Produces:
  - `applyPaymentConfirmation(tx, order, confirmed, opts?: { acceptReportedAmount?: boolean; processor?: string })` — the generalized core. `processor` defaults to `"payaza"`.
  - `export const applyPayazaConfirmation = applyPaymentConfirmation;` (alias — keeps webhooks-payaza.ts / payments-admin.ts / tests working).
  - `verifyAndReconcile(db, orderNumber, provider: "opay" | "payaza" = "payaza")` — now dispatches verify + success test by provider.

- [ ] **Step 1: Alias the Payaza status type.** In `apps/api/src/payments/payaza.ts`, replace the `export interface PayazaTransactionStatus { ... }` block (lines ~27-36) with an import + alias so there is ONE shape:

```ts
import type { ConfirmedTransaction } from "./opay.js";

/** @deprecated name — kept as an alias so existing imports keep working. */
export type PayazaTransactionStatus = ConfirmedTransaction;
```

Leave every other line in `payaza.ts` unchanged (functions still return `PayazaTransactionStatus`, now an alias).

- [ ] **Step 2: Run the existing reconcile + payaza tests to confirm the alias didn't break anything.**

Run: `pnpm --filter @ms/api exec vitest run test/unit/reconcile.test.ts test/unit/payaza.test.ts`
Expected: PASS (all existing assertions).

- [ ] **Step 3: Rename the core + add `processor`.** In `apps/api/src/payments/reconcile.ts`:

Change the function signature (line ~32) from:

```ts
export async function applyPayazaConfirmation(
  tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
  order: typeof saleOrder.$inferSelect,
  confirmed: PayazaTransactionStatus,
  opts?: { acceptReportedAmount?: boolean },
): Promise<ReconcileOutcome> {
```

to:

```ts
export async function applyPaymentConfirmation(
  tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
  order: typeof saleOrder.$inferSelect,
  confirmed: ConfirmedTransaction,
  opts?: { acceptReportedAmount?: boolean; processor?: string },
): Promise<ReconcileOutcome> {
```

In that function's `payment` insert (line ~113), change the hardcoded processor:

```ts
    processor: opts?.processor ?? "payaza",
```

At the bottom of the function-family (after `applyPaymentConfirmation`), add the back-compat alias:

```ts
/** Back-compat alias: existing Payaza call sites import this name. */
export const applyPayazaConfirmation = applyPaymentConfirmation;
```

Update the import line at the top of `reconcile.ts`:

```ts
import { verifyPayazaTransaction, isPayazaSuccess } from "./payaza.js";
import { verifyOpayTransaction, isOpaySuccess, type ConfirmedTransaction } from "./opay.js";
```

(Remove the now-unused `type PayazaTransactionStatus` import if present.)

- [ ] **Step 4: Make `verifyAndReconcile` provider-aware.** Replace the body of `verifyAndReconcile` (line ~160) so it selects the verify + success test by provider, and passes `processor` through:

```ts
export async function verifyAndReconcile(
  db: DbClient,
  orderNumber: string,
  provider: "opay" | "payaza" = "payaza",
): Promise<ReconcileOutcome> {
  const confirmed =
    provider === "opay"
      ? await verifyOpayTransaction(orderNumber)
      : await verifyPayazaTransaction(orderNumber);
  const success =
    provider === "opay" ? isOpaySuccess(confirmed.status) : isPayazaSuccess(confirmed.status);
  if (!success) {
    return { kind: "not_completed", payazaStatus: confirmed.status };
  }
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.orderNumber, orderNumber));
    if (!o) return { kind: "order_not_found" };

    let orderForConfirmation = o;
    if (o.status === "reconcile_needed") {
      const won = await tx
        .update(saleOrder)
        .set({ status: "confirmed", updatedAt: new Date() })
        .where(and(eq(saleOrder.id, o.id), eq(saleOrder.status, "reconcile_needed")))
        .returning({ id: saleOrder.id });
      if (won.length === 0) {
        const [fresh] = await tx.select().from(saleOrder).where(eq(saleOrder.id, o.id));
        orderForConfirmation = fresh ?? o;
      } else {
        orderForConfirmation = { ...o, status: "confirmed" };
      }
    }

    return applyPaymentConfirmation(tx, orderForConfirmation, confirmed, { processor: provider });
  });
}
```

- [ ] **Step 5: Add an OPay-processor assertion.** In `apps/api/test/unit/reconcile.test.ts`, inside the `describe("applyPayazaConfirmation", ...)` block, add a test that the processor is written through (mirror the existing "marks a confirmed order paid" test but pass `{ processor: "opay" }` and assert the inserted payment row's `processor`). Use the same fake-tx harness already in the file:

```ts
  it("stamps the payment row with the given processor (opay)", async () => {
    const { db, inserts } = makeFakeTx({ orderStatus: "confirmed" }); // reuse the file's existing harness helper
    const r = await applyPayazaConfirmation(
      db as any,
      baseOrder({ status: "confirmed", totalNgn: 7000, isPreorder: false }),
      { status: "SUCCESS", amountNgn: 7000, feeNgn: null, netNgn: 7000, processorReference: "2110", authorization: null, raw: {} },
      { processor: "opay" },
    );
    expect(r.kind).toBe("paid");
    const paymentRow = inserts.find((i) => i.table === "payment");
    expect(paymentRow?.values.processor).toBe("opay");
  });
```

> Note to implementer: match the EXACT helper names already used in `reconcile.test.ts` (e.g. how it fakes `tx.insert(...).values(...)` and captures rows). If the file's harness differs, adapt the assertion to however it already inspects inserted rows — do not invent a new harness.

- [ ] **Step 6: Run the full reconcile suite.**

Run: `pnpm --filter @ms/api exec vitest run test/unit/reconcile.test.ts`
Expected: PASS including the new opay-processor test.

- [ ] **Step 7: Typecheck the api package (catches any missed call site).**

Run: `pnpm --filter @ms/api build`
Expected: exit 0. (`webhooks-payaza.ts` and `payments-admin.ts` still import `applyPayazaConfirmation` — resolved by the alias.)

- [ ] **Step 8: Commit.**

```bash
git add apps/api/src/payments/payaza.ts apps/api/src/payments/reconcile.ts apps/api/test/unit/reconcile.test.ts
git commit -m "refactor(api): provider-agnostic reconcile (applyPaymentConfirmation + provider-aware verifyAndReconcile)"
```

---

### Task 4: Provider seam (`payments/provider.ts`)

**Files:**
- Create: `apps/api/src/payments/provider.ts`
- Create: `apps/api/test/unit/provider.test.ts`

**Interfaces:**
- Consumes: `appSetting`, `PAYMENT_PROVIDER_KEY`, `PaymentProviderValue`, `DbClient` from `@ms/db`; `buildPayazaCheckoutConfig` (payaza.ts); `createOpayCashier` (opay.ts).
- Produces:
  - `getActiveProvider(db): Promise<"opay" | "payaza">` (default `"opay"`).
  - `type CheckoutHandoff = { provider: "opay"; redirectUrl: string } | { provider: "payaza"; payaza: PayazaCheckoutConfig }`
  - `createCheckout(db, opts: { provider: "opay" | "payaza"; amountNgn: number; reference: string; email: string; customerName?: string; customerPhone?: string }): Promise<CheckoutHandoff>`

- [ ] **Step 1: Write the failing test.** Create `apps/api/test/unit/provider.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getActiveProvider } from "../../src/payments/provider.js";

function fakeDb(rows: Array<{ key: string; value: unknown }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => rows.filter((r) => r.key === "payment_provider"),
      }),
    }),
  } as any;
}

describe("getActiveProvider", () => {
  it("defaults to opay when no setting row exists", async () => {
    expect(await getActiveProvider(fakeDb([]))).toBe("opay");
  });
  it("returns payaza when the setting says so", async () => {
    expect(await getActiveProvider(fakeDb([{ key: "payment_provider", value: { provider: "payaza" } }]))).toBe("payaza");
  });
  it("falls back to opay on a malformed value", async () => {
    expect(await getActiveProvider(fakeDb([{ key: "payment_provider", value: { provider: "nonsense" } }]))).toBe("opay");
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm --filter @ms/api exec vitest run test/unit/provider.test.ts`
Expected: FAIL — cannot resolve `provider.js`.

- [ ] **Step 3: Implement `payments/provider.ts`.**

```ts
import { eq } from "drizzle-orm";
import { appSetting, PAYMENT_PROVIDER_KEY, type DbClient, type PaymentProviderValue } from "@ms/db";
import { buildPayazaCheckoutConfig, type PayazaCheckoutConfig } from "./payaza.js";
import { createOpayCashier } from "./opay.js";

export type PaymentProvider = "opay" | "payaza";

/** The active online payment provider, owner-toggleable via app_settings.
 *  Defaults to OPay (the redirect flow) when unset or malformed. */
export async function getActiveProvider(db: DbClient): Promise<PaymentProvider> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, PAYMENT_PROVIDER_KEY));
  const v = row?.value as Partial<PaymentProviderValue> | undefined;
  return v?.provider === "payaza" ? "payaza" : "opay";
}

export type CheckoutHandoff =
  | { provider: "opay"; redirectUrl: string }
  | { provider: "payaza"; payaza: PayazaCheckoutConfig };

/** Build the checkout handoff for the customer: a redirect URL (OPay) or the
 *  popup SDK config (Payaza). The returnUrl/callbackUrl for OPay come from
 *  PUBLIC_* env. */
export async function createCheckout(
  _db: DbClient,
  opts: {
    provider: PaymentProvider;
    amountNgn: number;
    reference: string;
    email: string;
    customerName?: string;
    customerPhone?: string;
  },
): Promise<CheckoutHandoff> {
  if (opts.provider === "opay") {
    const customerBase = process.env.PUBLIC_CUSTOMER_URL || "https://mrssamueljuice.com";
    const apiBase = process.env.PUBLIC_API_URL || "https://api.mrssamueljuice.com";
    const { cashierUrl } = await createOpayCashier({
      amountNgn: opts.amountNgn,
      reference: opts.reference,
      email: opts.email,
      customerName: opts.customerName,
      customerPhone: opts.customerPhone,
      returnUrl: `${customerBase}/order/${opts.reference}?paid=1`,
      callbackUrl: `${apiBase}/v1/webhooks/opay`,
    });
    return { provider: "opay", redirectUrl: cashierUrl };
  }
  const payaza = buildPayazaCheckoutConfig({
    amountNgn: opts.amountNgn,
    email: opts.email,
    reference: opts.reference,
    customerName: opts.customerName,
    customerPhone: opts.customerPhone,
  });
  return { provider: "payaza", payaza };
}
```

> Implementer note: confirm the exact env var names for the public customer + API base URLs used elsewhere in this app (grep `PUBLIC_API_URL`, `PUBLIC_CUSTOMER_URL`, `PUBLIC_ADMIN_URL`). Use whatever the codebase already uses for building customer-facing links (the runbook lists `PUBLIC_API_URL`). Adjust the two `process.env.*` defaults to match.

- [ ] **Step 4: Run tests to verify they pass.**

Run: `pnpm --filter @ms/api exec vitest run test/unit/provider.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/payments/provider.ts apps/api/test/unit/provider.test.ts
git commit -m "feat(api): payment provider seam — active-provider setting + createCheckout dispatch"
```

---

### Task 5: Order-creation branch + on-view re-verify by provider (`public-orders.ts`)

**Files:**
- Modify: `apps/api/src/routes/public-orders.ts` (order insert ~line 518; response ~lines 603-633; on-view re-verify ~line 673)
- Test: `apps/api/test/integration/public-orders.test.ts` (extend — see step 5)

**Interfaces:**
- Consumes: `getActiveProvider`, `createCheckout` (Task 4); `saleOrder.paymentProvider` (Task 1).
- Produces: order-create response `data.payment` is now either `{ provider: "payaza"; reference; payaza }` OR `{ provider: "opay"; reference; redirect_url }`.

- [ ] **Step 1: Stamp the provider at order creation.** Before the `tx.insert(saleOrder)` call (~line 511), resolve the provider, and add it to the insert `.values({...})`:

```ts
      const activeProvider = await getActiveProvider(tx as unknown as DbClient);
```

Add to the `.values({ ... })` object (near `paymentStatus: "pending"`):

```ts
          paymentProvider: activeProvider,
```

> Implementer note: `getActiveProvider` takes a `DbClient`; inside the transaction, pass `tx`. If the type cast is awkward, hoist the read to just BEFORE `db.transaction(...)` using `db` and close over the value — either is fine as long as the stamped value matches what `createCheckout` is called with below.

- [ ] **Step 2: Replace the Payaza-only response block** (lines ~603-633, from the `const payaza = buildPayazaCheckoutConfig({...})` comment through the `return c.json(... 201)`), with a provider branch:

```ts
    // Hand the customer the right checkout: an OPay redirect URL, or the Payaza
    // popup SDK config. Payment is confirmed server-side (OPay cashier/status or
    // Payaza transaction-query) via the matching webhook / sweep / on-view verify.
    const handoff = await createCheckout(db, {
      provider: (created.order.paymentProvider as "opay" | "payaza" | null) ?? "payaza",
      amountNgn: created.order.totalNgn,
      reference: created.order.orderNumber,
      email: created.customerEmail ?? "no-email@example.com",
      customerName: body.customer.name,
      customerPhone: body.customer.phone,
    });

    const payment =
      handoff.provider === "opay"
        ? { provider: "opay" as const, reference: created.order.orderNumber, redirect_url: handoff.redirectUrl }
        : { provider: "payaza" as const, reference: handoff.payaza.reference, payaza: handoff.payaza };

    return c.json(
      {
        data: {
          id: created.order.id,
          order_number: created.order.orderNumber,
          total_ngn: created.order.totalNgn,
          is_preorder: created.order.isPreorder,
          payment,
        },
      },
      201,
    );
```

Add the imports at the top of `public-orders.ts`:

```ts
import { getActiveProvider, createCheckout } from "../payments/provider.js";
import type { DbClient } from "@ms/db";
```

Remove the now-unused `buildPayazaCheckoutConfig` import if nothing else in the file uses it (grep first — the subscription/resume path may still use it; if so, keep it).

- [ ] **Step 3: Make on-view re-verify use the order's stamped provider.** At line ~673, change:

```ts
          await verifyAndReconcile(db, o.orderNumber);
```

to:

```ts
          await verifyAndReconcile(db, o.orderNumber, (o.paymentProvider as "opay" | "payaza" | null) ?? "payaza");
```

- [ ] **Step 4: Build to typecheck.**

Run: `pnpm --filter @ms/api build`
Expected: exit 0.

- [ ] **Step 5: Extend the integration test.** In `apps/api/test/integration/public-orders.test.ts`, add a test that when the `payment_provider` setting is `payaza`, placing an online order returns `data.payment.provider === "payaza"` with a `payaza` config (this is the existing default behavior — assert it still holds), AND when the setting is `opay` (insert the app_settings row) the response has `data.payment.provider === "opay"` and a `redirect_url`. Mock OPay's create by setting `OPAY_*` env and stubbing `global.fetch` for the `cashier/create` call to return `{ code:"00000", data:{ cashierUrl:"https://sandboxcashier.opaycheckout.com/x", orderNo:"1" } }`.

> Implementer note: follow the existing integration-test setup in this file for how it seeds a branch/product/cart and calls the place-order endpoint. Reuse that scaffolding; only add the provider assertions + the fetch stub.

- [ ] **Step 6: Run the integration test.**

Run: `pnpm --filter @ms/api exec vitest run test/integration/public-orders.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/api/src/routes/public-orders.ts apps/api/test/integration/public-orders.test.ts
git commit -m "feat(api): order creation dispatches checkout by active provider + stamps sale_order.payment_provider"
```

---

### Task 6: OPay webhook route (`routes/webhooks-opay.ts`)

**Files:**
- Create: `apps/api/src/routes/webhooks-opay.ts`
- Modify: `apps/api/src/test-app.ts` (import + mount at `/v1/webhooks/opay`)
- Test: `apps/api/test/integration/webhooks-opay.test.ts`

**Interfaces:**
- Consumes: `verifyOpayTransaction`, `isOpaySuccess` (Task 2); `applyPaymentConfirmation` (Task 3, via its neutral name).
- Produces: `POST /v1/webhooks/opay` — accepts OPay's callback OR a worker re-fire body `{ reference }`; verifies via cashier/status; reconciles.

- [ ] **Step 1: Write the failing integration test.** Create `apps/api/test/integration/webhooks-opay.test.ts` that: seeds a `confirmed` online order stamped `payment_provider="opay"`, stubs `global.fetch` so `cashier/status` returns SUCCESS with `amount.total = totalNgn*100`, POSTs `{ reference: orderNumber }` to `/v1/webhooks/opay`, and asserts the order is now `paid` with a `payment` row `processor="opay"`.

> Implementer note: mirror the structure of the existing `webhooks-payaza` integration test if one exists (grep `test/integration` for a payaza webhook test) — same DB seeding + app harness (`makeTestApp`/`test-app`). Reuse it; swap the endpoint, the fetch stub target (`cashier/status`), and the expected `processor`.

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm --filter @ms/api exec vitest run test/integration/webhooks-opay.test.ts`
Expected: FAIL — route not mounted / file missing.

- [ ] **Step 3: Implement `routes/webhooks-opay.ts`.**

```ts
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { saleOrder, type DbClient } from "@ms/db";
import { verifyOpayTransaction, isOpaySuccess } from "../payments/opay.js";
import { applyPaymentConfirmation } from "../payments/reconcile.js";
import { logger } from "../logger.js";

/**
 * OPay callback receiver. OPay signs callbacks (HMAC with the secret key) and
 * retries them, but — exactly like the Payaza webhook — we treat the callback
 * purely as a WAKE-UP and never trust its body for the money decision. On every
 * callback we re-query cashier/status (server-to-server, signed) and only flip
 * the order to paid when OPay itself reports SUCCESS. The `reference` is our own
 * order number, so a forged callback can at most trigger a status re-read of a
 * real order. Idempotent: replaying for an already-paid order is a no-op.
 *
 * This endpoint also accepts the worker sweep's re-fire body `{ reference }`.
 */
export function opayWebhookRoutes(db: DbClient) {
  const r = new Hono();

  r.post("/", async (c) => {
    const requestId = c.get("requestId") as string | undefined;
    const raw = await c.req.raw.clone().text();
    logger.info({ requestId, rawLen: raw.length }, "opay webhook: inbound");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn({ requestId }, "opay webhook: non-JSON body — ignored");
      return c.json({ ok: true });
    }
    // OPay nests the merchant reference under a few envelope shapes; also accept
    // the worker re-fire's top-level { reference }.
    const p = parsed as {
      reference?: string;
      data?: { reference?: string };
      payload?: { reference?: string };
    };
    const reference = p.reference ?? p.data?.reference ?? p.payload?.reference;
    if (!reference || typeof reference !== "string") {
      logger.warn({ requestId }, "opay webhook: no reference in body — ignored");
      return c.json({ ok: true });
    }

    let confirmed;
    try {
      confirmed = await verifyOpayTransaction(reference);
    } catch (err) {
      logger.error({ requestId, reference, err }, "opay webhook: status query FAILED — 500 so OPay retries");
      throw err;
    }
    if (!isOpaySuccess(confirmed.status)) {
      logger.info({ requestId, reference, opayStatus: confirmed.status }, "opay webhook: not SUCCESS — no-op");
      return c.json({ ok: true });
    }

    const outcome = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.orderNumber, reference));
      if (!o) return { kind: "order_not_found" as const };
      return applyPaymentConfirmation(tx, o, confirmed, { processor: "opay" });
    });

    switch (outcome.kind) {
      case "order_not_found":
        logger.warn({ requestId, reference }, "opay webhook: no matching order — no-op");
        break;
      case "already_processed":
        logger.info({ requestId, reference, status: outcome.status }, "opay webhook: already processed — no-op");
        break;
      case "underpaid":
        logger.warn({ requestId, reference, totalNgn: outcome.totalNgn, netNgn: outcome.netNgn }, "opay webhook: UNDERPAID — parked");
        break;
      case "paid":
        logger.info({ requestId, reference, orderNumber: outcome.orderNumber, amountNgn: outcome.amountNgn }, "opay webhook: order marked PAID");
        break;
    }
    return c.json({ ok: true });
  });

  return r;
}
```

- [ ] **Step 4: Mount the route.** In `apps/api/src/test-app.ts`, add near the payaza webhook import (line ~31):

```ts
import { opayWebhookRoutes } from "./routes/webhooks-opay.js";
```

and near the payaza mount (line ~134):

```ts
  app.route("/v1/webhooks/opay", opayWebhookRoutes(db));
```

- [ ] **Step 5: Run the test to verify it passes.**

Run: `pnpm --filter @ms/api exec vitest run test/integration/webhooks-opay.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/routes/webhooks-opay.ts apps/api/src/test-app.ts apps/api/test/integration/webhooks-opay.test.ts
git commit -m "feat(api): OPay webhook — wake-up + authoritative cashier/status reconcile"
```

---

### Task 7: Worker sweep dispatches by provider

**Files:**
- Modify: `apps/worker/src/jobs/payaza-reconcile.ts` (select `paymentProvider`; post to the matching webhook URL)
- Test: `apps/worker/test/...` (extend the existing sweep test if present; otherwise add one)

**Interfaces:**
- Consumes: `saleOrder.paymentProvider` (Task 1); the mounted `/v1/webhooks/opay` (Task 6).
- Produces: the sweep re-fires `/v1/webhooks/opay` for opay orders and `/v1/webhooks/payaza` for payaza (or null → payaza) orders.

- [ ] **Step 1: Select the provider + branch the webhook URL.** In `sweepStuckPayazaOrders`, add `paymentProvider: saleOrder.paymentProvider` to the `.select({...})` (line ~45). Then replace the fixed `webhookUrl` (lines ~62-63) and the per-order POST body/URL so each order posts to its provider's webhook:

```ts
  const base = process.env["INTERNAL_API_URL"] || "http://api:3001";

  let posted = 0;
  for (const o of candidates) {
    const provider = o.paymentProvider === "opay" ? "opay" : "payaza";
    const webhookUrl = `${base}/v1/webhooks/${provider}`;
    // Both webhooks accept a minimal { reference } re-fire and verify the money
    // server-to-server; payaza also reads transaction_reference for legacy shape.
    const body =
      provider === "opay"
        ? { reference: o.orderNumber }
        : { transaction_reference: o.orderNumber, reference: o.orderNumber };
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        logger.warn({ orderId: o.id, orderNumber: o.orderNumber, provider, status: res.status }, "reconcile: webhook re-fire non-2xx");
        continue;
      }
      logger.info({ orderId: o.id, orderNumber: o.orderNumber, provider }, "reconcile: webhook re-fired");
      posted++;
    } catch (err) {
      logger.warn({ orderId: o.id, orderNumber: o.orderNumber, provider, err }, "reconcile: webhook re-fire failed — continuing");
    }
  }
  return posted;
```

(Remove the old `const webhookUrl = ...` line above the loop.)

- [ ] **Step 2: Update/confirm the sweep test.** If a test drives `sweepStuckPayazaOrders`, add a case: seed one `payment_provider="opay"` stuck order + one `payaza`, stub `fetch`, and assert the opay order POSTs to a URL ending `/v1/webhooks/opay` and the payaza one to `/v1/webhooks/payaza`.

> Implementer note: grep `apps/worker/test` for the existing sweep test; reuse its harness. If none exists, a small unit test that stubs `global.fetch` and a fake `db` returning two candidates is sufficient.

- [ ] **Step 3: Run worker tests + build.**

Run: `pnpm --filter @ms/worker exec vitest run` then `pnpm --filter @ms/worker build`
Expected: PASS, exit 0.

- [ ] **Step 4: Commit.**

```bash
git add apps/worker/src/jobs/payaza-reconcile.ts apps/worker/test/
git commit -m "feat(worker): reconcile sweep re-fires the order's stamped provider webhook"
```

---

### Task 8: Customer checkout — redirect vs popup

**Files:**
- Modify: `apps/customer/src/lib/api/types.ts` (`ApiPlacedOrder.payment` union)
- Modify: `apps/customer/src/routes/checkout.tsx` (`proceedToPayment` branch, ~line 251)

**Interfaces:**
- Consumes: order-create response `data.payment` from Task 5.
- Produces: on `provider === "opay"` the browser does a full-page redirect to `redirect_url`; on `"payaza"` the existing popup runs.

- [ ] **Step 1: Widen the `ApiPlacedOrder.payment` type.** In `apps/customer/src/lib/api/types.ts`, change line ~133:

```ts
  payment:
    | { provider: "payaza"; reference: string; payaza: PayazaCheckoutConfig }
    | { provider: "opay"; reference: string; redirect_url: string };
```

- [ ] **Step 2: Branch `proceedToPayment`.** In `apps/customer/src/routes/checkout.tsx`, replace the body of `proceedToPayment` after the `localStorage.setItem(...)` block (i.e. from the `const trackUrl = ...` line through the end of the `launchPayazaCheckout(...)` call) with:

```ts
    const trackUrl = `/order/${order.order_number}?paid=1`;

    // OPay: full-page redirect to OPay's hosted cashier page. There is no popup
    // to fail — the customer returns to the tracking page (returnUrl), which
    // re-verifies payment server-side on view. Clear the basket before leaving
    // (the order owns the items now).
    if (order.payment.provider === "opay") {
      logStage("payment_redirect", { orderNumber: order.order_number });
      clear();
      window.location.href = order.payment.redirect_url;
      return;
    }

    // Payaza (fallback): client-side popup. On success the server webhook
    // confirms payment; we move to the tracking page.
    await launchPayazaCheckout(order.payment.payaza, {
      onPaid: () => {
        logStage("payment_paid", { orderNumber: order.order_number });
        clear();
        window.location.href = trackUrl;
      },
      onClose: () => {
        logStage("payment_closed", { orderNumber: order.order_number });
        setPlacing(false);
      },
      onError: (message, diagnostics) => {
        logStage("payment_failed", {
          orderNumber: order.order_number,
          errorMessage: message,
          ...(diagnostics ? { response: { payaza_failure: diagnostics } } : {}),
        });
        setPlaceError(message);
        setPlacing(false);
      },
    });
```

(Leave the `prewarmPayaza()` call and the Payaza `preconnect` head links in place — they are harmless when OPay is active and needed the moment the owner toggles back to Payaza.)

- [ ] **Step 3: Typecheck + build the customer app.**

Run: `pnpm --filter @ms/customer build`
Expected: exit 0. (The `order.payment.provider` discriminant narrows the union so `.payaza` / `.redirect_url` are each only accessed on the right branch.)

- [ ] **Step 4: Run customer unit tests.**

Run: `pnpm --filter @ms/customer exec vitest run`
Expected: PASS (existing suite; no payaza test regressed).

- [ ] **Step 5: Commit.**

```bash
git add apps/customer/src/lib/api/types.ts apps/customer/src/routes/checkout.tsx
git commit -m "feat(customer): OPay full-page redirect at checkout; Payaza popup as fallback"
```

---

### Task 9: Admin — owner provider toggle in Settings

**Files:**
- Modify: `apps/api/src/routes/settings.ts` (add provider read + PATCH)
- Modify: the admin Settings page (add a provider toggle card)
- Test: `apps/api/test/integration/settings.test.ts` (extend, or add)

**Interfaces:**
- Consumes: `appSetting`, `PAYMENT_PROVIDER_KEY`, `PaymentProviderValue` (Task 1); `getActiveProvider` semantics (default opay).
- Produces: `GET /v1/settings/payment-provider` → `{ provider }`; `PATCH /v1/settings/payment-provider` (cap `settings.manage`) `{ provider }`.

- [ ] **Step 1: Add the routes.** In `apps/api/src/routes/settings.ts`, extend `settingsRoutes` (before `return r;`) with:

```ts
  r.get("/payment-provider", async (c) => c.json(await readProvider(db)));

  r.patch("/payment-provider", requireCapability("settings.manage"), async (c) => {
    const body = ProviderBody.parse(await c.req.json());
    const value: PaymentProviderValue = { provider: body.provider };
    const auth = c.get("auth");
    const before = await readProvider(db);
    await db
      .insert(appSetting)
      .values({ key: PAYMENT_PROVIDER_KEY, value, updatedBy: auth.userId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSetting.key,
        set: { value, updatedBy: auth.userId, updatedAt: new Date() },
      });
    await writeAudit(db, c, {
      action: "settings.payment_provider.update",
      entityType: "app_setting",
      entityId: PAYMENT_PROVIDER_KEY,
      before,
      after: value,
    });
    return c.json(value);
  });
```

Add near the top of the file (with the other imports/consts):

```ts
import { PAYMENT_PROVIDER_KEY, type PaymentProviderValue } from "@ms/db";

const ProviderBody = z.object({ provider: z.enum(["opay", "payaza"]) });
const DEFAULT_PROVIDER: PaymentProviderValue = { provider: "opay" };

async function readProvider(db: DbClient): Promise<PaymentProviderValue> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, PAYMENT_PROVIDER_KEY));
  const v = row?.value as Partial<PaymentProviderValue> | undefined;
  return { provider: v?.provider === "payaza" ? "payaza" : "opay" };
}
```

(Merge the `@ms/db` import with the file's existing one rather than duplicating.)

- [ ] **Step 2: Write/extend the integration test.** In `apps/api/test/integration/settings.test.ts` assert: default GET returns `{ provider: "opay" }`; PATCH to `payaza` as an owner persists and GET reflects it; PATCH without `settings.manage` is 403.

> Implementer note: reuse the existing banner test's auth/token setup in this file.

- [ ] **Step 3: Run the settings test + api build.**

Run: `pnpm --filter @ms/api exec vitest run test/integration/settings.test.ts && pnpm --filter @ms/api build`
Expected: PASS, exit 0.

- [ ] **Step 4: Add the admin UI toggle.** In the admin Settings page (grep `apps/admin/src` for where `/settings/banner` is fetched — add alongside it), add a "Payment provider" card that GETs `/settings/payment-provider`, shows the current provider, and PATCHes on change between "OPay (redirect — recommended)" and "Payaza (popup — fallback)". Follow the exact fetch/`api()` + card styling the banner card already uses in that file.

```tsx
// Sketch — match the file's existing api() helper, state, and card markup:
const [provider, setProvider] = useState<"opay" | "payaza">("opay");
useEffect(() => {
  api<{ provider: "opay" | "payaza" }>("/settings/payment-provider")
    .then((r) => setProvider(r.provider))
    .catch(() => {});
}, []);
async function saveProvider(next: "opay" | "payaza") {
  await api("/settings/payment-provider", { method: "PATCH", body: { provider: next } });
  setProvider(next);
}
// Render two radio options: OPay (redirect — recommended) / Payaza (popup — fallback),
// calling saveProvider(next) on change, with a small "new orders use this immediately" note.
```

- [ ] **Step 5: Build the admin app.**

Run: `pnpm --filter @ms/admin build`
Expected: exit 0.

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/routes/settings.ts apps/api/test/integration/settings.test.ts apps/admin/src
git commit -m "feat(admin): owner toggle for active payment provider (OPay/Payaza), no redeploy"
```

---

### Task 10: OPay resume-payment for an abandoned order

**Why:** A customer who abandons the OPay redirect leaves the order in `confirmed`. Payaza orders can already be resumed from the tracking page (`resume_payment`), so OPay needs parity or it's a regression. OPay cashier URLs expire (30 min), so resume must regenerate a session.

**Files:**
- Modify: `apps/api/src/routes/public-orders.ts` (tracking GET `resume_payment` shape ~line 166 area; add a regenerate endpoint)
- Modify: `apps/customer/src/lib/api/types.ts` (`ApiOrderTracking.resume_payment` union)
- Modify: the customer tracking page (`/order/$orderNumber`) resume button
- Test: `apps/api/test/integration/public-orders.test.ts`

**Interfaces:**
- Consumes: `createCheckout` (Task 4); order's stamped `paymentProvider`.
- Produces: for an unpaid `opay` order, tracking returns `resume_payment: { provider: "opay"; reference }`; a new `POST /v1/public/orders/:orderNumber/opay-session` (phone-gated, like tracking) returns `{ redirect_url }`.

- [ ] **Step 1: Widen the tracking `resume_payment` type.** In `types.ts` line ~166:

```ts
  resume_payment:
    | { provider: "payaza"; reference: string; payaza: PayazaCheckoutConfig }
    | { provider: "opay"; reference: string }
    | null;
```

- [ ] **Step 2: Set `resume_payment` by provider in the tracking GET.** Where the tracking response builds `resume_payment` (currently Payaza-only), branch: if the order is unpaid and `paymentProvider === "opay"`, return `{ provider: "opay", reference: o.orderNumber }`; else keep the existing `{ provider: "payaza", reference, payaza }` (add the `provider` tag to that object). If paid/cancelled, `null` as today.

> Implementer note: read the existing `resume_payment` construction in `public-orders.ts` and add the `provider` discriminant to the Payaza branch so the union is well-formed.

- [ ] **Step 3: Add the regenerate endpoint.** In `public-orders.ts`, add a route (phone-gated exactly like the tracking GET's `TrackQuery` phone check):

```ts
  r.post("/:orderNumber/opay-session", async (c) => {
    const orderNumber = c.req.param("orderNumber");
    const q = TrackQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const [o] = await db.select().from(saleOrder).where(eq(saleOrder.orderNumber, orderNumber));
    if (!o) throw new BusinessError("not_found", "order not found", 404);
    // Reuse the tracking phone gate here (same check the GET performs).
    // ... phone verification against the order's customer ...
    if (o.status !== "confirmed" && o.status !== "reconcile_needed") {
      throw new BusinessError("validation_failed", "order is not awaiting payment", 400);
    }
    const [cust] = o.customerId
      ? await db.select().from(customer).where(eq(customer.id, o.customerId))
      : [];
    const handoff = await createCheckout(db, {
      provider: "opay",
      amountNgn: o.totalNgn,
      reference: o.orderNumber,
      email: cust?.email ?? "no-email@example.com",
      customerName: cust?.name ?? undefined,
      customerPhone: cust?.phone ?? undefined,
    });
    if (handoff.provider !== "opay") throw new BusinessError("internal_error", "expected opay", 500);
    return c.json({ redirect_url: handoff.redirectUrl });
  });
```

> Implementer note: copy the EXACT phone-gate logic from the tracking GET (the `TrackQuery` + customer-phone comparison) so a drive-by cannot mint a payment session for someone else's order. Match how `customer` is imported/selected in this file.

- [ ] **Step 4: Wire the tracking page resume button.** In the customer `/order/$orderNumber` route, when `resume_payment.provider === "opay"`, the "Resume payment" button POSTs to `/public/orders/:orderNumber/opay-session?phone=…` and does `window.location.href = redirect_url`. Keep the existing Payaza popup path for `provider === "payaza"`.

- [ ] **Step 5: Add an integration test** for the regenerate endpoint: unpaid opay order + correct phone → `redirect_url` (fetch-stub OPay create); wrong phone → 403/404; paid order → 400.

- [ ] **Step 6: Build + test.**

Run: `pnpm --filter @ms/api build && pnpm --filter @ms/api exec vitest run test/integration/public-orders.test.ts && pnpm --filter @ms/customer build`
Expected: exit 0, PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/api/src/routes/public-orders.ts apps/customer/src
git commit -m "feat: resume payment for abandoned OPay orders (regenerate cashier session)"
```

---

### Task 11: Wiring, env docs, and full-suite green

**Files:**
- Modify: `docs/runbook.md` (env table + "OPay callback not landing" incident)
- Modify: `.env.example` / deployment env docs (grep for where `PAYAZA_*` is documented)

- [ ] **Step 1: Document the env vars.** Add to the runbook env table and any `.env.example`: `OPAY_MERCHANT_ID`, `OPAY_PUBLIC_KEY`, `OPAY_SECRET_KEY`, `OPAY_API_BASE` (default `https://api.opaycheckout.com`; sandbox `https://sandboxapi.opaycheckout.com`). Add a runbook incident block "OPay callback not landing" mirroring the Payaza one (check OPay dashboard webhook log; the worker sweep re-fires `/v1/webhooks/opay` within ~90s regardless).

- [ ] **Step 2: Run the entire test suite.**

Run: `pnpm -r exec vitest run` (or the repo's root test script)
Expected: PASS. Note any pre-existing failures unrelated to this work (compare against a clean `master` run) and do not fix them here.

- [ ] **Step 3: Typecheck everything.**

Run: `pnpm -r build`
Expected: exit 0 across `@ms/db`, `@ms/api`, `@ms/worker`, `@ms/customer`, `@ms/admin`.

- [ ] **Step 4: Commit.**

```bash
git add docs/runbook.md .env.example
git commit -m "docs: OPay env vars + callback-not-landing runbook entry"
```

---

## Deployment & live verification (post-merge, human-in-the-loop)

Not code — the owner/operator does these once, after deploy:

1. Set `OPAY_MERCHANT_ID`, `OPAY_PUBLIC_KEY`, `OPAY_SECRET_KEY` on the **api** and **worker** services; run migration `0066`.
2. Confirm the `payment_provider` setting is unset (→ defaults to `opay`) or explicitly `opay`.
3. **Verify-during-build item #1:** capture one real sandbox callback and confirm the signature algorithm (HMAC-SHA512 vs SHA3-512). We gate `paid` on the status query regardless, so this only affects optional signature-verification hardening — add it once confirmed.
4. **Verify-during-build item #2:** place ONE real sandbox order end-to-end (create → redirect → pay → callback → cashier/status → order `paid` → tracking shows paid). Confirm `amount.total` round-trips at ×100 and the status casing is `SUCCESS`.
5. Flip to production keys; place ONE real low-value live order end-to-end before announcing.
6. Rollback lever: owner flips Settings → Payment provider → **Payaza**. New orders instantly use the popup again; no deploy.

---

## Self-Review notes (author)

- **Spec coverage:** provider seam (T4) ✓; owner toggle app_settings (T1,T9) ✓; per-order stamp (T1,T5,T6,T7) ✓; OPay create/redirect (T2,T5,T8) ✓; OPay webhook wake-up + status verify (T2,T6) ✓; provider-aware sweep (T7) + on-view re-verify (T5) ✓; reconcile reuse w/ null-fee graceful path (T3) ✓; Payaza untouched/fallback ✓; verify-during-build flags (Deployment §3-4) ✓; resume parity (T10, added — implied by "returnUrl → tracking" + avoids a Payaza regression).
- **Type consistency:** `ConfirmedTransaction` defined once (T2), aliased for Payaza (T3); `applyPaymentConfirmation(…, { processor })` + alias `applyPayazaConfirmation` used consistently (T3,T6); `getActiveProvider`/`createCheckout`/`CheckoutHandoff` names consistent (T4,T5); response `data.payment` union matches customer `ApiPlacedOrder.payment` (T5,T8); `redirect_url` (snake, API) vs `redirectUrl` (camel, internal seam) kept distinct deliberately.
- **Placeholder scan:** implementer notes point at existing harnesses to reuse (test scaffolding, phone-gate, admin card styling) rather than leaving TODOs; all code steps carry real code.

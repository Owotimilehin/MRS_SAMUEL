# Checkout Attempt Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every "Place order" press and its full lifecycle (delivery details, error, response), viewable on an owner admin page, with a Telegram alert on failures and 30-day auto-prune.

**Architecture:** A new append-only `checkout_attempt_log` table. The customer checkout calls a TanStack server function `logCheckoutAttempt` (browser → SSR → API, matching `placeOrder`) at each stage; the API persists a row and, on failure stages, enqueues a `checkout.failed` outbox event for Telegram. An owner-only reports endpoint returns attempts grouped by `attempt_id`; a new admin page renders them. A daily worker job prunes rows older than 30 days.

**Tech Stack:** Drizzle ORM + Postgres, Hono (API), TanStack Start (customer SSR), React + admin `api()` helper, Vitest, existing `outbox_event` → worker → Telegram pipeline.

## Global Constraints

- Reuse the existing `rateLimit({ points, durationSeconds, keyPrefix })` middleware (`apps/api/src/middleware/rate-limit.ts`) — do NOT add a new rate limiter.
- The public write endpoint lives on the telemetry router (mounted at `/v1/public/telemetry`), matching the existing `POST /error` pattern: zod-validate, swallow malformed input, return `204`.
- The owner read endpoint lives on the reports router (`apps/api/src/routes/reports.ts`), already guarded by `requireAuth() + requireCapability("reports.view")`.
- Telegram is via `outbox_event` rows (`eventType` dotted namespace) drained by the worker `format()` switch in `apps/worker/src/outbox.ts`. No new transport.
- Logging must NEVER block or break checkout — every client log call is wrapped and its failure swallowed.
- No card/payment data is ever logged.
- Migration is `0061_checkout_attempt_log`; its `_journal.json` `when` MUST be strictly greater than `0060`'s (Drizzle silently skips a migration with a too-low timestamp — prior prod incident).
- Stages: `pressed | validation_failed | order_created | order_failed | payment_paid | payment_closed | payment_failed`. Statuses: `info | ok | error | abandoned`. Failure stages (`validation_failed`, `order_failed`, `payment_failed`) trigger Telegram.

---

## File Structure

- `packages/db/src/schema/checkout-attempt-log.ts` — table definition (create)
- `packages/db/src/schema/index.ts` — export the new table (modify)
- `packages/db/migrations/0061_checkout_attempt_log.sql` + `meta/_journal.json` (create/modify)
- `apps/api/src/lib/checkout-log.ts` — pure helpers: stage→status map, payload zod schema, status derivation (create)
- `apps/api/src/lib/checkout-log.test.ts` — unit tests for helpers (create)
- `apps/api/src/routes/telemetry.ts` — add `POST /checkout` (modify)
- `apps/api/src/routes/reports.ts` — add `GET /checkout-log` (modify)
- `apps/api/test/integration/checkout-log.test.ts` — endpoint tests (create)
- `apps/worker/src/outbox.ts` — add `case "checkout.failed"` to `format()` (modify)
- `apps/worker/src/jobs/prune-checkout-log.ts` — prune job (create)
- `apps/worker/src/jobs/prune-checkout-log.test.ts` — prune boundary test (create)
- `apps/worker/src/index.ts` — register prune job (modify)
- `apps/customer/src/lib/checkout-log.ts` — `buildCheckoutLogPayload` pure helper + `Stage` type (create)
- `apps/customer/src/lib/checkout-log.test.ts` — payload-builder tests (create)
- `apps/customer/src/lib/api/server-fns.ts` — add `logCheckoutAttempt` server fn (modify)
- `apps/customer/src/routes/checkout.tsx` — call the logger at each stage (modify)
- `apps/admin/src/routes/owner/checkout-log.tsx` — admin page (create)
- `apps/admin/src/...nav...` — add Nav link (modify; find existing owner nav)

---

## Task 1: Database table + migration

**Files:**
- Create: `packages/db/src/schema/checkout-attempt-log.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/migrations/0061_checkout_attempt_log.sql`
- Modify: `packages/db/migrations/meta/_journal.json`

**Interfaces:**
- Produces: `checkoutAttemptLog` table export with columns: `id, attemptId, stage, status, orderNumber, customerName, customerPhone, customerEmail, deliveryAddress, deliveryState, deliveryWindow, scheduledFor, itemsJson, totalNgn, errorMessage, responseJson, userAgent, ipAddress, createdAt`.

- [ ] **Step 1: Create the schema file**

```ts
// packages/db/src/schema/checkout-attempt-log.ts
import { pgTable, uuid, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";

/**
 * Append-only diagnostic log of customer checkout attempts. One row per stage
 * of a "Place order" press; rows of one press share `attemptId` (the checkout
 * idempotency key). Pruned after 30 days by the worker. Holds customer PII
 * (name/phone/email/address) — read access is owner-only. No payment/card data.
 */
export const checkoutAttemptLog = pgTable(
  "checkout_attempt_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: text("attempt_id").notNull(),
    stage: text("stage").notNull(),
    status: text("status").notNull(),
    orderNumber: text("order_number"),
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"),
    customerEmail: text("customer_email"),
    deliveryAddress: text("delivery_address"),
    deliveryState: text("delivery_state"),
    deliveryWindow: text("delivery_window"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    itemsJson: jsonb("items_json").$type<Array<Record<string, unknown>>>(),
    totalNgn: integer("total_ngn"),
    errorMessage: text("error_message"),
    responseJson: jsonb("response_json").$type<Record<string, unknown>>(),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxAttempt: index("idx_checkout_log_attempt").on(t.attemptId),
    idxCreated: index("idx_checkout_log_created").on(t.createdAt),
  }),
);
```

- [ ] **Step 2: Export it from the schema index**

Add to `packages/db/src/schema/index.ts`:
```ts
export * from "./checkout-attempt-log.js";
```

- [ ] **Step 3: Write the migration SQL**

```sql
-- packages/db/migrations/0061_checkout_attempt_log.sql
CREATE TABLE IF NOT EXISTS "checkout_attempt_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "attempt_id" text NOT NULL,
  "stage" text NOT NULL,
  "status" text NOT NULL,
  "order_number" text,
  "customer_name" text,
  "customer_phone" text,
  "customer_email" text,
  "delivery_address" text,
  "delivery_state" text,
  "delivery_window" text,
  "scheduled_for" timestamp with time zone,
  "items_json" jsonb,
  "total_ngn" integer,
  "error_message" text,
  "response_json" jsonb,
  "user_agent" text,
  "ip_address" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_checkout_log_attempt" ON "checkout_attempt_log" ("attempt_id");
CREATE INDEX IF NOT EXISTS "idx_checkout_log_created" ON "checkout_attempt_log" ("created_at");
```

- [ ] **Step 4: Add the journal entry**

Append to the `entries` array in `packages/db/migrations/meta/_journal.json`, with `idx` = previous+1, `tag` = `"0061_checkout_attempt_log"`, and `when` STRICTLY GREATER than the `0060` entry's `when` (copy `0060`'s value and add `10000`). Verify by reading the file.

- [ ] **Step 5: Verify it applies against a scratch DB**

Run (from repo root): `pnpm --filter @ms/db build` then apply migrations to the local/test DB per the repo's migrate script (`pnpm --filter @ms/db migrate` or the documented test-DB setup). Expected: no error; `checkout_attempt_log` exists.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/checkout-attempt-log.ts packages/db/src/schema/index.ts packages/db/migrations/0061_checkout_attempt_log.sql packages/db/migrations/meta/_journal.json
git commit -m "feat(db): checkout_attempt_log table (0061)"
```

---

## Task 2: API shared helpers (pure)

**Files:**
- Create: `apps/api/src/lib/checkout-log.ts`
- Create: `apps/api/src/lib/checkout-log.test.ts`

**Interfaces:**
- Produces:
  - `CHECKOUT_STAGES` (readonly tuple) and `type CheckoutStage`.
  - `statusForStage(stage: CheckoutStage): "info" | "ok" | "error" | "abandoned"`.
  - `isFailureStage(stage: CheckoutStage): boolean` (true for validation_failed/order_failed/payment_failed).
  - `checkoutLogSchema` (zod) for the request body.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/lib/checkout-log.test.ts
import { describe, it, expect } from "vitest";
import { statusForStage, isFailureStage, checkoutLogSchema } from "./checkout-log.js";

describe("statusForStage", () => {
  it("maps each stage to a status", () => {
    expect(statusForStage("pressed")).toBe("info");
    expect(statusForStage("order_created")).toBe("ok");
    expect(statusForStage("payment_paid")).toBe("ok");
    expect(statusForStage("payment_closed")).toBe("abandoned");
    expect(statusForStage("validation_failed")).toBe("error");
    expect(statusForStage("order_failed")).toBe("error");
    expect(statusForStage("payment_failed")).toBe("error");
  });
});

describe("isFailureStage", () => {
  it("is true only for failure stages", () => {
    expect(isFailureStage("validation_failed")).toBe(true);
    expect(isFailureStage("order_failed")).toBe(true);
    expect(isFailureStage("payment_failed")).toBe(true);
    expect(isFailureStage("pressed")).toBe(false);
    expect(isFailureStage("payment_paid")).toBe(false);
  });
});

describe("checkoutLogSchema", () => {
  it("accepts a valid payload", () => {
    const r = checkoutLogSchema.safeParse({
      attempt_id: "abc", stage: "pressed",
      customer: { name: "Ada", phone: "08000000000" },
      items: [{ variant_id: "v1", name: "Mango", size: "650ml", qty: 2 }],
      total_ngn: 5000,
    });
    expect(r.success).toBe(true);
  });
  it("rejects an unknown stage", () => {
    expect(checkoutLogSchema.safeParse({ attempt_id: "a", stage: "nope" }).success).toBe(false);
  });
  it("rejects oversized error_message", () => {
    expect(checkoutLogSchema.safeParse({ attempt_id: "a", stage: "order_failed", error_message: "x".repeat(1001) }).success).toBe(false);
  });
  it("rejects more than 50 items", () => {
    const items = Array.from({ length: 51 }, () => ({ variant_id: "v", name: "n", size: "650ml", qty: 1 }));
    expect(checkoutLogSchema.safeParse({ attempt_id: "a", stage: "pressed", items }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @ms/api exec vitest run src/lib/checkout-log.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the helpers**

```ts
// apps/api/src/lib/checkout-log.ts
import { z } from "zod";

export const CHECKOUT_STAGES = [
  "pressed", "validation_failed", "order_created", "order_failed",
  "payment_paid", "payment_closed", "payment_failed",
] as const;
export type CheckoutStage = (typeof CHECKOUT_STAGES)[number];

const STATUS_BY_STAGE: Record<CheckoutStage, "info" | "ok" | "error" | "abandoned"> = {
  pressed: "info",
  validation_failed: "error",
  order_created: "ok",
  order_failed: "error",
  payment_paid: "ok",
  payment_closed: "abandoned",
  payment_failed: "error",
};

export function statusForStage(stage: CheckoutStage) {
  return STATUS_BY_STAGE[stage];
}

const FAILURE_STAGES = new Set<CheckoutStage>(["validation_failed", "order_failed", "payment_failed"]);
export function isFailureStage(stage: CheckoutStage): boolean {
  return FAILURE_STAGES.has(stage);
}

const str = (max: number) => z.string().max(max);
export const checkoutLogSchema = z.object({
  attempt_id: str(100).min(1),
  stage: z.enum(CHECKOUT_STAGES),
  order_number: str(60).optional(),
  customer: z
    .object({
      name: str(200).optional(),
      phone: str(60).optional(),
      email: str(200).optional(),
      address: str(500).optional(),
      state: str(100).optional(),
    })
    .optional(),
  delivery_window: str(40).optional(),
  scheduled_for: str(60).optional(),
  items: z
    .array(z.object({ variant_id: str(60), name: str(200), size: str(40), qty: z.number().int() }))
    .max(50)
    .optional(),
  total_ngn: z.number().int().nonnegative().optional(),
  error_message: str(1000).optional(),
  response: z.record(z.unknown()).optional(),
});
export type CheckoutLogBody = z.infer<typeof checkoutLogSchema>;
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @ms/api exec vitest run src/lib/checkout-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/checkout-log.ts apps/api/src/lib/checkout-log.test.ts
git commit -m "feat(api): checkout-log helpers (stage/status/schema)"
```

---

## Task 3: API write endpoint `POST /v1/public/telemetry/checkout`

**Files:**
- Modify: `apps/api/src/routes/telemetry.ts`
- Create: `apps/api/test/integration/checkout-log.test.ts`

**Interfaces:**
- Consumes: `checkoutLogSchema`, `statusForStage`, `isFailureStage` (Task 2); `checkoutAttemptLog` (Task 1); `outboxEvent` (existing); `rateLimit` (existing).
- Produces: `POST /checkout` on the telemetry router (live at `/v1/public/telemetry/checkout`), returns `204`.

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/test/integration/checkout-log.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { checkoutAttemptLog, outboxEvent } from "@ms/db";
import { makeTestApp, resetDb, testDb } from "../helpers.js"; // match existing integration-test helpers

describe("POST /v1/public/telemetry/checkout", () => {
  beforeEach(async () => { await resetDb(); });

  it("persists a row for a valid press", async () => {
    const app = makeTestApp();
    const res = await app.request("/v1/public/telemetry/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attempt_id: "att-1", stage: "pressed",
        customer: { name: "Ada Okeke", phone: "08000000000", address: "1 Main St" },
        items: [{ variant_id: "v1", name: "Mango", size: "650ml", qty: 2 }],
        total_ngn: 5000,
      }),
    });
    expect(res.status).toBe(204);
    const rows = await testDb.select().from(checkoutAttemptLog).where(eq(checkoutAttemptLog.attemptId, "att-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe("pressed");
    expect(rows[0].status).toBe("info");
    expect(rows[0].customerName).toBe("Ada Okeke");
  });

  it("enqueues a checkout.failed outbox event on a failure stage", async () => {
    const app = makeTestApp();
    await app.request("/v1/public/telemetry/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt_id: "att-2", stage: "payment_failed", error_message: "popup blocked" }),
    });
    const events = await testDb.select().from(outboxEvent).where(eq(outboxEvent.eventType, "checkout.failed"));
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).attempt_id).toBe("att-2");
  });

  it("does NOT enqueue Telegram for a success stage", async () => {
    const app = makeTestApp();
    await app.request("/v1/public/telemetry/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt_id: "att-3", stage: "payment_paid" }),
    });
    const events = await testDb.select().from(outboxEvent).where(eq(outboxEvent.eventType, "checkout.failed"));
    expect(events).toHaveLength(0);
  });

  it("returns 204 and writes nothing for a malformed payload", async () => {
    const app = makeTestApp();
    const res = await app.request("/v1/public/telemetry/checkout", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "nope" }),
    });
    expect(res.status).toBe(204);
    const rows = await testDb.select().from(checkoutAttemptLog);
    expect(rows).toHaveLength(0);
  });
});
```

> NOTE for implementer: open an existing file under `apps/api/test/integration/` to copy the EXACT helper imports/setup (app construction, db reset). Replace the `../helpers.js` import above to match.

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @ms/api exec vitest run test/integration/checkout-log.test.ts`
Expected: FAIL (route 404 / not implemented).

- [ ] **Step 3: Implement the route in `telemetry.ts`**

Add imports at top:
```ts
import { checkoutAttemptLog, outboxEvent } from "@ms/db";
import { checkoutLogSchema, statusForStage, isFailureStage } from "../lib/checkout-log.js";
```
Add inside `telemetryRoutes`, after the existing `/error` route:
```ts
  // Diagnostic log of a customer checkout attempt (one row per stage). Public +
  // rate-limited; never errors back to the customer. On a failure stage it also
  // enqueues a Telegram alert via the outbox.
  r.post(
    "/checkout",
    rateLimit({ points: 60, durationSeconds: 300, keyPrefix: "checkout-log" }),
    async (c) => {
      try {
        const body = checkoutLogSchema.parse(await c.req.json());
        const status = statusForStage(body.stage);
        await db.insert(checkoutAttemptLog).values({
          attemptId: body.attempt_id,
          stage: body.stage,
          status,
          orderNumber: body.order_number ?? null,
          customerName: body.customer?.name ?? null,
          customerPhone: body.customer?.phone ?? null,
          customerEmail: body.customer?.email ?? null,
          deliveryAddress: body.customer?.address ?? null,
          deliveryState: body.customer?.state ?? null,
          deliveryWindow: body.delivery_window ?? null,
          scheduledFor: body.scheduled_for ? new Date(body.scheduled_for) : null,
          itemsJson: body.items ?? null,
          totalNgn: body.total_ngn ?? null,
          errorMessage: body.error_message ?? null,
          responseJson: body.response ?? null,
          userAgent: c.req.header("user-agent") ?? null,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        });
        if (isFailureStage(body.stage)) {
          await db.insert(outboxEvent).values({
            eventType: "checkout.failed",
            payload: {
              attempt_id: body.attempt_id,
              stage: body.stage,
              customer_name: body.customer?.name ?? null,
              customer_phone: body.customer?.phone ?? null,
              order_number: body.order_number ?? null,
              error_message: body.error_message ?? null,
            },
          });
        }
      } catch {
        /* swallow malformed/duplicate reports — logging must never 500 */
      }
      return c.body(null, 204);
    },
  );
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @ms/api exec vitest run test/integration/checkout-log.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/telemetry.ts apps/api/test/integration/checkout-log.test.ts
git commit -m "feat(api): POST /public/telemetry/checkout — persist attempt + Telegram on failure"
```

---

## Task 4: API read endpoint `GET /v1/reports/checkout-log` (owner-only)

**Files:**
- Modify: `apps/api/src/routes/reports.ts`
- Modify: `apps/api/test/integration/checkout-log.test.ts` (add read tests)

**Interfaces:**
- Consumes: `checkoutAttemptLog` (Task 1).
- Produces: `GET /checkout-log?limit&before` → `{ attempts: Array<{ attempt_id, started_at, customer, items, total_ngn, stages: Array<{ stage, status, error_message, order_number, response, created_at }> }>, next_before: string | null }`. Owner-only (router already requires `reports.view`).

- [ ] **Step 1: Write the failing test (append to the integration file)**

```ts
import { authedRequest } from "../helpers.js"; // match existing helper that attaches an owner session

describe("GET /v1/reports/checkout-log", () => {
  beforeEach(async () => { await resetDb(); });

  it("groups stage rows by attempt, newest attempt first, and requires auth", async () => {
    const app = makeTestApp();
    // seed two attempts via the public endpoint
    for (const [att, stage] of [["a1", "pressed"], ["a1", "order_created"], ["a2", "pressed"]] as const) {
      await app.request("/v1/public/telemetry/checkout", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ attempt_id: att, stage, customer: { name: att } }),
      });
    }
    const anon = await app.request("/v1/reports/checkout-log");
    expect([401, 403]).toContain(anon.status);

    const res = await authedRequest(app, "owner", "/v1/reports/checkout-log");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attempts[0].attempt_id).toBe("a2"); // newest first
    const a1 = body.attempts.find((a: any) => a.attempt_id === "a1");
    expect(a1.stages.map((s: any) => s.stage)).toEqual(["pressed", "order_created"]);
  });
});
```

> NOTE: match `authedRequest`/owner-session helper to whatever the existing integration tests use (grep the test dir).

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @ms/api exec vitest run test/integration/checkout-log.test.ts`
Expected: FAIL on the GET (404/route missing).

- [ ] **Step 3: Implement in `reports.ts`**

Add import:
```ts
import { checkoutAttemptLog } from "@ms/db";
import { desc, lt } from "drizzle-orm";
```
Add route (inside the router factory, alongside other `r.get`s):
```ts
  // Owner diagnostic: recent checkout attempts, grouped by attempt_id.
  r.get("/checkout-log", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const before = c.req.query("before");
    // Fetch a window of rows newest-first, then group in memory by attempt.
    const rows = await db
      .select()
      .from(checkoutAttemptLog)
      .where(before ? lt(checkoutAttemptLog.createdAt, new Date(before)) : undefined)
      .orderBy(desc(checkoutAttemptLog.createdAt))
      .limit(limit * 8); // over-fetch so a multi-stage attempt isn't split across pages
    const byAttempt = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byAttempt.get(row.attemptId) ?? [];
      list.push(row);
      byAttempt.set(row.attemptId, list);
    }
    const attempts = [...byAttempt.values()]
      .map((stageRows) => {
        const ordered = [...stageRows].sort((a, b) => +a.createdAt - +b.createdAt);
        const first = ordered[0];
        const withDetails = ordered.find((s) => s.customerName || s.deliveryAddress) ?? first;
        return {
          attempt_id: first.attemptId,
          started_at: first.createdAt,
          customer: {
            name: withDetails.customerName,
            phone: withDetails.customerPhone,
            email: withDetails.customerEmail,
            address: withDetails.deliveryAddress,
            state: withDetails.deliveryState,
          },
          items: withDetails.itemsJson ?? [],
          total_ngn: withDetails.totalNgn,
          stages: ordered.map((s) => ({
            stage: s.stage, status: s.status, error_message: s.errorMessage,
            order_number: s.orderNumber, response: s.responseJson, created_at: s.createdAt,
          })),
        };
      })
      .sort((a, b) => +new Date(b.started_at) - +new Date(a.started_at))
      .slice(0, limit);
    const nextBefore = attempts.length === limit ? attempts[attempts.length - 1].started_at : null;
    return c.json({ attempts, next_before: nextBefore });
  });
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @ms/api exec vitest run test/integration/checkout-log.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/reports.ts apps/api/test/integration/checkout-log.test.ts
git commit -m "feat(api): GET /reports/checkout-log — owner-only grouped attempts"
```

---

## Task 5: Worker — Telegram message + prune job

**Files:**
- Modify: `apps/worker/src/outbox.ts` (add `case "checkout.failed"` in `format()`)
- Create: `apps/worker/src/jobs/prune-checkout-log.ts`
- Create: `apps/worker/src/jobs/prune-checkout-log.test.ts`
- Modify: `apps/worker/src/index.ts` (register prune in the job loop)

**Interfaces:**
- Consumes: `checkoutAttemptLog` (Task 1); `runJob` (existing).
- Produces: `pruneCheckoutLog(db): Promise<number>` (returns rows deleted); `format()` handles `checkout.failed`.

- [ ] **Step 1: Write the failing prune test**

```ts
// apps/worker/src/jobs/prune-checkout-log.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { checkoutAttemptLog } from "@ms/db";
import { pruneCheckoutLog } from "./prune-checkout-log.js";
import { resetDb, testDb } from "../../test-helpers.js"; // match worker test helpers

describe("pruneCheckoutLog", () => {
  beforeEach(async () => { await resetDb(); });
  it("deletes rows older than 30 days and keeps newer ones", async () => {
    const old = new Date(Date.now() - 31 * 24 * 3600_000);
    const recent = new Date(Date.now() - 1 * 24 * 3600_000);
    await testDb.insert(checkoutAttemptLog).values([
      { attemptId: "old", stage: "pressed", status: "info", createdAt: old },
      { attemptId: "new", stage: "pressed", status: "info", createdAt: recent },
    ]);
    const deleted = await pruneCheckoutLog(testDb);
    expect(deleted).toBe(1);
    const remaining = await testDb.select().from(checkoutAttemptLog);
    expect(remaining.map((r) => r.attemptId)).toEqual(["new"]);
  });
});
```

> NOTE: match the worker's test-db helper import to existing worker tests.

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @ms/worker exec vitest run src/jobs/prune-checkout-log.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the prune job**

```ts
// apps/worker/src/jobs/prune-checkout-log.ts
import { lt } from "drizzle-orm";
import { checkoutAttemptLog, type DbClient } from "@ms/db";

const RETENTION_DAYS = 30;

/** Delete checkout-attempt-log rows older than the retention window. Returns the
 *  number of rows removed. */
export async function pruneCheckoutLog(db: DbClient): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600_000);
  const deleted = await db.delete(checkoutAttemptLog).where(lt(checkoutAttemptLog.createdAt, cutoff)).returning({ id: checkoutAttemptLog.id });
  return deleted.length;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @ms/worker exec vitest run src/jobs/prune-checkout-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `checkout.failed` Telegram formatter**

In `apps/worker/src/outbox.ts` `format()` switch, add a case (match the surrounding `FormattedMessage` return shape used by neighbours like `sale.online_placed`):
```ts
    case "checkout.failed": {
      const p = event.payload as {
        stage?: string; customer_name?: string; customer_phone?: string;
        order_number?: string; error_message?: string;
      };
      const who = p.customer_name || p.customer_phone || "a customer";
      const lines = [
        `⚠️ *Checkout problem* — ${p.stage ?? "unknown"}`,
        `${who}${p.customer_phone ? ` · ${p.customer_phone}` : ""}`,
        p.order_number ? `Order: ${p.order_number}` : null,
        p.error_message ? `Error: ${p.error_message}` : null,
      ].filter(Boolean);
      return { text: lines.join("\n") };
    }
```
> NOTE: if `FormattedMessage` requires more fields (e.g. a chat target), copy the exact shape from `sale.online_placed`.

- [ ] **Step 6: Register the prune job in the worker loop**

In `apps/worker/src/index.ts`, alongside the other `runJob(...)` calls in the periodic loop, add:
```ts
import { pruneCheckoutLog } from "./jobs/prune-checkout-log.js";
// ...inside the loop body, with the other jobs:
const prunedCheckout = await runJob(logger, "prune_checkout_log", () => pruneCheckoutLog(db));
```
(Run it on the existing cadence; daily-frequency is fine since deletes are idempotent.)

- [ ] **Step 7: Run worker build + tests**

Run: `pnpm --filter @ms/worker exec tsc --noEmit && pnpm --filter @ms/worker exec vitest run`
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/outbox.ts apps/worker/src/jobs/prune-checkout-log.ts apps/worker/src/jobs/prune-checkout-log.test.ts apps/worker/src/index.ts
git commit -m "feat(worker): checkout.failed Telegram + 30-day prune job"
```

---

## Task 6: Customer — payload builder + server fn + wiring

**Files:**
- Create: `apps/customer/src/lib/checkout-log.ts`
- Create: `apps/customer/src/lib/checkout-log.test.ts`
- Modify: `apps/customer/src/lib/api/server-fns.ts`
- Modify: `apps/customer/src/routes/checkout.tsx`

**Interfaces:**
- Produces:
  - `type CheckoutStage` (same 7 stages).
  - `buildCheckoutLogPayload(input): CheckoutLogPayload` — pure, shapes the body the server fn sends.
  - `logCheckoutAttempt` server fn (POSTs to `/v1/public/telemetry/checkout`).
- Consumes: `apiFetch` (existing in server-fns).

- [ ] **Step 1: Write the failing payload-builder test**

```ts
// apps/customer/src/lib/checkout-log.test.ts
import { describe, it, expect } from "vitest";
import { buildCheckoutLogPayload } from "./checkout-log";

const base = {
  attemptId: "att-1",
  form: { name: "Ada", phone: "0800 000 0000", email: "", address: "1 Main", state: "Lagos" },
  items: [{ variantId: "v1", name: "Mango", size: "650ml", qty: 2 }],
  total: 5000,
  deliveryWindow: "afternoon" as const,
};

describe("buildCheckoutLogPayload", () => {
  it("includes delivery details + items for a press", () => {
    const p = buildCheckoutLogPayload({ ...base, stage: "pressed" });
    expect(p.attempt_id).toBe("att-1");
    expect(p.stage).toBe("pressed");
    expect(p.customer).toEqual({ name: "Ada", phone: "08000000000", email: undefined, address: "1 Main", state: "Lagos" });
    expect(p.items).toEqual([{ variant_id: "v1", name: "Mango", size: "650ml", qty: 2 }]);
    expect(p.total_ngn).toBe(5000);
  });
  it("carries an error message and order number when given", () => {
    const p = buildCheckoutLogPayload({ ...base, stage: "payment_failed", errorMessage: "popup blocked", orderNumber: "SO-1" });
    expect(p.stage).toBe("payment_failed");
    expect(p.error_message).toBe("popup blocked");
    expect(p.order_number).toBe("SO-1");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @ms/customer exec vitest run src/lib/checkout-log.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the payload builder**

```ts
// apps/customer/src/lib/checkout-log.ts
export type CheckoutStage =
  | "pressed" | "validation_failed" | "order_created" | "order_failed"
  | "payment_paid" | "payment_closed" | "payment_failed";

export interface CheckoutLogPayload {
  attempt_id: string;
  stage: CheckoutStage;
  order_number?: string;
  customer?: { name?: string; phone?: string; email?: string; address?: string; state?: string };
  delivery_window?: string;
  items?: Array<{ variant_id: string; name: string; size: string; qty: number }>;
  total_ngn?: number;
  error_message?: string;
  response?: Record<string, unknown>;
}

interface BuildInput {
  attemptId: string;
  stage: CheckoutStage;
  form: { name: string; phone: string; email: string; address: string; state: string };
  items: Array<{ variantId: string; name: string; size: string; qty: number }>;
  total: number;
  deliveryWindow?: string;
  orderNumber?: string;
  errorMessage?: string;
  response?: Record<string, unknown>;
}

export function buildCheckoutLogPayload(i: BuildInput): CheckoutLogPayload {
  const phone = i.form.phone.replace(/[\s-]/g, "");
  return {
    attempt_id: i.attemptId,
    stage: i.stage,
    order_number: i.orderNumber,
    customer: {
      name: i.form.name.trim() || undefined,
      phone: phone || undefined,
      email: i.form.email.trim() || undefined,
      address: i.form.address.trim() || undefined,
      state: i.form.state || undefined,
    },
    delivery_window: i.deliveryWindow,
    items: i.items.map((it) => ({ variant_id: it.variantId, name: it.name, size: it.size, qty: it.qty })),
    total_ngn: i.total,
    error_message: i.errorMessage,
    response: i.response,
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @ms/customer exec vitest run src/lib/checkout-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the server fn**

In `apps/customer/src/lib/api/server-fns.ts`, mirroring `placeOrder`:
```ts
import type { CheckoutLogPayload } from "@/lib/checkout-log";

export const logCheckoutAttempt = createServerFn({ method: "POST" })
  .validator((d: CheckoutLogPayload) => d)
  .handler(async ({ data }) => {
    try {
      await apiFetch<void>("/v1/public/telemetry/checkout", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch {
      /* diagnostic logging must never break checkout */
    }
    return null;
  });
```

- [ ] **Step 6: Wire into `checkout.tsx`**

Add import:
```ts
import { logCheckoutAttempt } from "@/lib/api/server-fns";
import { buildCheckoutLogPayload, type CheckoutStage } from "@/lib/checkout-log";
```
Add a helper inside `Page` (uses current form/cart/idemRef):
```ts
  const logStage = (stage: CheckoutStage, extra?: { orderNumber?: string; errorMessage?: string; response?: Record<string, unknown> }) => {
    try {
      const payload = buildCheckoutLogPayload({
        attemptId: idemRef.current || "no-attempt",
        stage,
        form,
        items: items.map((it) => ({ variantId: it.variantId, name: it.product.name, size: it.size, qty: it.qty })),
        total,
        deliveryWindow: sched.fixedWindow ?? selectedWindow,
        ...extra,
      });
      void logCheckoutAttempt({ data: payload });
    } catch {
      /* never break checkout on logging */
    }
  };
```
Call sites in `submit()` / `proceedToPayment()`:
- In `submit`, after `if (missing.length > 0) { ... }` set-error block, BEFORE the early `return`: `logStage("validation_failed", { errorMessage: \`Please add ${list}.\` });`
- In `submit`, after `idemRef.current` is set and `setPlacing(true)`: `logStage("pressed");`
- After `placeOrderFn` resolves (got `res`), before `proceedToPayment(res)`: `logStage("order_created", { orderNumber: res.order_number, response: { id: res.id, total_ngn: res.total_ngn } });`
- In the `submit` catch, after computing `err`: `logStage("order_failed", { errorMessage: err ? err.message : "order failed" });`
- In `proceedToPayment` `onPaid`: `logStage("payment_paid", { orderNumber: order.order_number });` (fire before `clear()`/redirect)
- In `onClose`: `logStage("payment_closed", { orderNumber: order.order_number });`
- In `onError`: `logStage("payment_failed", { orderNumber: order.order_number, errorMessage: message });`

> Order detail for `pressed`: place the `logStage("pressed")` call right after `idemRef.current = crypto.randomUUID()` so the attempt id exists.

- [ ] **Step 7: Typecheck + tests**

Run: `pnpm --filter @ms/customer exec tsc --noEmit && pnpm --filter @ms/customer exec vitest run`
Expected: no errors in changed files; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/customer/src/lib/checkout-log.ts apps/customer/src/lib/checkout-log.test.ts apps/customer/src/lib/api/server-fns.ts apps/customer/src/routes/checkout.tsx
git commit -m "feat(customer): log every checkout stage via logCheckoutAttempt"
```

---

## Task 7: Admin — checkout-log page + Nav link

**Files:**
- Create: `apps/admin/src/routes/owner/checkout-log.tsx`
- Modify: owner Nav (grep for where `owner/closes` or `owner/variance` Nav links are defined; add a "Checkout log" link there)

**Interfaces:**
- Consumes: admin `api<T>()` helper; `GET /v1/reports/checkout-log`.

- [ ] **Step 1: Find the Nav + a reference owner page**

Run: `grep -rn "owner/variance\|owner/closes" apps/admin/src` to find (a) the Nav definition and (b) a simple owner page to copy structure/loader from.

- [ ] **Step 2: Create the page**

```tsx
// apps/admin/src/routes/owner/checkout-log.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api"; // match the actual import path used by other owner pages

type Stage = { stage: string; status: string; error_message: string | null; order_number: string | null; response: unknown; created_at: string };
type Attempt = {
  attempt_id: string; started_at: string;
  customer: { name: string | null; phone: string | null; email: string | null; address: string | null; state: string | null };
  items: Array<{ name?: string; size?: string; qty?: number }>; total_ngn: number | null; stages: Stage[];
};

export const Route = createFileRoute("/owner/checkout-log")({ component: Page });

const STATUS_COLOR: Record<string, string> = {
  ok: "text-green-600", error: "text-red-600", abandoned: "text-amber-600", info: "text-gray-500",
};

function Page() {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ attempts: Attempt[] }>("/v1/reports/checkout-log")
      .then((r) => setAttempts(r.attempts))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-6">Loading…</div>;
  if (error) return <div className="p-6 text-red-600">{error}</div>;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Checkout log</h1>
      <p className="text-sm text-gray-500">Every "Place order" press in the last 30 days.</p>
      {attempts.length === 0 && <p className="text-gray-500">No checkout attempts recorded yet.</p>}
      {attempts.map((a) => (
        <div key={a.attempt_id} className="rounded-xl border p-4">
          <div className="flex justify-between text-sm">
            <div className="font-semibold">{a.customer.name ?? "—"} {a.customer.phone ? `· ${a.customer.phone}` : ""}</div>
            <div className="text-gray-500">{new Date(a.started_at).toLocaleString("en-NG", { timeZone: "Africa/Lagos" })}</div>
          </div>
          {a.customer.address && <div className="text-sm text-gray-600">{a.customer.address}{a.customer.state ? `, ${a.customer.state}` : ""}</div>}
          {a.items?.length > 0 && (
            <div className="text-xs text-gray-500 mt-1">
              {a.items.map((it, i) => <span key={i}>{it.qty}× {it.name} {it.size}{i < a.items.length - 1 ? ", " : ""}</span>)}
              {a.total_ngn != null && <span> · ₦{a.total_ngn.toLocaleString()}</span>}
            </div>
          )}
          <ol className="mt-3 space-y-1">
            {a.stages.map((s, i) => (
              <li key={i} className="text-sm flex gap-2">
                <span className="text-gray-400 w-36 shrink-0">{new Date(s.created_at).toLocaleTimeString("en-NG", { timeZone: "Africa/Lagos" })}</span>
                <span className={`font-medium ${STATUS_COLOR[s.status] ?? ""}`}>{s.stage}</span>
                {s.order_number && <span className="text-gray-500">({s.order_number})</span>}
                {s.error_message && <span className="text-red-600">— {s.error_message}</span>}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
```
> NOTE: match the exact `api` import path + call signature used by `owner/variance.tsx`. Adjust class names to the admin "Juice Skin" if the simple Tailwind above clashes — visual polish only.

- [ ] **Step 3: Add the Nav link**

In the owner Nav list found in Step 1, add an entry to `/owner/checkout-log` labelled "Checkout log".

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @ms/admin exec tsc --noEmit && pnpm --filter @ms/admin build`
Expected: route compiles; bundle builds.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/routes/owner/checkout-log.tsx apps/admin/src/<nav-file>
git commit -m "feat(admin): owner checkout-log page + nav link"
```

---

## Task 8: Full verification + finish

- [ ] **Step 1: Run every affected package's tests + typecheck**

```bash
pnpm --filter @ms/db exec tsc --noEmit
pnpm --filter @ms/api exec vitest run && pnpm --filter @ms/api exec tsc --noEmit
pnpm --filter @ms/worker exec vitest run && pnpm --filter @ms/worker exec tsc --noEmit
pnpm --filter @ms/customer exec vitest run && pnpm --filter @ms/customer exec tsc --noEmit
pnpm --filter @ms/admin exec tsc --noEmit
```
Expected: all green (note any pre-existing failures vs. master baseline).

- [ ] **Step 2: Manual smoke (optional, recommended)**

Use the `verify`/`run` skill to load the customer app, press "Place order" with a single first name, and confirm rows appear via `GET /v1/reports/checkout-log` (or the admin page).

- [ ] **Step 3: Finish the branch**

Use `superpowers:finishing-a-development-branch` to merge to master (auto-deploys; migration `0061` applies) or open a PR, per the user's choice.

---

## Self-Review

- **Spec coverage:** table (T1), public write + Telegram-on-failure (T3), owner read (T4), worker Telegram message + 30-day prune (T5), client full-lifecycle logging (T6), admin page + nav (T7), retention/privacy (T1+T5), testing (each task). All spec sections covered.
- **Placeholder scan:** every code step has concrete code; the only deferred items are explicit "match existing helper import" NOTES where the exact test-helper/`api()` path must be read from the repo — unavoidable in an existing codebase, and each names exactly what to grep.
- **Type consistency:** `CheckoutStage` (7 stages) identical across API (`CHECKOUT_STAGES`) and customer (`CheckoutStage`); `buildCheckoutLogPayload` output keys match `checkoutLogSchema` (attempt_id, stage, customer.{name,phone,email,address,state}, delivery_window, items[].{variant_id,name,size,qty}, total_ngn, error_message, order_number, response); read endpoint shape matches the admin page's `Attempt`/`Stage` types.

# Shift Start: Opening Stock Count + Till Open-Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a branch worker file a full opening stock count at shift start (a record-only mirror of the existing shift-end close), hard-block her till's stock-sale path until she does, and make manager/admin preorder-only on the till.

**Architecture:** New isolated `shift_open` + `shift_open_stock_count` tables and a `/shift-open` API mirroring `/daily-close`, never writing inventory. A device-local Dexie marker (date-keyed, survives logout) unlocks the till offline; `/sync/pull` carries `opened_today` so a second device self-heals. A capability split (`pos.sell` for stock sales → owner+branch_staff; new `pos.preorder` → all roles) makes manager/admin preorder-only.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM + Postgres, Dexie/IndexedDB (offline till), React (admin PWA), Vitest, pnpm workspaces.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-19-shift-start-opening-count-design.md`.
- Build on branch `feat/till-preorder-and-bulk-stock` (current). Do NOT branch off master.
- Opening count is **record-only** — it must NEVER write a `stock_ledger` row or change on-hand.
- Gate keyed to the **Lagos business date** (UTC+1, no DST). Reuse the `+ 60*60*1000` shift used by `lagosPickupDate` / `LAGOS_TZ_OFFSET_MS`.
- New migration files MUST be added to `packages/db/migrations/meta/_journal.json` or migrate/tests skip them; rebuild `@ms/db` after schema edits (`pnpm --filter @ms/db build`).
- Capability source of truth is `packages/shared/src/permissions.ts`; gate with `requireCapability`/`requireAnyCapability`, never role strings (except the till UI's owner-exempt check, which reads `auth.role`).
- Quality gates before done: 0 lint errors, clean typecheck repo-wide, all suites green. Run a single API test file alone if the full suite hits testcontainer `beforeAll` timeouts (known flake, not a real failure).
- Existing tills need a PWA hard-refresh after deploy to pick up the new bundle.

---

### Task 1: Capability split in `@ms/shared`

**Files:**
- Modify: `packages/shared/src/permissions.ts`
- Test: `packages/shared/src/permissions.test.ts`

**Interfaces:**
- Produces: capability strings `"pos.preorder"`, `"shift_open.submit"`; `pos.sell` now held only by `owner` + `branch_staff`.

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/permissions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ROLE_DEFAULTS } from "./permissions.js";

describe("till sell-policy capability split", () => {
  it("pos.sell (stock-consuming) is owner + branch_staff only", () => {
    expect(ROLE_DEFAULTS.owner).toContain("pos.sell");
    expect(ROLE_DEFAULTS.branch_staff).toContain("pos.sell");
    expect(ROLE_DEFAULTS.admin).not.toContain("pos.sell");
    expect(ROLE_DEFAULTS.manager).not.toContain("pos.sell");
  });

  it("pos.preorder is granted to all four roles", () => {
    for (const role of ["owner", "admin", "manager", "branch_staff"] as const) {
      expect(ROLE_DEFAULTS[role]).toContain("pos.preorder");
    }
  });

  it("shift_open.submit is granted to the roles that can file counts", () => {
    for (const role of ["owner", "admin", "manager", "branch_staff"] as const) {
      expect(ROLE_DEFAULTS[role]).toContain("shift_open.submit");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/shared test -- permissions`
Expected: FAIL — `pos.preorder` / `shift_open.submit` not in CAPABILITIES; `admin` still contains `pos.sell`.

- [ ] **Step 3: Edit `permissions.ts`**

In the `CAPABILITIES` array (after `"pos.sell"`, line ~26) add the two new caps:

```typescript
  "pos.sell",
  "pos.preorder",
  "shift_open.submit",
```

In `ADMIN_CAPS`: **remove** the `"pos.sell"` line; add `"pos.preorder"` and `"shift_open.submit"`:

```typescript
  // Branch / POS: admins oversee the till — they create/fulfil preorders and
  // view sales, but DO NOT ring up stock-consuming walk-up sales (pos.sell is
  // branch_staff/owner only). They never deplete stock, so they're never gated
  // by the opening count.
  "pos.preorder",
  "shift_open.submit",
  "sales.view",
  "daily_close.submit",
  "returns.create",
  "stock.adjust",
  "orders.manage",
```

In `MANAGER_CAPS`: **remove** `"pos.sell"`; add `"pos.preorder"` and `"shift_open.submit"`:

```typescript
  "pos.preorder",
  "shift_open.submit",
  "sales.view",
  "daily_close.submit",
  "returns.create",
  "stock.read",
  "stock.adjust",
  "packaging.view",
```

Replace `BRANCH_STAFF_CAPS` to add the new caps (worker sells stock, files both counts):

```typescript
const BRANCH_STAFF_CAPS: Capability[] = [
  "pos.sell",
  "pos.preorder",
  "shift_open.submit",
  "sales.view",
  "transfers.receive",
];
```

Leave `owner: [...CAPABILITIES]` as-is — it picks up the new caps automatically.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/shared test -- permissions`
Expected: PASS (all suites in the file green).

- [ ] **Step 5: Rebuild shared + commit**

```bash
pnpm --filter @ms/shared build
git add packages/shared/src/permissions.ts packages/shared/src/permissions.test.ts
git commit -m "feat(rbac): split pos.sell (stock) from pos.preorder; add shift_open.submit"
```

---

### Task 2: Re-gate routes manager/admin still need (`pos.sell` → any-of `pos.preorder`)

**Files:**
- Modify: `apps/api/src/routes/sync.ts:40`
- Modify: `apps/api/src/routes/branch-preorders.ts:17,24`
- Test: `apps/api/test/integration/branch-preorders.test.ts` (extend if present, else add a focused case to the existing preorder test)

**Interfaces:**
- Consumes: `requireAnyCapability(...caps)` from `apps/api/src/middleware/auth.ts` (already exported).

- [ ] **Step 1: Write the failing test**

Add a test asserting a manager (who no longer has `pos.sell`) can still pull and list preorders. In the existing branch-preorders integration test file, add:

```typescript
it("manager (no pos.sell) can still list branch preorders", async () => {
  // seedAdmin / login helpers follow the file's existing pattern
  const managerCookie = await loginAs(app, "manager");
  const res = await app.request(`/v1/branches/${branchId}/preorders`, {
    headers: { cookie: managerCookie },
  });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/api test -- branch-preorders`
Expected: FAIL with 403 `missing capability: pos.sell`.

- [ ] **Step 3: Update the gates**

In `apps/api/src/routes/sync.ts`, line 15 import and line 40:

```typescript
import { requireAuth, requireAnyCapability } from "../middleware/auth.js";
// ...
  r.get("/pull", requireAnyCapability("pos.sell", "pos.preorder"), async (c) => {
```
(Remove the now-unused `requireCapability` import if nothing else uses it in the file.)

In `apps/api/src/routes/branch-preorders.ts`, swap both gates:

```typescript
import { requireAuth, requireAnyCapability } from "../middleware/auth.js";
// ...
  r.get("/", requireAnyCapability("pos.sell", "pos.preorder"), async (c) => {
// ...
  r.patch("/:id/fulfil", requireAnyCapability("pos.sell", "pos.preorder"), async (c) => {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/api test -- branch-preorders`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sync.ts apps/api/src/routes/branch-preorders.ts apps/api/test/integration/branch-preorders.test.ts
git commit -m "feat(api): sync pull + branch preorders accept pos.preorder (manager/admin)"
```

---

### Task 3: `shift_open` schema + migration

**Files:**
- Create: `packages/db/src/schema/shift-open.ts`
- Modify: `packages/db/src/schema/index.ts` (export the new tables)
- Create: `packages/db/migrations/00NN_shift_open.sql` (NN = next number after the highest existing migration)
- Modify: `packages/db/migrations/meta/_journal.json` (append the journal entry)

**Interfaces:**
- Produces: Drizzle tables `shiftOpen`, `shiftOpenStockCount` exported from `@ms/db`, with columns mirroring `daily-close.ts`.

- [ ] **Step 1: Create the schema file**

`packages/db/src/schema/shift-open.ts`:

```typescript
import { pgTable, uuid, integer, text, timestamp, date, unique } from "drizzle-orm/pg-core";
import { branch } from "./branch.js";
import { product } from "./product.js";
import { adminUser } from "./admin-user.js";

export const shiftOpen = pgTable(
  "shift_open",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: uuid("branch_id").notNull().references(() => branch.id),
    businessDate: date("business_date").notNull(),
    openedByUserId: uuid("opened_by_user_id").references(() => adminUser.id),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ branchDateUnique: unique().on(t.branchId, t.businessDate) }),
);

export const shiftOpenStockCount = pgTable("shift_open_stock_count", {
  id: uuid("id").primaryKey().defaultRandom(),
  shiftOpenId: uuid("shift_open_id")
    .notNull()
    .references(() => shiftOpen.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => product.id),
  systemQuantity: integer("system_quantity").notNull(),
  countedQuantity: integer("counted_quantity").notNull(),
  variance: integer("variance").notNull(),
  varianceReason: text("variance_reason"),
});
```

- [ ] **Step 2: Export from the schema barrel**

In `packages/db/src/schema/index.ts`, add alongside the other exports:

```typescript
export * from "./shift-open.js";
```

- [ ] **Step 3: Determine the next migration number**

Run: `ls packages/db/migrations/ | grep -E '^[0-9]{4}_' | sort | tail -1`
Use the next integer (zero-padded to 4) as `NN` below. (e.g. if highest is `0051_*`, create `0052_shift_open.sql`.)

- [ ] **Step 4: Write the migration SQL**

`packages/db/migrations/00NN_shift_open.sql`:

```sql
CREATE TABLE "shift_open" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "branch_id" uuid NOT NULL REFERENCES "branch"("id"),
  "business_date" date NOT NULL,
  "opened_by_user_id" uuid REFERENCES "admin_user"("id"),
  "opened_at" timestamptz,
  "notes" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "shift_open_branch_id_business_date_unique" UNIQUE("branch_id","business_date")
);

CREATE TABLE "shift_open_stock_count" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shift_open_id" uuid NOT NULL REFERENCES "shift_open"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "product"("id"),
  "system_quantity" integer NOT NULL,
  "counted_quantity" integer NOT NULL,
  "variance" integer NOT NULL,
  "variance_reason" text
);
```

- [ ] **Step 5: Append the journal entry**

Open `packages/db/migrations/meta/_journal.json`. Copy the LAST entry in the `entries` array as a template and append a new one with `idx` = previous idx + 1, a fresh `when` epoch-millis (`node -e "console.log(Date.now())"`), and `tag` = `"00NN_shift_open"` (matching the filename without `.sql`). Example shape:

```json
{ "idx": <prevIdx+1>, "version": "7", "when": <Date.now()>, "tag": "00NN_shift_open", "breakpoints": true }
```

- [ ] **Step 6: Rebuild @ms/db and apply the migration locally**

```bash
pnpm --filter @ms/db build
pnpm --filter @ms/db migrate
```
Expected: migration `00NN_shift_open` applies with no error; re-running migrate is a no-op.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/shift-open.ts packages/db/src/schema/index.ts packages/db/migrations/00NN_shift_open.sql packages/db/migrations/meta/_journal.json
git commit -m "feat(db): shift_open + shift_open_stock_count tables (migration 00NN)"
```

---

### Task 4: `/shift-open` API routes

**Files:**
- Create: `apps/api/src/routes/shift-open.ts`
- Modify: `apps/api/src/test-app.ts` (import + mount under `/v1/branches/:branchId/shift-open`)
- Test: `apps/api/test/integration/shift-open-flow.test.ts`

**Interfaces:**
- Consumes: `expectedStockForDay(db, branchId): Promise<Record<string, number>>` from `@ms/domain`; `enqueueOutbox(exec, c, eventType, payload)`; `writeAudit(db, c, {action, entityType, entityId, after})`; `shiftOpen`, `shiftOpenStockCount`, `adminUser` from `@ms/db`.
- Produces: `shiftOpenRoutes(db: DbClient)` Hono router; event type `"shift_open.submitted"` with payload `{ shift_open_id, branch_id, business_date, opened_by, variance_count }`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/integration/shift-open-flow.test.ts` (mirror `daily-close-flow.test.ts`'s harness/imports):

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
// reuse the same testcontainer + seed helpers daily-close-flow.test.ts uses
import { makeTestApp, seedBranchWithStock, loginAs } from "./helpers.js";

describe("shift-open flow", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  beforeAll(async () => { ctx = await makeTestApp(); });
  afterAll(async () => { await ctx.close(); });

  it("records an opening count without writing any stock ledger row", async () => {
    const { app, branchId, productId, cookie } = await seedBranchWithStock(ctx, { onHand: 10 });
    const before = await ctx.stockOnHand(branchId, productId);

    const res = await app.request(`/v1/branches/${branchId}/shift-open`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        business_date: "2026-06-19",
        stock_counts: [{ product_id: productId, counted_quantity: 8, variance_reason: "found short" }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeTruthy();

    // record-only: on-hand unchanged
    const after = await ctx.stockOnHand(branchId, productId);
    expect(after).toBe(before);

    // variance computed counted(8) - system(10) = -2
    const get = await (await app.request(`/v1/branches/${branchId}/shift-open?date=2026-06-19`, { headers: { cookie } })).json();
    const line = get.data.stock_counts.find((s: any) => s.productId === productId);
    expect(line.systemQuantity).toBe(10);
    expect(line.countedQuantity).toBe(8);
    expect(line.variance).toBe(-2);
  });

  it("rejects a varianced line with no reason", async () => {
    const { app, branchId, productId, cookie } = await seedBranchWithStock(ctx, { onHand: 5 });
    const res = await app.request(`/v1/branches/${branchId}/shift-open`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        business_date: "2026-06-19",
        stock_counts: [{ product_id: productId, counted_quantity: 3 }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("allows an empty count (empty catalog cannot deadlock the gate)", async () => {
    const { app, branchId, cookie } = await seedBranchWithStock(ctx, { onHand: 0, noProducts: true });
    const res = await app.request(`/v1/branches/${branchId}/shift-open`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ business_date: "2026-06-19", stock_counts: [] }),
    });
    expect(res.status).toBe(201);
  });
});
```

(If `helpers.js` doesn't expose `seedBranchWithStock`/`stockOnHand`, follow exactly how `daily-close-flow.test.ts` seeds a branch + ledger and reads on-hand, and inline the equivalent here.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/api test -- shift-open-flow`
Expected: FAIL — route not mounted (404).

- [ ] **Step 3: Write the route**

`apps/api/src/routes/shift-open.ts`:

```typescript
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { shiftOpen, shiftOpenStockCount, adminUser, type DbClient } from "@ms/db";
import { expectedStockForDay } from "@ms/domain";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { enqueueOutbox } from "../lib/notify.js";

const Submit = z.object({
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().optional(),
  stock_counts: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        counted_quantity: z.number().int().nonnegative(),
        variance_reason: z.string().optional(),
      }),
    )
    .default([]), // empty allowed so an empty catalog cannot deadlock the gate
});

export function shiftOpenRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireBranchScope());

  r.get("/preview", async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const stock = await expectedStockForDay(db, branchId);
    return c.json({ data: { expected_stock: stock } });
  });

  r.post("/", requireCapability("shift_open.submit"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const body = Submit.parse(await c.req.json());
    const auth = c.get("auth");

    // Server-side guard: a varianced line must carry a reason.
    const expected = await expectedStockForDay(db, branchId);
    for (const sc of body.stock_counts) {
      const exp = expected[sc.product_id] ?? 0;
      if (sc.counted_quantity - exp !== 0 && !sc.variance_reason) {
        throw new BusinessError("validation_failed", "variance_reason required on varianced line", 400);
      }
    }

    const created = await db.transaction(async (tx) => {
      const [open] = await tx
        .insert(shiftOpen)
        .values({
          branchId,
          businessDate: body.business_date,
          openedByUserId: auth.userId,
          openedAt: new Date(),
          notes: body.notes ?? null,
        })
        .onConflictDoUpdate({
          target: [shiftOpen.branchId, shiftOpen.businessDate],
          set: {
            openedByUserId: auth.userId,
            openedAt: new Date(),
            notes: body.notes ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!open) throw new BusinessError("internal_error", "shift open upsert failed", 500);

      // Replace count rows atomically (re-count = upsert).
      await tx.delete(shiftOpenStockCount).where(eq(shiftOpenStockCount.shiftOpenId, open.id));
      let varianceCount = 0;
      for (const sc of body.stock_counts) {
        const exp = expected[sc.product_id] ?? 0;
        const variance = sc.counted_quantity - exp;
        if (variance !== 0) varianceCount += 1;
        await tx.insert(shiftOpenStockCount).values({
          shiftOpenId: open.id,
          productId: sc.product_id,
          systemQuantity: exp,
          countedQuantity: sc.counted_quantity,
          variance,
          varianceReason: sc.variance_reason ?? null,
        });
      }

      const [filer] = await tx
        .select({ email: adminUser.email })
        .from(adminUser)
        .where(eq(adminUser.id, auth.userId));
      await enqueueOutbox(tx, c, "shift_open.submitted", {
        shift_open_id: open.id,
        branch_id: branchId,
        business_date: body.business_date,
        opened_by: filer?.email ?? auth.userId,
        variance_count: varianceCount,
      });
      return open;
    });

    await writeAudit(db, c, {
      action: "shift_open.submit",
      entityType: "shift_open",
      entityId: created.id,
      after: created,
    });
    return c.json({ data: created }, 201);
  });

  r.get("/", async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const date = c.req.query("date");
    const [open] = await db
      .select()
      .from(shiftOpen)
      .where(
        date
          ? and(eq(shiftOpen.branchId, branchId), eq(shiftOpen.businessDate, date))
          : eq(shiftOpen.branchId, branchId),
      );
    if (!open) return c.json({ data: null });
    const counts = await db
      .select()
      .from(shiftOpenStockCount)
      .where(eq(shiftOpenStockCount.shiftOpenId, open.id));
    const openedBy = open.openedByUserId
      ? (await db.select({ email: adminUser.email }).from(adminUser).where(eq(adminUser.id, open.openedByUserId)))[0]?.email ?? null
      : null;
    return c.json({ data: { ...open, opened_by: openedBy, stock_counts: counts } });
  });

  return r;
}
```

- [ ] **Step 4: Mount the route**

In `apps/api/src/test-app.ts`, near the daily-close mount (line ~98):

```typescript
import { shiftOpenRoutes } from "./routes/shift-open.js";
// ...
  app.route("/v1/branches/:branchId/shift-open", shiftOpenRoutes(db));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ms/api test -- shift-open-flow`
Expected: PASS (all three cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/shift-open.ts apps/api/src/test-app.ts apps/api/test/integration/shift-open-flow.test.ts
git commit -m "feat(api): /shift-open routes — record-only opening count (preview/post/get)"
```

---

### Task 5: `opened_today` in `/sync/pull`

**Files:**
- Modify: `apps/api/src/routes/sync.ts`
- Test: `apps/api/test/integration/shift-open-flow.test.ts` (add a case)

**Interfaces:**
- Produces: `data.opened_today: boolean` in the pull response — true iff a `shift_open` row exists for the branch on today's Lagos business date.

- [ ] **Step 1: Write the failing test**

Add to `shift-open-flow.test.ts`:

```typescript
it("sync pull reports opened_today after an opening is filed", async () => {
  const { app, branchId, productId, cookie } = await seedBranchWithStock(ctx, { onHand: 4 });
  const todayLagos = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);

  const pre = await (await app.request(`/v1/sync/pull?branch_id=${branchId}`, { headers: { cookie } })).json();
  expect(pre.data.opened_today).toBe(false);

  await app.request(`/v1/branches/${branchId}/shift-open`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ business_date: todayLagos, stock_counts: [{ product_id: productId, counted_quantity: 4 }] }),
  });

  const post = await (await app.request(`/v1/sync/pull?branch_id=${branchId}`, { headers: { cookie } })).json();
  expect(post.data.opened_today).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/api test -- shift-open-flow`
Expected: FAIL — `opened_today` is `undefined`.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/sync.ts`, add `shiftOpen` to the `@ms/db` import, then before the final `return c.json(...)`:

```typescript
    // Has this branch filed an opening count for today (Lagos)? The till uses
    // this to satisfy the open-gate without a local marker (e.g. a 2nd device).
    const todayLagos = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
    const openRows = await db
      .select({ id: shiftOpen.id })
      .from(shiftOpen)
      .where(and(eq(shiftOpen.branchId, branchIdParam), eq(shiftOpen.businessDate, todayLagos)))
      .limit(1);
    const openedToday = openRows.length > 0;
```

Add `opened_today: openedToday,` into the `data` object of the response.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/api test -- shift-open-flow`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sync.ts apps/api/test/integration/shift-open-flow.test.ts
git commit -m "feat(api): expose opened_today on /sync/pull for the till open-gate"
```

---

### Task 6: Telegram notification + audit humanizer for `shift_open.submitted`

**Files:**
- Modify: `apps/worker/src/outbox.ts` (add a `case "shift_open.submitted"`)
- Modify: `apps/admin/src/lib/audit-humanize.ts` (label for `shift_open.submit`)
- Test: `apps/worker/test/outbox.test.ts` (or the file that tests `format()`; follow the existing pattern)

**Interfaces:**
- Consumes: `format({ eventType, payload })` switch in `outbox.ts`; the shared `👤 who · 🕒 when` footer is appended by the existing helper.

- [ ] **Step 1: Write the failing test**

Add to the worker outbox format test:

```typescript
it("formats shift_open.submitted for the owner", () => {
  const msg = format({
    eventType: "shift_open.submitted",
    payload: { business_date: "2026-06-19", opened_by: "amaka", variance_count: 2, branch_name: "Ajao" },
  });
  expect(msg.text).toContain("Shift start");
  expect(msg.text).toContain("amaka");
  expect(msg.text).toContain("2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/worker test -- outbox`
Expected: FAIL — falls through to default/unknown event.

- [ ] **Step 3: Implement the case**

In `apps/worker/src/outbox.ts`, beside `case "daily_close.submitted":`:

```typescript
    case "shift_open.submitted":
      return {
        chatIds: [owner],
        text:
          `🌅 *Shift start — opening count filed*\n` +
          `${p["business_date"]}${p["opened_by"] ? ` · by ${p["opened_by"]}` : ""}\n` +
          `Opening variances: ${p["variance_count"] ?? 0}\n` +
          `👉 ${ADMIN_URL}/branch/shift-start`,
      };
```

In `apps/admin/src/lib/audit-humanize.ts`, add a label for the action key (match the existing map's style):

```typescript
  "shift_open.submit": "Filed opening stock count",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/worker test -- outbox`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/outbox.ts apps/admin/src/lib/audit-humanize.ts apps/worker/test/outbox.test.ts
git commit -m "feat(notify): shift_open.submitted Telegram + audit label"
```

---

### Task 7: Local Dexie marker + offline filing path

**Files:**
- Modify: `apps/admin/src/db/local.ts` (add `ShiftOpenMarkerRow` store + `opened_today` on `SyncMetaRow`; version bump)
- Create: `apps/admin/src/sync/local-shift-open.ts`
- Modify: `apps/admin/src/sync/engine.ts` (store `opened_today` from pull into meta; include `opened_today` in `PullResponse`)
- Create: `apps/admin/src/lib/biz-date.ts` (`lagosToday()`)
- Test: `apps/admin/src/sync/local-shift-open.test.ts`

**Interfaces:**
- Produces: `lagosToday(): string` (yyyy-mm-dd); `fileLocalShiftOpen(input): Promise<void>` writing a marker + outbox row in one txn; `isOpenedToday(branchId): Promise<boolean>` (marker OR meta.opened_today).
- Consumes: `local.outbox` shape from `db/local.ts` (`{ id, endpoint, method, payload, attempt_count, next_attempt_at, status, created_at_local }`).

- [ ] **Step 1: Write the failing test**

`apps/admin/src/sync/local-shift-open.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { local } from "../db/local.js";
import { fileLocalShiftOpen, isOpenedToday } from "./local-shift-open.js";
import { lagosToday } from "../lib/biz-date.js";

const BRANCH = "11111111-1111-1111-1111-111111111111";

beforeEach(async () => {
  await local.shiftOpenMarker.clear();
  await local.outbox.clear();
  await local.meta.clear();
});

describe("local shift-open filing", () => {
  it("writes a date-keyed marker and an outbox row in one go, and unlocks", async () => {
    expect(await isOpenedToday(BRANCH)).toBe(false);
    await fileLocalShiftOpen({
      branchId: BRANCH,
      businessDate: lagosToday(),
      stockCounts: [{ product_id: "p1", counted_quantity: 3 }],
    });
    expect(await isOpenedToday(BRANCH)).toBe(true);
    const outbox = await local.outbox.toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].endpoint).toBe(`/v1/branches/${BRANCH}/shift-open`);
    expect(outbox[0].method).toBe("POST");
  });

  it("isOpenedToday is satisfied by meta.opened_today even with no marker", async () => {
    await local.meta.put({ id: "default", last_pull_at: null, branch_id: BRANCH, opened_today: true });
    expect(await isOpenedToday(BRANCH)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/admin test -- local-shift-open`
Expected: FAIL — `shiftOpenMarker` table / `fileLocalShiftOpen` / `lagosToday` don't exist.

- [ ] **Step 3: Add the marker store + meta field (`db/local.ts`)**

Add the interfaces:

```typescript
export interface ShiftOpenMarkerRow {
  // `${branch_id}::${business_date}`
  id: string;
  branch_id: string;
  business_date: string;
  opened_at: string;
}
```

Add `opened_today?: boolean;` to `SyncMetaRow`. Add the table field to the `BranchDB` class:

```typescript
  shiftOpenMarker!: Table<ShiftOpenMarkerRow, string>;
```

Add a new Dexie version AFTER the existing v4 block (non-destructive — just declares the new store):

```typescript
    // v5: open-gate marker. Records, per (branch, business_date), that an
    // opening count was filed ON THIS DEVICE — unlocks the till offline and
    // survives logout (only "Refresh app" / local.delete() clears it).
    this.version(5).stores({
      shiftOpenMarker: "id, branch_id, business_date",
    });
```

- [ ] **Step 4: Create the Lagos date helper (`lib/biz-date.ts`)**

```typescript
/** Today's Lagos (UTC+1, no DST) business date as yyyy-mm-dd. */
export function lagosToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}
```

- [ ] **Step 5: Create the filing path (`sync/local-shift-open.ts`)**

```typescript
import { local } from "../db/local.js";

interface FileShiftOpenInput {
  branchId: string;
  businessDate: string;
  stockCounts: Array<{ product_id: string; counted_quantity: number; variance_reason?: string }>;
  notes?: string;
}

/** True iff this device has filed today's opening (local marker) OR the last
 *  pull said the server already has one (opened_today). */
export async function isOpenedToday(branchId: string): Promise<boolean> {
  const today = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
  const marker = await local.shiftOpenMarker.get(`${branchId}::${today}`);
  if (marker) return true;
  const meta = await local.meta.get("default");
  return meta?.branch_id === branchId && meta?.opened_today === true;
}

/** Write the unlock marker + enqueue the server POST in one transaction. */
export async function fileLocalShiftOpen(input: FileShiftOpenInput): Promise<void> {
  const nowIso = new Date().toISOString();
  const nowEpoch = Date.now();
  await local.transaction("rw", local.shiftOpenMarker, local.outbox, async () => {
    await local.shiftOpenMarker.put({
      id: `${input.branchId}::${input.businessDate}`,
      branch_id: input.branchId,
      business_date: input.businessDate,
      opened_at: nowIso,
    });
    await local.outbox.put({
      id: crypto.randomUUID(),
      endpoint: `/v1/branches/${input.branchId}/shift-open`,
      method: "POST",
      payload: {
        business_date: input.businessDate,
        stock_counts: input.stockCounts,
        ...(input.notes ? { notes: input.notes } : {}),
      },
      attempt_count: 0,
      next_attempt_at: nowEpoch,
      status: "pending",
      created_at_local: nowEpoch,
    });
  });
}
```

- [ ] **Step 6: Persist `opened_today` from the pull (`sync/engine.ts`)**

In the `PullResponse` interface, add `opened_today?: boolean;` to its `data` shape. Where the pull writes `meta` (the `local.meta.put({ ... last_pull_at: body.next_cursor ... })` near line 381), add:

```typescript
        opened_today: body.data.opened_today ?? false,
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @ms/admin test -- local-shift-open`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/db/local.ts apps/admin/src/sync/local-shift-open.ts apps/admin/src/sync/engine.ts apps/admin/src/lib/biz-date.ts apps/admin/src/sync/local-shift-open.test.ts
git commit -m "feat(till): offline open-gate marker + local shift-open filing path"
```

---

### Task 8: Shift Start page + nav

**Files:**
- Create: `apps/admin/src/routes/branch/shift-start.tsx`
- Modify: `apps/admin/src/components/BranchShell.tsx` (add `Shift start` nav entry, cap `shift_open.submit`)
- Modify: the admin router (wherever `/branch/close` is registered — find with the grep in Step 1) to add `/branch/shift-start`

**Interfaces:**
- Consumes: `api<T>(path, init?)`, `fileLocalShiftOpen`, `lagosToday`, `isOpenedToday`, `local.products` (Dexie), `BranchShell`, `StatHero`, `toast`.

- [ ] **Step 1: Find the router registration for `/branch/close`**

Run: `grep -rn "branch/close\|BranchClosePage" apps/admin/src --include=*.tsx | grep -iv node_modules`
Register the new page the same way the result shows `close` registered.

- [ ] **Step 2: Create `shift-start.tsx`**

A trimmed twin of `close.tsx` (no cash section). Full file:

```tsx
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import { local } from "../../db/local.js";
import { api } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import { fileLocalShiftOpen } from "../../sync/local-shift-open.js";
import { lagosToday } from "../../lib/biz-date.js";

interface PreviewBody { data: { expected_stock: Record<string, number> }; }

export function BranchShiftStartPage({ branchId }: { branchId: string }): JSX.Element {
  const products = useLiveQuery(() => local.products.toArray(), [], []);
  const businessDate = lagosToday();
  const [expected, setExpected] = useState<Record<string, number> | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<PreviewBody>(`/branches/${branchId}/shift-open/preview`);
        if (!cancelled) {
          setExpected(res.data.expected_stock);
          const init: Record<string, string> = {};
          for (const [pid, qty] of Object.entries(res.data.expected_stock)) init[pid] = String(qty);
          setCounts(init);
        }
      } catch (err) {
        // Offline: fall back to an empty grid so she can still count + unlock.
        if (!cancelled) setExpected({});
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [branchId]);

  const productName = (id: string): string =>
    (products as Array<{ id: string; name: string }>).find((p) => p.id === id)?.name ?? id.slice(0, 8);

  const rows = useMemo(() => {
    if (!expected) return [];
    return Object.keys(expected).map((pid) => {
      const exp = expected[pid] ?? 0;
      const got = Number(counts[pid] ?? "0");
      return { product_id: pid, name: productName(pid), expected: exp, counted: got, variance: got - exp, reason: reasons[pid] ?? "" };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expected, counts, reasons, products]);

  async function submit(): Promise<void> {
    if (!expected) return;
    setSubmitting(true);
    try {
      const missing = rows.find((r) => r.variance !== 0 && !r.reason);
      if (missing) throw new Error(`Pick a reason for ${missing.name}.`);
      await fileLocalShiftOpen({
        branchId,
        businessDate,
        notes: notes || undefined,
        stockCounts: rows.map((r) => ({
          product_id: r.product_id,
          counted_quantity: r.counted,
          variance_reason: r.variance !== 0 ? r.reason : undefined,
        })),
      });
      toast.success("Opening stock confirmed. Your till is unlocked.");
      window.location.href = `/branch/sell`;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <BranchShell branchId={branchId} title="Shift start">
      <StatHero
        eyebrow="Branch"
        title="Shift start"
        sub="Count the stock you're starting with. This unlocks your till."
        loading={loading}
        chips={[{ label: "Date", value: businessDate }]}
      />
      <section className="card">
        <h2 className="t-h2" style={{ marginBottom: 12 }}>Opening stock count</h2>
        {loading ? (
          <InlineLoader />
        ) : rows.length === 0 ? (
          <div className="empty">No products to count — you can confirm to open.</div>
        ) : (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="table__num">System</th>
                  <th className="table__num">Counted</th>
                  <th className="table__num">Variance</th>
                  <th>Reason (if variance)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.product_id}>
                    <td>{r.name}</td>
                    <td className="table__num">{r.expected}</td>
                    <td>
                      <input
                        className="input" type="number" min={0}
                        style={{ width: 80, textAlign: "right" }}
                        value={counts[r.product_id] ?? ""}
                        onChange={(e) => setCounts((s) => ({ ...s, [r.product_id]: e.target.value }))}
                      />
                    </td>
                    <td className="table__num" style={{ fontWeight: 700, color: r.variance < 0 ? "var(--danger)" : r.variance > 0 ? "var(--warning)" : "var(--ink-soft)" }}>
                      {r.variance > 0 ? "+" : ""}{r.variance}
                    </td>
                    <td>
                      {r.variance !== 0 ? (
                        <input
                          className="input" placeholder="Required"
                          value={r.reason}
                          onChange={(e) => setReasons((s) => ({ ...s, [r.product_id]: e.target.value }))}
                        />
                      ) : (<span style={{ color: "var(--ink-soft)", fontSize: 13 }}>—</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="field" style={{ marginTop: 12 }}>
          <label className="field__label">Notes</label>
          <textarea className="textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the owner should see" />
        </div>
        <button
          type="button" className="btn btn--primary btn--block btn--lg"
          disabled={submitting || loading || !expected}
          onClick={() => void submit()}
        >
          {submitting ? "Confirming…" : "Confirm opening stock"}
        </button>
      </section>
    </BranchShell>
  );
}
```

- [ ] **Step 3: Add the nav entry (`BranchShell.tsx`)**

In the `NAV` array (where the `Preorders` entry was added this branch), add — placed first so it reads as the start of the shift:

```tsx
  { to: "/branch/shift-start", label: "Shift start", icon: "🌅", cap: "shift_open.submit" },
```

- [ ] **Step 4: Register the route** (mirroring the `/branch/close` registration found in Step 1), wiring `BranchShiftStartPage`.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @ms/admin typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/routes/branch/shift-start.tsx apps/admin/src/components/BranchShell.tsx
git commit -m "feat(till): Shift start page — full opening count, offline-capable"
```

---

### Task 9: Till open-gate + manager/admin preorder-only mode (`sell.tsx`)

**Files:**
- Modify: `apps/admin/src/routes/branch/sell.tsx`

**Interfaces:**
- Consumes: `useAuthUser()` → `{ role, capabilities, email }`; `useCan()` predicate; `isOpenedToday(branchId)`; React state.

- [ ] **Step 1: Add the gate + role evaluation near the top of the component**

In `sell.tsx`, after `const authUser = useAuthUser();` (line ~94), add:

```tsx
  const canSellStock = authUser.capabilities.includes("pos.sell"); // owner + branch_staff
  const canPreorder = authUser.capabilities.includes("pos.preorder");
  const isOwner = authUser.role === "owner";
  const [opened, setOpened] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { isOpenedToday } = await import("../../sync/local-shift-open.js");
      const v = await isOpenedToday(branchId);
      if (!cancelled) setOpened(v);
    })();
    return () => { cancelled = true; };
  }, [branchId]);

  // branch_staff is gated until they file today's opening count. Owner is
  // exempt. Manager/admin have no pos.sell (preorder-only) so are never gated.
  const stockSaleBlocked = canSellStock && !isOwner && opened === false;
```

(Add `useState`/`useEffect` to the existing `react` import if not already present.)

- [ ] **Step 2: Render the block screen when gated**

Immediately before the main `return (` of the component, add:

```tsx
  if (stockSaleBlocked) {
    return (
      <BranchShell branchId={branchId} title="Sell">
        <section className="card" style={{ textAlign: "center", padding: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🌅</div>
          <h2 className="t-h2">Start your shift</h2>
          <p style={{ color: "var(--ink-soft)", margin: "8px 0 20px" }}>
            Count the stock you're starting with to unlock the till.
          </p>
          <a className="btn btn--primary btn--lg" href="/branch/shift-start">Count opening stock</a>
        </section>
      </BranchShell>
    );
  }
```

- [ ] **Step 3: Force preorder-only for non-stock-sellers (manager/admin)**

Find where the cart computes `forcedPreorder` (this branch set it to `cart.some(line cannot be covered)`). OR it with the no-stock-sale role so manager/admin always create preorders:

```tsx
  // Managers/admins have no pos.sell — every order they place is a preorder
  // (no stock consumed), regardless of availability.
  const forcedPreorder = !canSellStock || cart.some(/* existing shortfall predicate, unchanged */);
```

If a user has neither `pos.sell` nor `pos.preorder`, disable the checkout button entirely (defensive — no role hits this today):

```tsx
  const checkoutDisabled = !canSellStock && !canPreorder;
```
Wire `checkoutDisabled` into the existing pay/checkout button's `disabled` prop (OR it with whatever condition is already there).

- [ ] **Step 4: Typecheck + manual smoke**

Run: `pnpm --filter @ms/admin typecheck`
Expected: no errors.

Manual (local, per `reference_local_run`): log in as branch_staff with no opening filed → till shows the "Start your shift" block; file the opening → till unlocks. Log in as manager → till opens directly but every order is a preorder (no instant stock sale).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/routes/branch/sell.tsx
git commit -m "feat(till): open-gate for branch_staff + preorder-only for manager/admin"
```

---

### Task 10: Surface the opening count on the close

**Files:**
- Modify: `apps/api/src/routes/daily-close.ts` (`GET /:id` returns the matching `shift_open`)
- Modify: `apps/admin/src/routes/owner/close-detail.tsx` (show opening variance beside closing variance)
- Test: `apps/api/test/integration/daily-close-flow.test.ts` (add a case)

**Interfaces:**
- Consumes: `shiftOpen`, `shiftOpenStockCount` from `@ms/db`.
- Produces: `data.shift_open` on the daily-close GET response: `{ opened_by, opened_at, stock_counts: [{ productId, countedQuantity, variance }] } | null`.

- [ ] **Step 1: Write the failing test**

Add to `daily-close-flow.test.ts`:

```typescript
it("close detail includes the matching shift_open when one was filed", async () => {
  const { app, branchId, productId, cookie } = await seedBranchWithStock(ctx, { onHand: 10 });
  await app.request(`/v1/branches/${branchId}/shift-open`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ business_date: "2026-06-19", stock_counts: [{ product_id: productId, counted_quantity: 9, variance_reason: "short" }] }),
  });
  const close = await (await app.request(`/v1/branches/${branchId}/daily-close`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ business_date: "2026-06-19", cash_counted_ngn: 0, stock_counts: [{ product_id: productId, counted_quantity: 7, variance_reason: "sold" }] }),
  })).json();
  const detail = await (await app.request(`/v1/branches/${branchId}/daily-close/${close.data.id}`, { headers: { cookie } })).json();
  expect(detail.data.shift_open).not.toBeNull();
  expect(detail.data.shift_open.stock_counts[0].countedQuantity).toBe(9);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/api test -- daily-close-flow`
Expected: FAIL — `shift_open` is `undefined`.

- [ ] **Step 3: Implement in `daily-close.ts` `GET /:id`**

Add `shiftOpen`, `shiftOpenStockCount` to the `@ms/db` import. Before the final `return c.json(...)` of `GET /:id`:

```typescript
    const [open] = await db
      .select()
      .from(shiftOpen)
      .where(and(eq(shiftOpen.branchId, close.branchId), eq(shiftOpen.businessDate, close.businessDate)));
    const openCounts = open
      ? await db.select().from(shiftOpenStockCount).where(eq(shiftOpenStockCount.shiftOpenId, open.id))
      : [];
    const openedBy = open?.openedByUserId
      ? (await db.select({ email: adminUser.email }).from(adminUser).where(eq(adminUser.id, open.openedByUserId)))[0]?.email ?? null
      : null;
    const shiftOpenOut = open ? { ...open, opened_by: openedBy, stock_counts: openCounts } : null;
```

Add `shift_open: shiftOpenOut,` into the returned `data` object. (Ensure `and` is imported from `drizzle-orm`.)

- [ ] **Step 4: Show it in `close-detail.tsx`**

In the owner close-detail stock table, add an "Opening" column sourced from `data.shift_open?.stock_counts` keyed by `productId`, and a derived "Shift Δ" = `closing.variance - opening.variance`. Minimal addition to the existing row map:

```tsx
const openingByProduct = new Map<string, number>(
  (detail.shift_open?.stock_counts ?? []).map((s: any) => [s.productId, s.countedQuantity]),
);
// in the row: opening = openingByProduct.get(row.productId) ?? "—"
// shift delta = (row.variance) - (opening != null ? opening - row.systemQuantity : 0)
```
Render an `Opening` cell and a `Shift Δ` cell per row; when no `shift_open` exists, show `—` (no opening was filed that day).

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @ms/api test -- daily-close-flow` → PASS
Run: `pnpm --filter @ms/admin typecheck` → no errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/daily-close.ts apps/admin/src/routes/owner/close-detail.tsx apps/api/test/integration/daily-close-flow.test.ts
git commit -m "feat(close): show opening count + shift-attributable variance on close detail"
```

---

## Final verification (run before declaring done)

- [ ] `pnpm -r lint` → 0 errors
- [ ] `pnpm -r typecheck` → clean
- [ ] `pnpm --filter @ms/shared test` / `@ms/worker test` / `@ms/admin test` → green
- [ ] `pnpm --filter @ms/api test -- shift-open-flow` and `-- daily-close-flow` and `-- branch-preorders` → green (run individually to dodge the known full-suite testcontainer `beforeAll` flake)
- [ ] Migration applied locally; `pnpm --filter @ms/db migrate` is a no-op on re-run
- [ ] Manual smoke per Task 9 Step 4 (branch_staff gated → unlocks; manager preorder-only)
- [ ] Note for deploy: existing tills need a PWA hard-refresh to load the new bundle + Dexie v5

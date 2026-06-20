# Shift-Session Lifecycle + Fulfilment Metric — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the calendar-day shift model with real per-branch shift *sessions* (open → sell → close, conclusive, multiple per day, sales blocked with no open shift), and fix the dashboard "awaiting fulfilment" metric.

**Architecture:** `shift_open` is promoted into the session (status open/closed, closed_at/by, shift_number; one open shift per branch via partial-unique index). `daily_close` links to a shift via `shift_id` and closing sets the shift closed (conclusive). Sale creation requires an open shift (server 409 + offline gate). Reconciliation runs over the shift window `[opened_at, closed_at)`. The offline POS tracks a local `currentShift`.

**Tech Stack:** Hono + Drizzle (raw `db.execute(sql\`\`)` and query builder), Postgres, TypeScript, Vitest + Testcontainers (integration), React/TanStack admin UI, Dexie (offline POS).

## Global Constraints

- **Money is integer NGN.** Lagos dates via the existing `lagosToday()` / `nowLagos()` helpers — do not invent date logic.
- **One open shift per branch** is the core invariant — enforced by a partial unique index `ON shift_open (branch_id) WHERE status = 'open'`, never only in app code.
- **Everyone is gated:** sale creation (walk-up AND preorder) requires an open shift for ALL capabilities (owner included). Customer storefront orders are NOT branch-till sales and are never gated.
- **Conclusive close:** a closed shift cannot be re-closed and cannot take sales. Close sets `shift_open.status='closed'`, `closed_at`, `closed_by_user_id` in the same transaction as the `daily_close` insert.
- **Reconciliation window** = sales with `created_at_local` in `[opened_at, closed_at)`, not the whole calendar day.
- **No `sale_order.shift_id`** — reconciliation uses the time window (one open shift per branch makes it unambiguous). Do not add a shift_id to sale_order.
- **Migration is `0053_shift_session.sql`**, journal idx `52`. Must be added to `migrations/meta/_journal.json` and `@ms/db` rebuilt, or migrate/tests skip it. Backfill must be idempotent.
- **Integration test boilerplate:** copy the container/server `beforeAll`/`afterAll` from an existing file in `apps/api/test/integration/` (e.g. `shift-open-flow.test.ts` or `daily-close-flow.test.ts`); 120_000ms beforeAll.
- **Admin PWA** — offline gate must never hard-error; `.catch`/empty-state, not a thrown error, when there's no open shift.
- Run a single API test file: `cd apps/api && npx vitest run test/<path>`. Admin gate: `pnpm --filter @ms/admin typecheck` (admin has no test files; typecheck+build are its gates). Repo has ~6 pre-existing unrelated lint issues — not this work's regressions.
- Work happens in the worktree at the repo root you were given; commit on branch `feat/shift-lifecycle`.

---

## File Structure

- `apps/api/src/routes/reports.ts` — Phase 1 metric (modify `/overview` fulfilment block).
- `apps/admin/src/routes/owner/dashboard.tsx` — Phase 1 tile rename.
- `apps/api/test/integration/reports-overview.test.ts` — Phase 1 assertions.
- `packages/db/migrations/0053_shift_session.sql` + `meta/_journal.json` — schema.
- `packages/db/src/schema/shift-open.ts`, `daily-close.ts` — Drizzle columns.
- `packages/domain/src/daily-close.ts` — shift-window reconciliation helpers.
- `apps/api/src/routes/shift-open.ts` — open = new session / re-count.
- `apps/api/src/routes/daily-close.ts` — conclusive close + shift link.
- `apps/api/src/routes/sales.ts` — open-shift gate on create.
- `apps/api/src/routes/sync.ts` — open-shift state in pull.
- `apps/admin/src/sync/local-shift-open.ts` (+ Dexie `local` schema) — offline `currentShift`, `hasOpenShift`, `fileLocalShiftClose`.
- `apps/admin/src/routes/branch/sell.tsx`, `shift-start.tsx`, `close.tsx`, `closes.tsx` — POS UX.

---

## Task 1 (Phase 1): Awaiting-fulfilment metric

**Files:**
- Modify: `apps/api/src/routes/reports.ts` (the `/overview` fulfilment block), `apps/admin/src/routes/owner/dashboard.tsx`
- Test: `apps/api/test/integration/reports-overview.test.ts`

**Interfaces:**
- Produces: `GET /reports/overview` `data.fulfilment.awaiting_fulfilment` (replaces `orders_pending`). Other fulfilment fields unchanged (`preorders_open`, `bags_queue`, `pending_transfers`).

- [ ] **Step 1: Update the failing test**

In `reports-overview.test.ts`, change the `fulfilment` type to use `awaiting_fulfilment: number` (remove `orders_pending`), and assert `typeof data.fulfilment.awaiting_fulfilment === "number"` and `(data.fulfilment as Record<string, unknown>).orders_pending === undefined`. If feasible in the existing seed, add a case asserting an unfulfilled preorder counts and a paid walk-up does not (only if the file already seeds orders; otherwise the type/shape assertion suffices and the math is covered by reading).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/integration/reports-overview.test.ts`
Expected: FAIL (handler still returns `orders_pending`).

- [ ] **Step 3: Change the query + field name**

In `reports.ts`, in the fulfilment `block(...)`, replace the `pendingRow` query and the returned key:

```ts
// was orders_pending counting walk-up paid/handed_over — now awaiting fulfilment:
db.execute<{ cnt: number }>(sql`
  SELECT COUNT(*)::int AS cnt FROM sale_order
  WHERE is_preorder = true
    AND fulfilled_at IS NULL
    AND status NOT IN ('cancelled','failed')`),
```

Return `awaiting_fulfilment: Number(pendingRow[0]?.cnt ?? 0)` instead of `orders_pending`, and update the block's fallback object to `{ awaiting_fulfilment: 0, preorders_open: 0, bags_queue: 0, pending_transfers: 0 }`.

- [ ] **Step 4: Update the dashboard tile**

In `dashboard.tsx`: change the `Overview` interface `fulfilment` field `orders_pending` → `awaiting_fulfilment`. In the operational strip, the tile currently labeled "Orders pending" becomes:

```tsx
<Stat
  label="Awaiting fulfilment"
  value={String(overview.fulfilment.awaiting_fulfilment)}
  tone={overview.fulfilment.awaiting_fulfilment > 0 ? "warn" : "good"}
  hint={`${overview.fulfilment.preorders_open} open preorders`}
/>
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd apps/api && npx vitest run test/integration/reports-overview.test.ts` → PASS.
Run: `pnpm --filter @ms/admin typecheck` → 0 errors (no remaining `orders_pending` references).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/reports.ts apps/admin/src/routes/owner/dashboard.tsx apps/api/test/integration/reports-overview.test.ts
git commit -m "fix: dashboard awaiting_fulfilment metric (replaces miscounted orders_pending)"
```

---

## Task 2 (Phase 2): Schema migration — shift session

**Files:**
- Create: `packages/db/migrations/0053_shift_session.sql`
- Modify: `packages/db/migrations/meta/_journal.json`, `packages/db/src/schema/shift-open.ts`, `packages/db/src/schema/daily-close.ts`
- Test: `apps/api/test/integration/` migrate-applies check (the existing integration harness runs migrations in `setupTestDb`; a green run of any integration test proves the migration applies).

**Interfaces:**
- Produces: `shift_open` columns `status` (`'open'|'closed'`), `closed_at`, `closed_by_user_id`, `shift_number`; partial-unique `uq_shift_open_one_open_per_branch`. `daily_close.shift_id`. Drizzle objects expose these as `status`, `closedAt`, `closedByUserId`, `shiftNumber`, `shiftId`.

- [ ] **Step 1: Write the migration SQL**

Create `packages/db/migrations/0053_shift_session.sql`:

```sql
-- shift_open becomes a session
ALTER TABLE "shift_open" ADD COLUMN "status" text NOT NULL DEFAULT 'open';
ALTER TABLE "shift_open" ADD COLUMN "closed_at" timestamptz;
ALTER TABLE "shift_open" ADD COLUMN "closed_by_user_id" uuid REFERENCES "admin_user"("id");
ALTER TABLE "shift_open" ADD COLUMN "shift_number" integer NOT NULL DEFAULT 1;
ALTER TABLE "shift_open" ADD CONSTRAINT "shift_open_status_check" CHECK ("status" IN ('open','closed'));

-- daily_close links to its shift
ALTER TABLE "daily_close" ADD COLUMN "shift_id" uuid REFERENCES "shift_open"("id");

-- backfill: close shifts that already have a daily_close; link the close (idempotent)
UPDATE "shift_open" so SET
  "status" = 'closed',
  "closed_at" = dc."submitted_at",
  "closed_by_user_id" = dc."submitted_by_user_id"
FROM "daily_close" dc
WHERE dc."branch_id" = so."branch_id" AND dc."business_date" = so."business_date";

UPDATE "daily_close" dc SET "shift_id" = so."id"
FROM "shift_open" so
WHERE so."branch_id" = dc."branch_id" AND so."business_date" = dc."business_date"
  AND dc."shift_id" IS NULL;

-- drop the one-per-day uniques
ALTER TABLE "shift_open" DROP CONSTRAINT IF EXISTS "shift_open_branch_id_business_date_unique";
ALTER TABLE "daily_close" DROP CONSTRAINT IF EXISTS "daily_close_branch_id_business_date_unique";

-- enforce one OPEN shift per branch
CREATE UNIQUE INDEX "uq_shift_open_one_open_per_branch" ON "shift_open" ("branch_id") WHERE "status" = 'open';
```

> Verify the exact existing unique-constraint names first by reading the prior migration that created them (`0052_shift_open.sql` and the daily_close migration) — Drizzle's generated names follow `<table>_<cols>_unique`. Use the real names in the `DROP CONSTRAINT` lines (keep `IF EXISTS` as a safety net).

- [ ] **Step 2: Add the journal entry**

In `packages/db/migrations/meta/_journal.json`, append after idx 51:

```json
,{ "idx": 52, "version": "7", "when": 1782950000000, "tag": "0053_shift_session", "breakpoints": true }
```

- [ ] **Step 3: Update Drizzle schema**

In `packages/db/src/schema/shift-open.ts`, add to the `shiftOpen` table: `status: text("status").notNull().default("open")`, `closedAt: timestamp("closed_at", { withTimezone: true })`, `closedByUserId: uuid("closed_by_user_id").references(() => adminUser.id)`, `shiftNumber: integer("shift_number").notNull().default(1)`. Remove the `branchDateUnique` unique from the table definition (the partial index is raw SQL, not modeled in Drizzle — that's fine). In `daily-close.ts`, add `shiftId: uuid("shift_id").references(() => shiftOpen.id)` (import `shiftOpen`) and remove its `branchDateUnique`.

- [ ] **Step 4: Rebuild @ms/db**

Run: `pnpm --filter @ms/db build`
Expected: clean.

- [ ] **Step 5: Verify migration applies**

Run any existing integration test that boots the container, e.g.: `cd apps/api && npx vitest run test/integration/shift-open-flow.test.ts`
Expected: `setupTestDb` runs all migrations incl. 0053 without error (test may otherwise pass/fail on its own assertions — what matters here is no migration error; if the test's own logic now conflicts with later tasks, that's handled in those tasks).

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0053_shift_session.sql packages/db/migrations/meta/_journal.json packages/db/src/schema/shift-open.ts packages/db/src/schema/daily-close.ts
git commit -m "feat(db): shift session columns + one-open-per-branch index (migration 0053)"
```

---

## Task 3 (Phase 2): Domain — shift-window reconciliation helpers

**Files:**
- Modify: `packages/domain/src/daily-close.ts`
- Test: `apps/api/test/integration/` (covered via close tests in Task 5) — plus a focused domain check if a domain test harness exists; otherwise verify via Task 5.

**Interfaces:**
- Produces: `expectedCashForShift(tx, branchId, openedAt: Date, closedAt: Date): Promise<number>` and `cashSalesForShift(db, branchId, openedAt: Date, closedAt: Date): Promise<...>` mirroring the existing `*ForDay` signatures but filtering `created_at_local >= openedAt AND created_at_local < closedAt`.

- [ ] **Step 1: Read the existing day functions**

Read `expectedCashForDay` and `cashSalesForDay` in `packages/domain/src/daily-close.ts` to learn their exact return types and query shape.

- [ ] **Step 2: Add window variants (extract shared core)**

Refactor so the day functions and the new shift functions share a private window core. Add exported `expectedCashForShift`/`cashSalesForShift` that pass `[openedAt, closedAt)` as the window. Keep `*ForDay` working (delegate to the core with the calendar-day window) so day-bucketed callers are unaffected. Match the existing money-integer and status-filter conventions exactly.

- [ ] **Step 3: Build domain**

Run: `pnpm --filter @ms/domain build` → clean.

- [ ] **Step 4: Commit**

```bash
git add packages/domain/src/daily-close.ts
git commit -m "feat(domain): shift-window reconciliation helpers"
```

---

## Task 4 (Phase 2): Open = new session / re-count

**Files:**
- Modify: `apps/api/src/routes/shift-open.ts`
- Test: `apps/api/test/integration/shift-open-flow.test.ts` (extend)

**Interfaces:**
- Consumes: `shiftOpen.status/shiftNumber` (Task 2).
- Produces: `POST /branches/:branchId/shift-open` — creates a new `open` shift when none open (shift_number = next per branch+date), or re-counts the existing open shift; never creates a 2nd open shift.

- [ ] **Step 1: Write failing tests**

In `shift-open-flow.test.ts` add: (a) first open returns 201 with `status==='open'`, `shift_number===1`; (b) a second POST while open updates counts but does NOT create a second shift (query `shift_open` count for the branch+date stays 1, still one `open`); (c) after the shift is closed (insert a close via the close endpoint or directly set status closed in the test DB), a new POST opens `shift_number===2`. Use the existing seed helpers.

- [ ] **Step 2: Run → fail**

Run: `cd apps/api && npx vitest run test/integration/shift-open-flow.test.ts`
Expected: FAIL (current handler upserts on (branch,date), no status/shift_number).

- [ ] **Step 3: Rewrite the create logic**

Replace the `onConflictDoUpdate` insert with: select the branch's open shift (`status='open'`). If found → use it (re-count: keep the existing "delete + reinsert counts" block against `open.id`). If not found → `INSERT` a new `shift_open` with `status:'open'`, `openedByUserId`, `openedAt: new Date()`, `notes`, and `shiftNumber = (SELECT COALESCE(MAX(shift_number),0)+1 FROM shift_open WHERE branch_id=? AND business_date=?)`. Wrap the lookup-or-insert + counts in the existing transaction. Keep the variance-reason guard, audit, and `shift_open.submitted` outbox. On a unique-violation from the partial index (concurrent open), surface `BusinessError("conflict","shift already open",409)`.

- [ ] **Step 4: Run → pass**

Run: `cd apps/api && npx vitest run test/integration/shift-open-flow.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/shift-open.ts apps/api/test/integration/shift-open-flow.test.ts
git commit -m "feat(api): shift-open creates a session or re-counts the open one"
```

---

## Task 5 (Phase 2): Conclusive close + shift link

**Files:**
- Modify: `apps/api/src/routes/daily-close.ts`
- Test: `apps/api/test/integration/daily-close-flow.test.ts` (extend)

**Interfaces:**
- Consumes: open shift (Task 4), `expectedCashForShift`/`cashSalesForShift` (Task 3), `daily_close.shift_id` (Task 2).
- Produces: `POST /daily-close` finalizes the branch's open shift: links `shift_id`, sets shift `closed`; 409 when no open shift or already closed.

- [ ] **Step 1: Write failing tests**

In `daily-close-flow.test.ts`: (a) close with no open shift → 409 `no_open_shift`; (b) with an open shift, close returns 200/201, the `daily_close.shift_id` equals the shift, and the shift row is now `status='closed'` with `closed_at` set; (c) a second close attempt → 409 (conclusive); (d) reconciliation uses the shift window — seed a sale BEFORE `opened_at` and one within the window; assert only the in-window sale is counted in `system_cash_total`/variance. Adjust the existing `beforeAll` seed (it must now open a shift before closing — see note).

> Note: the existing daily-close tests likely close without opening a session. Update the seed so each test opens a shift first (insert a `shift_open` with `status='open'`, `opened_at`) — mirror how Task 4's tests create one.

- [ ] **Step 2: Run → fail**

Run: `cd apps/api && npx vitest run test/integration/daily-close-flow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite the submit handler**

In `POST /`: load the branch's `open` shift; if none → `409 no_open_shift`. Replace the `onConflictDoUpdate` daily_close upsert with a plain `INSERT` carrying `shiftId: openShift.id` and reconciliation computed via `expectedCashForShift(tx, branchId, openShift.openedAt, now)`. In the same transaction, `UPDATE shift_open SET status='closed', closed_at=now, closed_by_user_id=auth.userId WHERE id=openShift.id`. Add `shift_id` to the `daily_close.submitted` outbox payload. Keep approve/dispute endpoints. Update `GET /:id` to join the shift via `daily_close.shift_id` instead of `(branch, business_date)`.

- [ ] **Step 4: Run → pass**

Run: `cd apps/api && npx vitest run test/integration/daily-close-flow.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/daily-close.ts apps/api/test/integration/daily-close-flow.test.ts
git commit -m "feat(api): conclusive close finalizes the open shift (shift-window reconcile)"
```

---

## Task 6 (Phase 2): Sale-creation open-shift gate

**Files:**
- Modify: `apps/api/src/routes/sales.ts`
- Test: `apps/api/test/integration/` — the sales/POS test file (find it; e.g. `sales-flow.test.ts`) extended, or a new `sales-shift-gate.test.ts`.

**Interfaces:**
- Consumes: open shift state.
- Produces: `POST /sales` (create) returns `409 no_open_shift` when the branch has no open shift; succeeds when one is open.

- [ ] **Step 1: Write failing test**

Seed a branch + catalog with NO open shift; POST a walk-up sale → expect `409` with code `no_open_shift`. Then open a shift (insert `shift_open` status open) and POST again → expect success (201). Add a preorder variant: with no open shift, a preorder create also → 409. (Owner credentials too — gate is universal.)

- [ ] **Step 2: Run → fail**

Run: `cd apps/api && npx vitest run test/integration/<sales test file>`
Expected: FAIL (sales currently created with no shift).

- [ ] **Step 3: Add the gate**

In the sale create path (`POST /`), after resolving the branch and before inserting the order, query for an `open` shift for that branch; if none → `throw new BusinessError("conflict","Open a shift before selling",409)` (code surfaced as `no_open_shift` — match the project's error-code convention; reuse the `conflict` BusinessError kind with a clear message, or add a dedicated code if the codebase uses string codes). Remove the OLD branch_staff opening-count server gate if one exists in this path (the open-shift gate supersedes it). Do NOT gate customer storefront order routes (`public-orders.ts`).

- [ ] **Step 4: Run → pass**

Run the test file → PASS. Also re-run `shift-open-flow` + `daily-close-flow` to ensure no cross-effects.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sales.ts apps/api/test/integration/<file>
git commit -m "feat(api): block sale creation when the branch has no open shift"
```

---

## Task 7 (Phase 2): Open-shift state in sync pull

**Files:**
- Modify: `apps/api/src/routes/sync.ts`
- Test: `apps/api/test/integration/` sync test (extend if present; else assert via reading + a focused test that the pull payload includes `open_shift`).

**Interfaces:**
- Produces: `/sync/pull` response includes `open_shift: { id: string; opened_at: string } | null` for the caller's branch.

- [ ] **Step 1: Write failing test**

If a sync integration test exists, extend it: with an open shift seeded, the pull payload has `open_shift` non-null with the right id; with none, it's null. Otherwise add a minimal test.

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Add open_shift to the pull**

In the pull handler, select the branch's `open` shift (`status='open'`) and include `open_shift: shift ? { id, opened_at } : null` in the response payload alongside the existing stock snapshot etc. (follow the existing payload-building pattern).

- [ ] **Step 4: Run → pass + Commit**

```bash
git add apps/api/src/routes/sync.ts apps/api/test/integration/<file>
git commit -m "feat(api): expose branch open-shift state in /sync/pull"
```

---

## Task 8 (Phase 2): Offline shift state (Dexie) — currentShift, hasOpenShift, close

**Files:**
- Modify: `apps/admin/src/sync/local-shift-open.ts`, `apps/admin/src/db/local.ts` (Dexie schema), the sync-pull consumer that writes `local.meta` (find it, likely `apps/admin/src/sync/*.ts`).

**Interfaces:**
- Produces: `hasOpenShift(branchId): Promise<boolean>`; `fileLocalShiftClose(branchId): Promise<void>` (clears currentShift + enqueues nothing itself — the close POST is enqueued by close.tsx's existing flow, OR enqueue here if that matches the open pattern); `fileLocalShiftOpen` also writes a `currentShift` record. Dexie gains a `currentShift` table (bump the Dexie version).

- [ ] **Step 1: Read the Dexie schema + sync pull consumer**

Read `apps/admin/src/db/local.ts` for the current Dexie version/tables (`shiftOpenMarker`, `meta`, `outbox`, stock snapshot). Read the code that consumes `/sync/pull` and writes `local.meta.opened_today`.

- [ ] **Step 2: Add currentShift table + bump version**

Add a `currentShift` Dexie table keyed by `branchId`: `{ branchId, shiftLocalId, openedAt, status: 'open'|'closed' }`. Bump the Dexie version number with an upgrade (no destructive clears unless needed). 

- [ ] **Step 3: Implement hasOpenShift + open/close writers**

`hasOpenShift(branchId)`: true iff `currentShift[branchId].status === 'open'`, OR the last pull's `open_shift` (mirrored into `currentShift`/meta) is non-null. `fileLocalShiftOpen`: in its existing transaction, also `put` `currentShift {status:'open', openedAt}`. `fileLocalShiftClose(branchId)`: set `currentShift.status='closed'`. Update the pull consumer to mirror `open_shift` into `currentShift` (open when present, closed/absent when null) so devices heal.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @ms/admin typecheck` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/sync/local-shift-open.ts apps/admin/src/db/local.ts apps/admin/src/sync/<pull-consumer>.ts
git commit -m "feat(admin): offline currentShift state + hasOpenShift/close (Dexie)"
```

---

## Task 9 (Phase 2): POS UX — universal sell gate + reopen prompt + conclusive close

**Files:**
- Modify: `apps/admin/src/routes/branch/sell.tsx`, `shift-start.tsx`, `close.tsx`, `closes.tsx`

**Interfaces:**
- Consumes: `hasOpenShift`, `fileLocalShiftClose`, `fileLocalShiftOpen` (Task 8); the conclusive close API (Task 5).

- [ ] **Step 1: sell.tsx — universal gate**

Replace `const stockSaleBlocked = canSellStock && !isOwner && opened === false;` and the `opened`/`isOpenedToday` logic with `hasOpenShift(branchId)` → `hasShift: boolean | null`. Checkout is disabled for everyone when `hasShift === false`. When `hasShift === false`, render the "Open a shift to start selling" panel (generalize the existing "Start your shift" block — it must show for ALL roles now, not just branch_staff missing the count) with a CTA to `/branch/shift-start`. Keep the no-flash tri-state (`null` = loading).

- [ ] **Step 2: shift-start.tsx — open the session**

On successful open, `fileLocalShiftOpen` now also sets `currentShift` open (Task 8). If `hasOpenShift` is already true on mount, redirect to Sell (don't allow opening a 2nd shift). Keep the opening-count form.

- [ ] **Step 3: close.tsx — conclusive + reopen prompt**

Block the close form when there's no open shift. On successful close: call `fileLocalShiftClose(branchId)`, then show a "Shift closed" confirmation with an **"Open a new shift"** CTA → `/branch/shift-start` (replace any flow that lets you immediately re-close).

- [ ] **Step 4: closes.tsx — multiple per day**

The list now shows multiple shift-end rows per day; show `shift_number` and opened→closed where available (the list endpoint already returns closes; just stop assuming one-per-day in the UI copy/keys).

- [ ] **Step 5: Typecheck + build**

Run: `pnpm --filter @ms/admin typecheck` → 0; `pnpm --filter @ms/admin build` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/routes/branch/sell.tsx apps/admin/src/routes/branch/shift-start.tsx apps/admin/src/routes/branch/close.tsx apps/admin/src/routes/branch/closes.tsx
git commit -m "feat(admin): universal shift gate on Sell, conclusive close + reopen prompt"
```

---

## Task 10 (Phase 2): Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: API integration (shift + sales + close + overview)**

Run: `cd apps/api && npx vitest run test/integration/shift-open-flow.test.ts test/integration/daily-close-flow.test.ts test/integration/reports-overview.test.ts` and the sales gate test. Re-run any single file once if a testcontainer beforeAll times out under load. Expected: PASS.

- [ ] **Step 2: Repo typecheck + admin build**

Run: `pnpm -r typecheck` (and `cd apps/admin && npx tsc --noEmit`), `pnpm --filter @ms/admin build`. Expected: 0 type errors; build clean. Separate any NEW lint issues from the ~6 known pre-existing unrelated ones.

- [ ] **Step 3: Migration applies from scratch**

Confirm `setupTestDb` (runs all migrations incl. 0053) succeeded in Step 1 with no migration error.

- [ ] **Step 4: Report** any residual concerns for the final whole-branch review (esp. offline edge cases that can't be unit-tested without a browser).

---

## Notes for the implementer

- **Offline cannot be fully tested headless** — the Dexie/`hasOpenShift` logic is verified by typecheck + reading; flag it for manual smoke on a real till in the final review notes.
- **Migration 0053 collides** with the concurrent `feat/size-aware-shift-counts` branch — the controller handles renumbering at merge time; do not try to coordinate it from inside a task.
- Do not gate `public-orders.ts` (customer storefront) — only branch/till sale creation.
- Commit only the files each task names (explicit pathspecs) — the repo has concurrent activity.

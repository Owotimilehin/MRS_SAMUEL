# Online-fulfilment polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three production gaps — dead storefront nav icons, no "awaiting fulfilment" worklist, and online orders always landing on the first branch.

**Architecture:** Customer storefront (TanStack Start SSR), admin SPA (TanStack Router), Hono API on Drizzle/Postgres. Gap 3 adds one nullable-free boolean column to `branch` with a single-default invariant enforced server-side; gaps 1–2 are UI-only.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Postgres, React, Vitest (API integration tests via testcontainers).

## Global Constraints

- Run API tests with `TZ=UTC`.
- Quality gates before push: `pnpm -w lint` (0 errors), `pnpm -w typecheck` (clean), affected tests green.
- Migrations: new `00NN_*.sql` MUST be added to `packages/db/migrations/meta/_journal.json` or the migrator skips it. Rebuild `@ms/db` after schema edits (`pnpm --filter @ms/db build`).
- `admin`/`customer` packages have no test runner — verify those via typecheck + build. Server behaviour is tested in `apps/api/test/integration`.
- Branch invariant: **at most one** branch has `is_online_default = true`. Checkout falls back to `branches[0]` when none is set.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: DB column + schema for online-default branch

**Files:**
- Create: `packages/db/migrations/0054_branch_online_default.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Modify: `packages/db/src/schema/branch.ts`

**Interfaces:**
- Produces: `branch.isOnlineDefault` (drizzle boolean column, default false); SQL column `is_online_default boolean NOT NULL DEFAULT false`.

- [ ] **Step 1: Write the migration SQL**

`packages/db/migrations/0054_branch_online_default.sql`:
```sql
-- Which branch fulfils online orders.
--
-- Online checkout previously hardcoded the first branch returned by the API,
-- so with >1 branch every web order silently landed on whichever sorted first.
-- This flag lets the owner choose. At most one branch is the default; the app
-- enforces that on write. No default set = checkout falls back to first branch.
ALTER TABLE "branch" ADD COLUMN "is_online_default" boolean NOT NULL DEFAULT false;
```

- [ ] **Step 2: Register the migration in the journal**

In `packages/db/migrations/meta/_journal.json`, append after the `0053_shift_session` entry (inside the `entries` array):
```json
    ,{ "idx": 53, "version": "7", "when": 1782980000000, "tag": "0054_branch_online_default", "breakpoints": true }
```

- [ ] **Step 3: Add the column to the drizzle schema**

In `packages/db/src/schema/branch.ts`, add after the `isActive` line (line 25):
```ts
  isOnlineDefault: boolean("is_online_default").notNull().default(false),
```
(`boolean` is already imported on line 1.)

- [ ] **Step 4: Rebuild the db package**

Run: `pnpm --filter @ms/db build`
Expected: builds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/0054_branch_online_default.sql packages/db/migrations/meta/_journal.json packages/db/src/schema/branch.ts
git commit -m "feat(db): add branch.is_online_default (migration 0054)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: API — expose flag + enforce single-default on write

**Files:**
- Modify: `apps/api/src/routes/branches.ts:27` (PatchBranch schema) and `:70-99` (patch handler)
- Modify: `apps/api/src/routes/public-catalog.ts:176-190` (`/branches` payload)
- Test: `apps/api/test/integration/branch-online-default.test.ts` (create)

**Interfaces:**
- Consumes: `branch.isOnlineDefault` from Task 1.
- Produces: `PATCH /v1/branches/:id` accepts `{ is_online_default?: boolean }`; setting `true` unsets it on all other branches in one transaction. `GET /v1/public/catalog/branches` rows include `is_online_default: boolean`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/branch-online-default.test.ts`. Mirror the harness used by other files in that dir (e.g. `delivery-admin.test.ts`) for app/db/auth setup — reuse its `beforeAll`/owner-auth helper. Core assertions:
```ts
it("enforces a single online-default branch", async () => {
  const b = await createBranch({ code: "ALPHA" });
  const c2 = await createBranch({ code: "BETA" });

  await patchBranch(b.id, { is_online_default: true });
  let list = await getBranches();
  expect(list.find((x) => x.id === b.id)!.isOnlineDefault).toBe(true);

  // Setting BETA must clear ALPHA.
  await patchBranch(c2.id, { is_online_default: true });
  list = await getBranches();
  expect(list.find((x) => x.id === b.id)!.isOnlineDefault).toBe(false);
  expect(list.find((x) => x.id === c2.id)!.isOnlineDefault).toBe(true);
  expect(list.filter((x) => x.isOnlineDefault).length).toBe(1);
});

it("exposes is_online_default on the public catalog", async () => {
  const b = await createBranch({ code: "PUBC" });
  await patchBranch(b.id, { is_online_default: true });
  const rows = await publicGet("/v1/public/catalog/branches");
  expect(rows.find((x: any) => x.id === b.id)?.is_online_default).toBe(true);
});
```
(Use the existing helpers in the test dir for `createBranch`/`patchBranch`/`getBranches`/auth; if absent, write thin wrappers over `app.request` with the owner bearer token the other tests use.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `TZ=UTC pnpm --filter @ms/api test branch-online-default`
Expected: FAIL — schema rejects `is_online_default` / flag not unset.

- [ ] **Step 3: Accept the field in the patch schema**

In `apps/api/src/routes/branches.ts`, change `PatchBranch` (line 27) to:
```ts
const PatchBranch = CreateBranch.partial().extend({
  is_online_default: z.boolean().optional(),
});
```

- [ ] **Step 4: Enforce the single-default invariant in the patch handler**

In the `r.patch("/:id", ...)` handler, replace the `const [after] = await db.update(...)` line (line 88) so the write runs in a transaction that clears other defaults first:
```ts
if (body.is_online_default !== undefined) patch["isOnlineDefault"] = body.is_online_default;

const after = await db.transaction(async (tx) => {
  if (body.is_online_default === true) {
    await tx
      .update(branch)
      .set({ isOnlineDefault: false, updatedAt: new Date() })
      .where(sql`${branch.id} <> ${id} AND ${branch.isOnlineDefault} = true`);
  }
  const [row] = await tx.update(branch).set(patch).where(eq(branch.id, id)).returning();
  return row;
});
if (!after) throw new BusinessError("internal_error", "update returned no rows", 500);
```
(`sql` is already imported on line 2.)

- [ ] **Step 5: Expose the flag on the public catalog**

In `apps/api/src/routes/public-catalog.ts`, add to the `.select({...})` in `r.get("/branches", ...)` (after `phone:` on line 182):
```ts
        is_online_default: branch.isOnlineDefault,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `TZ=UTC pnpm --filter @ms/api test branch-online-default`
Expected: PASS (both cases).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/branches.ts apps/api/src/routes/public-catalog.ts apps/api/test/integration/branch-online-default.test.ts
git commit -m "feat(api): online-default branch (single-default invariant + catalog field)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Customer — checkout uses the online-default branch

**Files:**
- Modify: `apps/customer/src/lib/api/types.ts:45-50` (`ApiBranch`)
- Modify: `apps/customer/src/routes/checkout.tsx:41` (branch selection)

**Interfaces:**
- Consumes: `is_online_default` from the catalog (Task 2).
- Produces: checkout picks the flagged branch; no UI change.

- [ ] **Step 1: Add the field to the ApiBranch type**

In `apps/customer/src/lib/api/types.ts`, add to `ApiBranch` (after `phone` on line 49):
```ts
  is_online_default?: boolean;
```
(Optional so older payloads still type-check.)

- [ ] **Step 2: Select the default branch at checkout**

In `apps/customer/src/routes/checkout.tsx`, replace line 41:
```ts
  const branchId = branches[0]?.id ?? null;
```
with:
```ts
  const branchId = (branches.find((b) => b.is_online_default) ?? branches[0])?.id ?? null;
```

- [ ] **Step 3: Verify typecheck + build**

Run: `pnpm --filter @ms/customer typecheck && pnpm --filter @ms/customer build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/customer/src/lib/api/types.ts apps/customer/src/routes/checkout.tsx
git commit -m "feat(checkout): route online orders to the owner-selected default branch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Admin — set the online-default branch from the Branches page

**Files:**
- Modify: `apps/admin/src/routes/owner/branches.tsx` (BranchRow interface + card control)

**Interfaces:**
- Consumes: `PATCH /branches/:id { is_online_default: true }` (Task 2).
- Produces: per-branch "online default" badge + "Make online default" button.

- [ ] **Step 1: Add the field to BranchRow**

In `apps/admin/src/routes/owner/branches.tsx`, add to the `BranchRow` interface (after `closesAt` on line 18):
```ts
  isOnlineDefault: boolean;
```

- [ ] **Step 2: Add a setter that PATCHes and reloads**

Inside `BranchesPage`, after `load`, add:
```ts
  async function makeOnlineDefault(id: string): Promise<void> {
    try {
      await api(`/branches/${id}`, { method: "PATCH", body: JSON.stringify({ is_online_default: true }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
```

- [ ] **Step 3: Show the badge + button on each card**

In the card `<Link>`, just below the `<header>` (after line 101), add a row that doesn't trigger navigation:
```tsx
              <div style={{ marginBottom: 8 }}>
                {b.isOnlineDefault ? (
                  <span className="pill pill--success">★ Online default</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn--subtle btn--sm"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void makeOnlineDefault(b.id);
                    }}
                  >
                    Make online default
                  </button>
                )}
              </div>
```

- [ ] **Step 4: Surface it as a StatHero chip (optional polish)**

In the `chips` array of `StatHero`, add:
```ts
          { label: "Online default", value: rows.find((b) => b.isOnlineDefault)?.name ?? "Not set", tone: rows.find((b) => b.isOnlineDefault) ? "good" : "danger" },
```

- [ ] **Step 5: Verify typecheck + build**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/routes/owner/branches.tsx
git commit -m "feat(admin): set the online-fulfilment default branch from Branches page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Admin — "Awaiting fulfilment" worklist on owner Orders

**Files:**
- Modify: `apps/admin/src/routes/owner/orders.tsx` (StatHero chip + filter)

**Interfaces:**
- Consumes: existing `Sale` rows (`channel`, `status`).
- Produces: an "Awaiting fulfilment" count chip and a one-click filter.

- [ ] **Step 1: Define the predicate**

In `apps/admin/src/routes/owner/orders.tsx`, near the top of `OrdersPage` (after the `sales` state), add:
```ts
  const awaitsFulfilment = (s: Sale): boolean => s.channel === "online" && s.status === "paid";
```

- [ ] **Step 2: Add the count chip**

In the `StatHero` `chips` array, add as the first chip:
```ts
          {
            label: "Awaiting fulfilment",
            value: sales.filter(awaitsFulfilment).length,
            tone: sales.filter(awaitsFulfilment).length > 0 ? "danger" : "good",
          },
```

- [ ] **Step 3: Add an awaiting-fulfilment toggle to the filter state**

Add state `const [onlyAwaiting, setOnlyAwaiting] = useState(false);` and extend the `filtered` useMemo predicate (inside `sales.filter`) with:
```ts
      if (onlyAwaiting && !awaitsFulfilment(s)) return false;
```

- [ ] **Step 4: Add the toggle button to the toolbar**

In the `.toolbar`, before the branch `<select>`, add:
```tsx
        <button
          type="button"
          className={onlyAwaiting ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
          onClick={() => setOnlyAwaiting((v) => !v)}
        >
          Awaiting fulfilment
        </button>
```

- [ ] **Step 5: Verify typecheck + build**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/routes/owner/orders.tsx
git commit -m "feat(admin): awaiting-fulfilment worklist on owner Orders

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Admin — same worklist on branch Sales

**Files:**
- Modify: `apps/admin/src/routes/branch/sales.tsx`

**Interfaces:**
- Consumes: branch sale rows (`channel`, `status`).
- Produces: an "Awaiting fulfilment" chip + filter scoped to the branch.

- [ ] **Step 1: Read the file to confirm its Sale shape and filter pattern**

Run: open `apps/admin/src/routes/branch/sales.tsx`. Confirm rows expose `channel` and `status` (the type at the top of the file). If `channel` is absent from the row type, add it to the interface and to the columns the page already reads from the API response (the API sale row includes `channel`).

- [ ] **Step 2: Add predicate + chip + filter**

Apply the same three edits as Task 5 (predicate `s.channel === "online" && s.status === "paid"`, a count chip on the page's StatHero, and an `onlyAwaiting` toggle wired into the existing row filter). Match this file's existing variable names and JSX style.

- [ ] **Step 3: Verify typecheck + build**

Run: `pnpm --filter @ms/admin typecheck && pnpm --filter @ms/admin build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/routes/branch/sales.tsx
git commit -m "feat(admin): awaiting-fulfilment worklist on branch Sales

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Customer — remove dead Nav Search + Account icons

**Files:**
- Modify: `apps/customer/src/components/Nav.tsx:4` (imports) and `:43-48` (buttons)

**Interfaces:**
- Produces: a nav with no no-op buttons; cart + Order Now unaffected.

- [ ] **Step 1: Remove the two dead buttons**

In `apps/customer/src/components/Nav.tsx`, delete the Search `<button>` (lines 43-45) and the Account `<button>` (lines 46-48).

- [ ] **Step 2: Drop now-unused imports**

On line 4, remove `Search` and `User` from the lucide import (keep `ShoppingCart, ArrowRight, Menu, X`):
```ts
import { ShoppingCart, ArrowRight, Menu, X } from "lucide-react";
```

- [ ] **Step 3: Verify typecheck + build (catches any leftover usage)**

Run: `pnpm --filter @ms/customer typecheck && pnpm --filter @ms/customer build`
Expected: clean, no unused-import or undefined-name errors.

- [ ] **Step 4: Commit**

```bash
git add apps/customer/src/components/Nav.tsx
git commit -m "fix(customer): remove dead Search/Account nav icons (no such features)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Quality gates + fast-forward to prod

**Files:** none (verification + integration).

- [ ] **Step 1: Repo-wide gates**

Run: `pnpm -w lint && pnpm -w typecheck`
Expected: 0 lint errors, clean typecheck.

- [ ] **Step 2: Run the affected API tests**

Run: `TZ=UTC pnpm --filter @ms/api test branch-online-default branches public-catalog`
Expected: PASS. (If a pre-existing unrelated file is flaky per project notes, re-run that file alone to confirm it's not our change.)

- [ ] **Step 3: Apply the migration to a dev DB and eyeball the column**

Run the project's migrate command against `ms_dev` (per repo scripts), then verify:
`SELECT column_name FROM information_schema.columns WHERE table_name='branch' AND column_name='is_online_default';`
Expected: one row.

- [ ] **Step 4: Fast-forward push to master (prod auto-deploys)**

From the worktree:
```bash
git push origin feat/online-fulfilment
git push origin feat/online-fulfilment:master
```
(Or open a PR if review is preferred. Pushing to `master` triggers `deploy.yml`.)

- [ ] **Step 5: Post-deploy verification**

- `curl -s -o /dev/null -w "%{http_code}" https://mrssamuel.com` → 200; admin + api/v1/health → 200/200.
- In admin → Branches, set the online default; confirm the ★ badge.
- Note for the owner: until a default is set, behaviour is unchanged (branches[0]); PWA hard-refresh for the new bundle.

---

## Self-Review

**Spec coverage:** Gap 1 → Task 7. Gap 2 → Tasks 5–6. Gap 3 → Tasks 1–4. Rollout/gates → Task 8. All spec sections mapped.

**Placeholder scan:** Task 6 Step 1 intentionally asks the implementer to read the file first because `branch/sales.tsx` was not fully read during planning; Step 2 names the exact predicate and edits to apply. No "TBD/handle edge cases" placeholders elsewhere.

**Type consistency:** `isOnlineDefault` (drizzle/TS camelCase) vs `is_online_default` (SQL column + JSON API field) used consistently — schema/admin use `isOnlineDefault`; API request/response JSON and customer catalog type use `is_online_default`. The branch PATCH accepts `is_online_default` and maps to `patch["isOnlineDefault"]`. Predicate `awaitsFulfilment` identical in Tasks 5 and 6.

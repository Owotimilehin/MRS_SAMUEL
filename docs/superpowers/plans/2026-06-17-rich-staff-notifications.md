# Rich, Named Telegram Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Telegram notification show the actor's real name, a Lagos timestamp, before→after detail on edits, and flavour/quantity line items on sales.

**Architecture:** Add a nullable `name` column to `admin_user`. Resolve a standard actor block (`actor_name`/`actor_role`/`actor_branch_name`) at the API and stamp it into every outbox payload via a shared `enqueueOutbox` helper (and inside `writeAudit`). Compute a `changes` diff at write time for audited edits, and attach `items` to sale events. The worker keeps message bodies in `format()` and appends a uniform footer (👤 who · 🕒 when) in `drainOutbox`.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres, Hono (API), Vitest + Testcontainers (tests), React (admin UI).

## Global Constraints

- **Migrations:** new `00NN_*.sql` MUST be added to `packages/db/migrations/meta/_journal.json` or migrate/tests skip it; rebuild `@ms/db` (`pnpm --filter @ms/db build`) after schema edits.
- **Display-name rule (single source):** `displayName(u) = u.name?.trim() || u.email.split("@")[0]`. Never show raw UUIDs as identity.
- **Money formatting:** Naira values render as `₦1,800` using `Number(v).toLocaleString()`.
- **Timestamps:** Lagos time only, via the existing `lagosTime()` in `apps/worker/src/outbox.ts`.
- **Graceful degradation:** Old/unstamped events (no `actor_*`, no `items`, no `changes`) must still format without errors — every new field is optional.
- **Commit discipline:** stage explicit pathspecs (`git add -- <paths>`), never `git add -A` (a prior commit swept unrelated dirty files).
- **Branch:** all work on `feat/rich-notifications` (already created).

### Canonical payload contract (all tasks agree on these field names)

Every staff-driven outbox payload carries:
- `actor_name: string | null`
- `actor_role: string | null`  (`owner` | `admin` | `manager` | `branch_staff`)
- `actor_branch_name: string | null`

`audit.logged` additionally carries:
- `changes: Array<{ label: string; from: string; to: string }>`

Sale events (`sale.branch_sold`, `sale.online_placed`, `sale.preorder_fulfilled`) additionally carry:
- `items: Array<{ name: string; size: string; qty: number; line_total_ngn: number }>`

---

## Task 1: Staff `name` column (DB + API)

**Files:**
- Create: `packages/db/migrations/0051_admin_user_name.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Modify: `packages/db/src/schema/admin-user.ts:7` (add field after `email`)
- Modify: `apps/api/src/routes/admin-users.ts` (InviteUser `:30`, PatchUser `:38`, GET select `:62`, insert + patch bodies)
- Test: `apps/api/test/integration/admin-users-name.test.ts` (create)

**Interfaces:**
- Produces: `admin_user.name` column; API `POST /admin/users` and `PATCH /admin/users/:id` accept optional `name`; `GET /admin/users` returns `name`.

- [ ] **Step 1: Write the migration**

Create `packages/db/migrations/0051_admin_user_name.sql`:

```sql
-- Staff display name.
--
-- admin_user previously stored only email/phone/role, so notifications could
-- only ever say "Branch staff" plus an id fragment. Add an optional human name
-- so Telegram alerts can identify who did what. Nullable: existing accounts
-- fall back to their email handle until a name is filled in.
ALTER TABLE "admin_user" ADD COLUMN "name" text;
```

- [ ] **Step 2: Register the migration in the journal**

In `packages/db/migrations/meta/_journal.json`, append to the `entries` array (after the `idx: 49` entry):

```json
    ,{
      "idx": 50,
      "version": "7",
      "when": 1782900000000,
      "tag": "0051_admin_user_name",
      "breakpoints": true
    }
```

(Ensure valid JSON — the new object goes inside the closing `]` of `entries`.)

- [ ] **Step 3: Add the column to the Drizzle schema**

In `packages/db/src/schema/admin-user.ts`, add `name` right after the `email` line (`:7`):

```ts
  email: text("email").notNull().unique(),
  name: text("name"),
  phone: text("phone"),
```

- [ ] **Step 4: Rebuild @ms/db**

Run: `pnpm --filter @ms/db build`
Expected: builds with no type errors.

- [ ] **Step 5: Accept & return `name` in the API**

In `apps/api/src/routes/admin-users.ts`:

Add to `InviteUser` (`:30`):

```ts
const InviteUser = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120).optional(),
  role: RoleEnum,
  branch_id: z.string().uuid().nullable().optional(),
  password: z.string().min(12),
  permission_overrides: Overrides.optional(),
});
```

Add to `PatchUser` (`:38`):

```ts
const PatchUser = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  role: RoleEnum.optional(),
  branch_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
  permission_overrides: Overrides.optional(),
});
```

Add `name: adminUser.name,` to the GET select (after `email:` at `:66`).

In the POST insert values, add `name: body.name ?? null,`. In the PATCH update, include `name` when present: add `...(body.name !== undefined ? { name: body.name } : {}),` to the `.set({...})` object.

- [ ] **Step 6: Write the failing integration test**

Create `apps/api/test/integration/admin-users-name.test.ts`. Mirror the harness used by `apps/api/test/integration/audit.test.ts` (testcontainer + app bootstrap — copy its `beforeAll`/`afterAll` and auth-cookie helper). The test body:

```ts
it("stores and returns the staff name", async () => {
  const res = await invite({ email: "aisha@example.com", name: "Aisha Bello", role: "branch_staff", branch_id: branchId, password: "password12345" });
  expect(res.status).toBe(201);
  const list = await api("/admin/users");
  const row = (await list.json()).data.find((u: any) => u.email === "aisha@example.com");
  expect(row.name).toBe("Aisha Bello");
});
```

(Use the same `invite`/`api` request helpers the audit test uses; if none exist there, build minimal `fetch` wrappers against the running app with the owner session cookie.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @ms/api test admin-users-name`
Expected: PASS (column + API plumbing complete).

- [ ] **Step 8: Commit**

```bash
git add -- packages/db/migrations/0051_admin_user_name.sql packages/db/migrations/meta/_journal.json packages/db/src/schema/admin-user.ts apps/api/src/routes/admin-users.ts apps/api/test/integration/admin-users-name.test.ts
git commit -m "feat(users): add optional name to admin_user (db + api)"
```

---

## Task 2: Admin UI — Full name field

**Files:**
- Modify: `apps/admin/src/routes/owner/users.tsx`

**Interfaces:**
- Consumes: API `name` field from Task 1.
- Produces: invite/edit forms send `name`; list shows name.

- [ ] **Step 1: Add `name` to the row type and table**

In `AdminUserRow` (`:13`) add `name: string | null;` after `email`.

In the table, add a header `<th>Name</th>` before `<th>Email</th>` (`:137`), and a cell before the email cell (`:148`):

```tsx
<td style={{ fontWeight: 600 }}>{u.name?.trim() || u.email.split("@")[0]}</td>
<td style={{ color: "var(--ink-soft)", fontSize: 13 }}>{u.email}</td>
```

(Change the existing email `<td>` to the softer style shown, since name is now the bold primary identifier.)

- [ ] **Step 2: Add name input to InviteModal**

In `InviteModal`, add state `const [name, setName] = useState("");` and a field above the Email field (`:302`):

```tsx
<div className="field">
  <label className="field__label">Full name</label>
  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aisha Bello" />
</div>
```

Add `name: name.trim() || undefined,` to the POST body (`:282`).

- [ ] **Step 3: Add name input to EditUserModal**

In `EditUserModal`, add `const [name, setName] = useState(user.name ?? "");` and a field above the Role grid (`:420`):

```tsx
<div className="field">
  <label className="field__label">Full name</label>
  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aisha Bello" />
</div>
```

Add `name: name.trim() || null,` to the PATCH body (`:403`).

- [ ] **Step 4: Verify the admin app builds**

Run: `pnpm --filter @ms/admin build`
Expected: builds with no type errors; `name` referenced consistently.

- [ ] **Step 5: Commit**

```bash
git add -- apps/admin/src/routes/owner/users.tsx
git commit -m "feat(admin): full-name field on user invite/edit + list"
```

---

## Task 3: `diffChanges` helper (pure)

**Files:**
- Create: `apps/api/src/lib/notify.ts`
- Test: `apps/api/src/lib/notify.test.ts` (create)

**Interfaces:**
- Produces: `export function diffChanges(before: unknown, after: unknown): Array<{ label: string; from: string; to: string }>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/notify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { diffChanges } from "./notify.js";

describe("diffChanges", () => {
  it("reports changed scalar fields with friendly labels", () => {
    const out = diffChanges(
      { priceNgn: 1800, name: "Zobo" },
      { priceNgn: 2000, name: "Zobo" },
    );
    expect(out).toEqual([{ label: "Price", from: "₦1,800", to: "₦2,000" }]);
  });

  it("formats booleans as Yes/No", () => {
    const out = diffChanges({ isActive: true }, { isActive: false });
    expect(out).toEqual([{ label: "Active", from: "Yes", to: "No" }]);
  });

  it("skips noise fields and unchanged values", () => {
    const out = diffChanges(
      { updatedAt: "a", passwordHash: "x", role: "manager" },
      { updatedAt: "b", passwordHash: "y", role: "admin" },
    );
    expect(out).toEqual([{ label: "Role", from: "manager", to: "admin" }]);
  });

  it("returns [] when nothing comparable changed", () => {
    expect(diffChanges({ id: "1" }, { id: "1" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/api test notify`
Expected: FAIL — `diffChanges` not defined / module missing.

- [ ] **Step 3: Implement `diffChanges`**

Create `apps/api/src/lib/notify.ts`:

```ts
/** Fields that are noise in a change log — never surfaced to the owner. */
const SKIP_FIELDS = new Set([
  "id", "createdAt", "updatedAt", "created_at", "updated_at",
  "passwordHash", "password_hash", "mfaSecret", "mfa_secret",
  "deletedAt", "deleted_at", "permissionOverrides", "permission_overrides",
  "failedLoginCount", "failed_login_count", "lockedUntil", "locked_until",
]);

/** Friendly labels for common fields; unknown keys are humanized from the key. */
const LABELS: Record<string, string> = {
  priceNgn: "Price", price_ngn: "Price",
  totalNgn: "Total", total_ngn: "Total",
  amountNgn: "Amount", amount_ngn: "Amount",
  name: "Name", email: "Email", phone: "Phone", role: "Role",
  isActive: "Active", is_active: "Active",
  status: "Status", quantity: "Quantity", sizeMl: "Size (ml)",
  branchId: "Branch", branch_id: "Branch",
};

function humanizeKey(k: string): string {
  return k
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function fmt(key: string, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number" && /ngn$/i.test(key)) return `₦${v.toLocaleString()}`;
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
}

export function diffChanges(
  before: unknown,
  after: unknown,
): Array<{ label: string; from: string; to: string }> {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const out: Array<{ label: string; from: string; to: string }> = [];
  for (const key of Object.keys(a)) {
    if (SKIP_FIELDS.has(key)) continue;
    const bv = b[key];
    const av = a[key];
    if (bv === av) continue;
    // Only diff scalars; skip objects/arrays (too noisy for a chat line).
    if (av !== null && typeof av === "object") continue;
    if (bv !== null && bv !== undefined && typeof bv === "object") continue;
    if (!(key in b)) continue; // only report fields that existed before (true edits)
    out.push({ label: LABELS[key] ?? humanizeKey(key), from: fmt(key, bv), to: fmt(key, av) });
  }
  return out.slice(0, 6);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/api test notify`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/lib/notify.ts apps/api/src/lib/notify.test.ts
git commit -m "feat(notify): diffChanges before/after helper"
```

---

## Task 4: `displayName`, `resolveActor`, `enqueueOutbox` helpers

**Files:**
- Modify: `apps/api/src/lib/notify.ts`
- Test: `apps/api/src/lib/notify.test.ts`

**Interfaces:**
- Consumes: `diffChanges` (Task 3); Drizzle `DbClient`, `adminUser`, `branch`, `outboxEvent` from `@ms/db`; Hono `Context`.
- Produces:
  - `displayName(u: { name?: string | null; email: string }): string`
  - `resolveActor(db, c): Promise<{ actor_name: string|null; actor_role: string|null; actor_branch_name: string|null }>`
  - `enqueueOutbox(exec, c, eventType: string, payload: Record<string, unknown>): Promise<void>` where `exec` is a `DbClient` or transaction.

- [ ] **Step 1: Write the failing test for `displayName`**

Append to `apps/api/src/lib/notify.test.ts`:

```ts
import { displayName } from "./notify.js";

describe("displayName", () => {
  it("uses the name when present", () => {
    expect(displayName({ name: "Aisha Bello", email: "a@x.com" })).toBe("Aisha Bello");
  });
  it("falls back to the email handle", () => {
    expect(displayName({ name: null, email: "aisha@x.com" })).toBe("aisha");
    expect(displayName({ name: "   ", email: "deji@x.com" })).toBe("deji");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ms/api test notify`
Expected: FAIL — `displayName` not exported.

- [ ] **Step 3: Implement the three helpers**

Append to `apps/api/src/lib/notify.ts`:

```ts
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { adminUser, branch, outboxEvent, type DbClient } from "@ms/db";

export function displayName(u: { name?: string | null; email: string }): string {
  return u.name?.trim() || u.email.split("@")[0] || u.email;
}

type Exec = Pick<DbClient, "insert" | "select">;

export interface ActorBlock {
  actor_name: string | null;
  actor_role: string | null;
  actor_branch_name: string | null;
}

/** Resolve the acting admin into the fields every notification needs. */
export async function resolveActor(db: Exec, c: Context): Promise<ActorBlock> {
  const auth = c.get("auth") as { userId: string; role: string; branchId: string | null } | undefined;
  if (!auth) return { actor_name: null, actor_role: null, actor_branch_name: null };
  const [u] = await db.select({ name: adminUser.name, email: adminUser.email })
    .from(adminUser).where(eq(adminUser.id, auth.userId)).limit(1);
  let branchName: string | null = null;
  if (auth.branchId) {
    const [b] = await db.select({ name: branch.name }).from(branch).where(eq(branch.id, auth.branchId)).limit(1);
    branchName = b?.name ?? null;
  }
  return {
    actor_name: u ? displayName(u) : null,
    actor_role: auth.role,
    actor_branch_name: branchName,
  };
}

/** Insert an outbox event with the acting admin stamped onto the payload. */
export async function enqueueOutbox(
  exec: Exec,
  c: Context,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const actor = await resolveActor(exec, c);
  await exec.insert(outboxEvent).values({ eventType, payload: { ...payload, ...actor } });
}
```

(If `branch` is not already exported from `@ms/db`, import it from its schema path used elsewhere in the API — check an existing route that reads branch names, e.g. `daily-close.ts`.)

- [ ] **Step 4: Run to verify the unit test passes**

Run: `pnpm --filter @ms/api test notify`
Expected: PASS (displayName + diffChanges; `resolveActor`/`enqueueOutbox` compile).

- [ ] **Step 5: Build the API to confirm types**

Run: `pnpm --filter @ms/api build`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add -- apps/api/src/lib/notify.ts apps/api/src/lib/notify.test.ts
git commit -m "feat(notify): displayName, resolveActor, enqueueOutbox helpers"
```

---

## Task 5: Wire `writeAudit` to stamp actor + changes

**Files:**
- Modify: `apps/api/src/middleware/audit.ts`
- Test: `apps/api/test/integration/audit.test.ts`

**Interfaces:**
- Consumes: `resolveActor`, `diffChanges` (Tasks 3–4).
- Produces: `audit.logged` payload now includes `actor_name`, `actor_branch_name`, and `changes`.

- [ ] **Step 1: Write/extend the failing test**

In `apps/api/test/integration/audit.test.ts`, add a test that performs an edit as a named user and asserts the enqueued `audit.logged` row carries the name + changes. Pattern:

```ts
it("audit.logged carries actor name and before→after changes", async () => {
  // given an admin named "Aisha Bello" who edits a product's price 1800 → 2000
  // (reuse the suite's existing create-user + login helpers)
  const ev = await latestOutbox("audit.logged");
  expect(ev.payload.actor_name).toBe("Aisha Bello");
  expect(ev.payload.actor_role).toBeTruthy();
  expect(ev.payload.changes).toEqual(
    expect.arrayContaining([{ label: "Price", from: "₦1,800", to: "₦2,000" }]),
  );
});
```

(`latestOutbox(type)` = select most recent `outbox_event` of that type, ordered by `createdAt desc`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ms/api test audit`
Expected: FAIL — `actor_name`/`changes` undefined on payload.

- [ ] **Step 3: Update `writeAudit`**

In `apps/api/src/middleware/audit.ts`:

Add imports at top:

```ts
import { resolveActor, diffChanges } from "../lib/notify.js";
```

Replace the `outboxEvent` insert block (`:112-124`) with:

```ts
  const shouldNotify = ctx.notify ?? !SKIP_NOTIFY.has(ctx.action);
  if (shouldNotify) {
    const actor = await resolveActor(db, c);
    await db.insert(outboxEvent).values({
      eventType: "audit.logged",
      payload: {
        action: ctx.action,
        entity_type: ctx.entityType,
        entity_id: ctx.entityId,
        entity_noun: ENTITY_NOUN[ctx.entityType] ?? ctx.entityType.replace(/_/g, " "),
        identifier: identifierOf(ctx.after, ctx.before),
        changes: diffChanges(ctx.before, ctx.after),
        ...actor,
      },
    });
  }
```

(The `actor.actor_role` replaces the previous hand-rolled `actor_role` line; remove the now-unused local `actor` role-only reference if it conflicts — keep the `auth`/`actor` used for the `auditLog` insert above untouched, only the outbox block changes. Rename the new const if `actor` collides: use `actorBlock`.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @ms/api test audit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- apps/api/src/middleware/audit.ts apps/api/test/integration/audit.test.ts
git commit -m "feat(audit): stamp actor name + before→after changes on audit.logged"
```

---

## Task 6: Worker — footer on every message + audit.logged renders changes

**Files:**
- Modify: `apps/worker/src/outbox.ts`
- Test: `apps/worker/test/outbox.test.ts`

**Interfaces:**
- Consumes: payload `actor_name`/`actor_role`/`actor_branch_name`/`changes` (Tasks 4–5).
- Produces: `export function appendFooter(text: string, payload, createdAt?): string`; `format()` for `audit.logged` renders change lines.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/test/outbox.test.ts`:

```ts
describe("appendFooter", () => {
  it("adds the actor and Lagos time", async () => {
    const { appendFooter } = await import("../src/outbox.js");
    const out = appendFooter("body", {
      actor_name: "Aisha Bello", actor_role: "branch_staff", actor_branch_name: "Ajao",
    }, "2026-06-17T14:42:00.000Z");
    expect(out).toContain("body");
    expect(out).toContain("Aisha Bello");
    expect(out).toContain("Branch staff");
    expect(out).toContain("Ajao");
    expect(out).toMatch(/🕒/);
  });
  it("omits the actor line when no actor is present", async () => {
    const { appendFooter } = await import("../src/outbox.js");
    const out = appendFooter("body", {});
    expect(out).toBe("body");
  });
});

describe("audit.logged formatting", () => {
  it("renders before→after change lines", async () => {
    const { format } = await import("../src/outbox.js");
    const { text } = format({
      eventType: "audit.logged",
      payload: {
        action: "product.update", entity_noun: "Product", identifier: "Zobo",
        changes: [{ label: "Price", from: "₦1,800", to: "₦2,000" }],
      },
    });
    expect(text).toContain("Product");
    expect(text).toContain("Zobo");
    expect(text).toContain("Price: ₦1,800 → ₦2,000");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ms/worker test outbox`
Expected: FAIL — `appendFooter` undefined; change lines missing.

- [ ] **Step 3: Add `roleLabel` + `appendFooter`**

In `apps/worker/src/outbox.ts`, after `lagosTime` (`:34`):

```ts
function roleLabel(role: string): string {
  return role.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/**
 * Append the uniform "who · when" footer to a message body. Degrades to the
 * bare body when the event carries no actor (webhook/system events).
 */
export function appendFooter(
  text: string,
  payload: Record<string, unknown>,
  createdAt?: Date | string,
): string {
  if (!text) return text;
  const lines: string[] = [];
  const who: string[] = [];
  if (payload["actor_name"]) who.push(String(payload["actor_name"]));
  if (payload["actor_role"]) who.push(roleLabel(String(payload["actor_role"])));
  if (payload["actor_branch_name"]) who.push(String(payload["actor_branch_name"]));
  if (who.length) lines.push(`👤 ${who.join(" · ")}`);
  if (createdAt) lines.push(`🕒 ${lagosTime(typeof createdAt === "string" ? createdAt : createdAt.toISOString())}`);
  return lines.length ? `${text}\n${lines.join("\n")}` : text;
}
```

- [ ] **Step 4: Render changes in the `audit.logged` case**

In `format()` `audit.logged` case (`:362-394`), after computing `identifier`/`role`, build a changes block and append it before the link. Replace the final `return` of that case with:

```ts
      const changes = Array.isArray(p["changes"]) ? (p["changes"] as Array<{ label: string; from: string; to: string }>) : [];
      const changeLines = changes.slice(0, 6).map((c) => `• ${c.label}: ${c.from} → ${c.to}`).join("\n");
      const more = changes.length > 6 ? `\n…and ${changes.length - 6} more` : "";
      const body = `📝 *${noun} ${verb}*${identifier}`
        + (changeLines ? `\n${changeLines}${more}` : "")
        + `\n👉 ${ADMIN_URL}/owner/audit-log`;
      return { chatIds: [owner], text: body };
```

(Remove the now-unused `role` suffix variable from this case — the actor is shown by the footer instead.)

- [ ] **Step 5: Apply the footer in `drainOutbox`**

In `drainOutbox`, where it computes `const { chatIds, text } = format(ev);` (`:422`), change to apply the footer:

```ts
      const { chatIds, text: body } = format(ev);
      const text = appendFooter(body, ev.payload as Record<string, unknown>, ev.createdAt);
```

- [ ] **Step 6: Run to verify tests pass**

Run: `pnpm --filter @ms/worker test outbox`
Expected: PASS (new + existing tests green).

- [ ] **Step 7: Commit**

```bash
git add -- apps/worker/src/outbox.ts apps/worker/test/outbox.test.ts
git commit -m "feat(worker): uniform actor/time footer + audit.logged change lines"
```

---

## Task 7: Sale events carry flavour + quantity line items

**Files:**
- Modify: `apps/api/src/routes/sales.ts` (`sale.branch_sold`, `:422`)
- Modify: `apps/api/src/routes/public-orders.ts` (`sale.online_placed`, `:466`)
- Modify: `apps/api/src/routes/preorders.ts` (`sale.preorder_fulfilled`, `:155`)
- Modify: `apps/worker/src/outbox.ts` (render `items` in those cases)
- Test: `apps/worker/test/outbox.test.ts`

**Interfaces:**
- Consumes: `saleOrderItem`, `product`, `productVariant` from `@ms/db`.
- Produces: those three events carry `items: Array<{ name; size; qty; line_total_ngn }>`; worker renders item lines.

- [ ] **Step 1: Write the failing worker test**

Append to `apps/worker/test/outbox.test.ts`:

```ts
describe("sale.branch_sold item lines", () => {
  it("lists flavour, size and quantity", async () => {
    const { format } = await import("../src/outbox.js");
    const { text } = format({
      eventType: "sale.branch_sold",
      payload: {
        sale_order_id: "s1", order_number: "ORD-00123", total_ngn: 4200, channel: "pos",
        items: [
          { name: "Zobo", size: "50cl", qty: 2, line_total_ngn: 1600 },
          { name: "Pineapple", size: "35cl", qty: 3, line_total_ngn: 2600 },
        ],
      },
    });
    expect(text).toContain("ORD-00123");
    expect(text).toContain("2× Zobo 50cl");
    expect(text).toContain("3× Pineapple 35cl");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ms/worker test outbox`
Expected: FAIL — item lines absent.

- [ ] **Step 3: Add a shared item-line renderer + use it in the sale cases**

In `apps/worker/src/outbox.ts`, add near the other helpers:

```ts
function itemLines(payload: Record<string, unknown>): string {
  const items = Array.isArray(payload["items"])
    ? (payload["items"] as Array<Record<string, unknown>>) : [];
  if (!items.length) return "";
  const lines = items.slice(0, 8).map((it) => {
    const qty = Number(it["qty"] ?? 0);
    const name = String(it["name"] ?? "?");
    const size = it["size"] ? ` ${String(it["size"])}` : "";
    const lt = it["line_total_ngn"] != null ? ` — ₦${Number(it["line_total_ngn"]).toLocaleString()}` : "";
    return `• ${qty}× ${name}${size}${lt}`;
  });
  const more = items.length > 8 ? `\n…and ${items.length - 8} more` : "";
  return `\n${lines.join("\n")}${more}`;
}
```

Update the `sale.branch_sold` case (`:218`) to insert `itemLines(event.payload)` after the order line:

```ts
    case "sale.branch_sold":
      return {
        chatIds: [owner],
        text:
          `🛒 *Branch sale*\n` +
          `${p["order_number"]} · ₦${p["total_ngn"]} · ${p["channel"]}` +
          itemLines(event.payload) +
          `\n👉 ${ADMIN_URL}/branch/sales/${p["sale_order_id"]}`,
      };
```

Apply the same `itemLines(event.payload)` insertion to the `sale.online_placed` case (after the customer line) and the `sale.preorder_fulfilled` case (after the order/channel line).

- [ ] **Step 4: Run to verify the worker test passes**

Run: `pnpm --filter @ms/worker test outbox`
Expected: PASS.

- [ ] **Step 5: Build the line-item payload in `sales.ts`**

In `apps/api/src/routes/sales.ts` `/pay` handler, before the `outboxEvent` insert (`:421`), gather items inside the transaction (the order's items are already used at `:368` for non-preorder; for preorder fetch them too). Add:

```ts
      const itemRows = await tx
        .select({
          qty: saleOrderItem.quantity,
          lineTotal: saleOrderItem.lineTotalNgn,
          name: product.name,
          sizeMl: productVariant.sizeMl,
        })
        .from(saleOrderItem)
        .leftJoin(product, eq(product.id, saleOrderItem.productId))
        .leftJoin(productVariant, eq(productVariant.id, saleOrderItem.variantId))
        .where(eq(saleOrderItem.saleOrderId, id));
      const items = itemRows.map((r) => ({
        name: r.name ?? "Item",
        size: r.sizeMl ? `${r.sizeMl}ml` : "",
        qty: r.qty,
        line_total_ngn: r.lineTotal,
      }));
```

Add `items` to the `sale.branch_sold` payload (`:424`):

```ts
        payload: {
          sale_order_id: u.id,
          order_number: u.orderNumber,
          total_ngn: u.totalNgn,
          channel: u.channel,
          items,
        },
```

Ensure `product`, `productVariant`, `saleOrderItem` are imported in `sales.ts` (productVariant + saleOrderItem already are; add `product` to the `@ms/db` import if missing).

- [ ] **Step 6: Build the same payload in `public-orders.ts` and `preorders.ts`**

In each, fetch the order's items with the same flavour/size join (using `tx` if inside a transaction, else `db`) and add the `items` array to the respective payload (`sale.online_placed`, `sale.preorder_fulfilled`). Use the identical mapping shape.

- [ ] **Step 7: Build the API**

Run: `pnpm --filter @ms/api build`
Expected: no type errors.

- [ ] **Step 8: Commit**

```bash
git add -- apps/worker/src/outbox.ts apps/worker/test/outbox.test.ts apps/api/src/routes/sales.ts apps/api/src/routes/public-orders.ts apps/api/src/routes/preorders.ts
git commit -m "feat(notify): sale events carry flavour + quantity line items"
```

---

## Task 8: Stamp actor on the remaining staff-driven events

**Files:**
- Modify: `apps/api/src/routes/transfers.ts` (`:338, :380, :497, :618, :720`)
- Modify: `apps/api/src/routes/daily-close.ts` (`:102`)
- Modify: `apps/api/src/routes/inventory.ts` (`:161`)
- Modify: `apps/api/src/routes/packaging.ts` (`:227, :340`)
- Modify: `apps/api/src/routes/production-runs.ts` (`:231`)
- Modify: `apps/api/src/routes/returns.ts` (`:206`)
- Modify: `apps/api/src/routes/sales.ts` (`sale.branch_sold` — convert to helper)

**Interfaces:**
- Consumes: `enqueueOutbox` (Task 4).
- Produces: each staff-driven event payload now carries the actor block, so the worker footer shows who did it everywhere.

> Public/webhook/system events (`sale.online_placed`, `sale.amount_mismatch`, `delivery.*`, `contact.message_received`, `subscription.*`, `payment.refund_request`) have NO admin actor and are intentionally left as raw inserts — the footer omits the actor line for them.

- [ ] **Step 1: Convert each staff-driven emit site to `enqueueOutbox`**

For each file/line above, replace the `await <tx|db>.insert(outboxEvent).values({ eventType: "X", payload: {...} })` with:

```ts
await enqueueOutbox(<tx|db>, c, "X", { ...payload-without-eventType });
```

Add `import { enqueueOutbox } from "../lib/notify.js";` to each file. Keep the exact same payload fields; `enqueueOutbox` merges the actor block in. Where the insert is inside a transaction, pass the transaction handle as `exec`. The Hono `Context` `c` is in scope in all these route handlers.

For `sales.ts` `sale.branch_sold`, replace the `tx.insert(outboxEvent)` added in Task 7 with `enqueueOutbox(tx, c, "sale.branch_sold", { sale_order_id: u.id, order_number: u.orderNumber, total_ngn: u.totalNgn, channel: u.channel, items })`.

- [ ] **Step 2: Build the API**

Run: `pnpm --filter @ms/api build`
Expected: no type errors (every converted site compiles; `c` in scope everywhere).

- [ ] **Step 3: Run the API test suite for the touched routes**

Run: `pnpm --filter @ms/api test transfers daily-close inventory packaging production returns sales`
Expected: PASS (or the known testcontainer beforeAll timeout under load — re-run a single file to confirm it's not a real failure, per the quality-gates note).

- [ ] **Step 4: Commit**

```bash
git add -- apps/api/src/routes/transfers.ts apps/api/src/routes/daily-close.ts apps/api/src/routes/inventory.ts apps/api/src/routes/packaging.ts apps/api/src/routes/production-runs.ts apps/api/src/routes/returns.ts apps/api/src/routes/sales.ts
git commit -m "feat(notify): stamp actor on transfer/close/inventory/packaging/production/returns/sale events"
```

---

## Task 9: Full verification + lint/typecheck gate

**Files:** none (verification only)

- [ ] **Step 1: Lint + build the whole repo**

Run: `pnpm -r lint && pnpm -r build`
Expected: 0 lint errors, all packages build.

- [ ] **Step 2: Run worker + api notify-related tests**

Run: `pnpm --filter @ms/worker test && pnpm --filter @ms/api test notify audit admin-users-name`
Expected: PASS.

- [ ] **Step 3: Manual payload sanity (optional, local stack)**

If the local stack is running, perform one branch sale and one product price edit, then read the newest two `outbox_event` rows and confirm `actor_name`, `items`/`changes` are present. (See `reference_local_run` memory for booting the stack.)

- [ ] **Step 4: Final commit if any lint fixes were needed**

```bash
git add -- <only files changed by lint>
git commit -m "chore: lint fixes for notifications work"
```

---

## Self-Review notes (author)

- **Spec coverage:** names (T1–T2), actor everywhere (T4,T5,T8 + footer T6), before→after (T3,T5,T6), Lagos time (T6), sale flavour/qty (T7), graceful fallback for old/webhook events (T6 footer, T7 itemLines guards). ✓
- **Type consistency:** payload field names (`actor_name`/`actor_role`/`actor_branch_name`/`changes`/`items`) used identically across producer (api) and consumer (worker) tasks; `displayName`/`resolveActor`/`enqueueOutbox`/`diffChanges`/`appendFooter`/`itemLines` signatures match across tasks. ✓
- **Open risk to watch during execution:** the exact import path for `branch` schema in `notify.ts` and whether `c` (Context) is in scope at every transfer/packaging emit site — verify per file in Task 8 Step 1; if an emit site is inside a helper without `c`, thread the actor block in from the handler instead.

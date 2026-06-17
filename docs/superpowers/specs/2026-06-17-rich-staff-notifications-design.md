# Rich, named Telegram notifications — design

**Date:** 2026-06-17
**Status:** Approved (brainstorming)

## Problem

Owner's Telegram notifications are vague and impersonal:

- They read **"Branch staff — fa3643e3"** instead of the person's name. Root cause:
  `admin_user` has **no name column at all** (only `email`, `phone`, `role`), so the
  generic `audit.logged` formatter (`apps/worker/src/outbox.ts:362`) can only print the
  role plus a fallback ID fragment.
- Most actions fall through to that one **generic `audit.logged` one-liner**, which
  throws away the `before`/`after` detail the audit row already captured.
- **Sale events carry no line items** — `sale.branch_sold` payload (`apps/api/src/routes/sales.ts:422`)
  is only `order_number / total / channel`. The owner can't see *what* was sold.
- **Actor identity is not carried** into the dedicated events (transfers, shift-end, etc.).

## Goals

1. Identify people by **real name**, falling back to the email handle for accounts that
   have no name yet.
2. Reshape **every** notification to a consistent, detailed format: who · role · branch,
   Lagos timestamp, deep link.
3. Generic edit notifications show a **before→after diff** of the key changed fields.
4. Sale notifications carry **flavour + can size + quantity** line items.

## Non-goals

- No change to the audit-log table structure or the admin audit-log UI rendering beyond
  what's needed to surface names.
- No new notification *channels* or recipients; same owner/branch/factory routing.

## Design

### A. Staff names (data + UI)

- **Migration `0051_admin_user_name.sql`**: `ALTER TABLE admin_user ADD COLUMN name text;`
  (nullable). Add to `migrations/meta/_journal.json`; rebuild `@ms/db`.
- **Schema** `packages/db/src/schema/admin-user.ts`: add `name: text("name")`.
- **API** `apps/api/src/routes/admin-users.ts`:
  - `InviteUser` and `PatchUser` accept optional `name` (string, trimmed, max ~120).
  - `GET /` returns `name`.
- **Admin UI** user invite/edit forms: add a "Full name" field; show `name` (falling back
  to email) in the user list.
- **Display rule (single source):** a `displayName(user)` helper returns
  `name?.trim() || email.split("@")[0]`. Used by the actor resolver below.

### B. Actor stamping at the source

New `apps/api/src/lib/actor.ts`:

```ts
// Resolves the acting user into the fields every notification needs.
// One lookup per request (memoized on the Hono context).
export async function resolveActor(db, c): Promise<{
  actor_name: string | null;      // displayName(user) — name || email-prefix
  actor_role: string | null;      // owner | admin | manager | branch_staff
  actor_branch_name: string | null;
}>
```

- `writeAudit` (`apps/api/src/middleware/audit.ts`) calls `resolveActor` and embeds
  `actor_name`, `actor_role`, `actor_branch_name` into the `audit.logged` payload
  (replacing the bare `actor_role`). It also computes a **changes** array (see D).
- A thin `enqueueOutbox(tx|db, eventType, payload, actor)` helper merges the same three
  actor fields into the payload for the dedicated event emitters (sale, transfer,
  daily-close, production, etc.), so identity is uniform everywhere.

### C. Worker formatter overhaul (`apps/worker/src/outbox.ts`)

- Shared **`footer(p)`** appended to every message:

  ```
  👤 <actor_name> · <role label>[· <branch>]
  🕒 <Tue 17 Jun, 3:42 PM>   (Lagos time, from event createdAt)
  👉 <deep link>
  ```

  Role label humanized (`branch_staff` → `Branch staff`). Branch line omitted when null.
  Footer fields degrade gracefully when an event predates this change.
- `lagosTime` already exists; reuse it. The event's `createdAt` is the timestamp source.
- **`audit.logged`** renders the `changes` array as `• <Label>: <from> → <to>` lines
  (max ~6, "+N more"), above the footer.

### D. Before→after diff (computed at write time)

In `writeAudit`, a small `diffChanges(before, after)`:

- Compares **top-level scalar** fields present in both objects.
- **Skip-list:** `id`, `createdAt`, `updatedAt`, `created_at`, `updated_at`,
  `passwordHash`, `password_hash`, `mfaSecret`, `deletedAt`, internal hashes.
- **Label map** for friendly names (`priceNgn` → "Price", `isActive` → "Active",
  `role` → "Role", `name` → "Name", …); unknown keys humanized from snake/camel case.
- Money-ish fields (`*Ngn`/`*_ngn`) formatted `₦1,800`. Booleans → Yes/No.
- Result: `changes: Array<{ label: string; from: string; to: string }>`; capped to keep
  payloads small. Empty array ⇒ formatter shows just the verb line.

### E. Sale line items in payload

At each sale-event enqueue site, gather items with flavour name + can size + quantity:

- Sites: `sales.ts` (`sale.branch_sold`), `webhooks-payaza.ts` / `public-orders.ts`
  (`sale.paid_online`, `sale.online_placed`), `preorders.ts` (preorder paid/fulfilled).
- Build `items: Array<{ name, size, qty, line_total_ngn }>` by joining
  `sale_order_item` → `product` (flavour name) → `product_variant` (size label).
- Formatter renders:

  ```
  🛒 Branch sale — ORD-00123 · ₦4,200 · pos
  • 2× Zobo 50cl — ₦1,600
  • 3× Pineapple 35cl — ₦2,600
  👤 Aisha Bello · Branch staff · Ajao
  🕒 Tue 17 Jun, 3:42 PM
  👉 <link>
  ```

  Cap at ~8 lines with "+N more".

## Testing (TDD on the pure pieces)

- `diffChanges`: scalar diff, skip-list, money/boolean formatting, label mapping.
- `resolveActor`/`displayName`: name present → name; name null → email prefix.
- Worker `format()` (extend `apps/worker/test/outbox.test.ts`):
  - `audit.logged` with `changes` + actor → diff lines + footer.
  - `sale.branch_sold` with `items` → item lines + footer.
  - graceful fallback when actor/items absent (old events).
- Migration applied and journaled; `@ms/db` rebuilt; typecheck + lint clean.

## Rollout

- Feature branch off current work; merge to `master` triggers auto-deploy (deploy.yml).
- Migration `0051` must be applied on prod (every `product_variant`/`admin_user` query
  depends on the column once schema ships).
- Existing pending outbox events render with graceful fallbacks (no actor/items) — no
  backfill needed.

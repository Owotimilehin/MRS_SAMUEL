# Shift-Session Lifecycle + Fulfilment Metric — Design

**Date:** 2026-06-20
**Status:** Approved (design); ready for implementation planning
**Branch:** `feat/shift-lifecycle` (off `master` @ ff80fa6)

## Problem

The POS "shift" is not a real session. `shift_open` and `daily_close` are each **one row per (branch, calendar-date)** with a UNIQUE constraint, so:

- There is no open/closed *state*. "Opening" just files today's stock count; "closing" just files today's reconciliation.
- The close endpoint upserts on `(branch, date)`, so a branch can **"close" repeatedly** in a day, and **nothing stops sales after a close** — close is not conclusive.
- Sales gating is thin: only **branch_staff** selling **stock** are blocked until today's opening count exists (`stockSaleBlocked = canSellStock && !isOwner && opened === false`). Owners bypass, preorders bypass, and once "opened" it stays open all day.

The owner wants a robust lifecycle: **open a shift to start selling → sales blocked with no open shift → one conclusive close → prompt to open the next shift**, with multiple shifts possible per day.

Separately, the dashboard's **`Orders pending` = 173** is wrong: it counts `paid`/`handed_over` walk-up sales, which are *fulfilled*. The owner wants an **awaiting-fulfilment** count instead.

## Decisions (confirmed)

1. **Shift scope:** per **branch/till** — at most one open shift per branch at a time; `opened_by`/`closed_by` recorded for accountability. No per-person sales attribution within a shift.
2. **Who is gated:** **everyone at the till** (owner/admin/manager/branch_staff). No open shift ⇒ no till sale (walk-up **or** preorder).
3. **Open/close ceremonies:** reuse the **existing opening stock count** (open) and **existing cash/transfer + closing-count reconciliation** (close), now session-scoped and repeatable per day.
4. **Reconciliation window:** per **shift window** (sales with `created_at_local` in `[opened_at, closed_at)`), not the whole calendar day.
5. **Fulfilment metric:** `awaiting_fulfilment = sale_order where is_preorder = true AND fulfilled_at IS NULL AND status NOT IN ('cancelled','failed')`.

## Scope

**Phase 1 (small, independent — ship first):** dashboard fulfilment metric fix.

**Phase 2 (the feature):** shift-session lifecycle.

**Out of scope (YAGNI):**
- Per-cashier shifts / per-person sales attribution.
- Linking each `sale_order` to a `shift_id` column — reconciliation uses the time window instead (one open shift per branch makes the window unambiguous). Avoids touching sale-creation + offline sale payloads.
- Multi-till-per-branch conflict resolution (the model assumes one till device per branch; server enforces the one-open-shift invariant on sync).
- Customer storefront orders — they are not branch-till sales and are never gated by a branch shift.

## Phase 1 — Fulfilment metric

In `GET /reports/overview` (`apps/api/src/routes/reports.ts`, fulfilment block), replace the `orders_pending` query:

```sql
-- OLD (counts fulfilled walk-up sales):
SELECT COUNT(*) FROM sale_order
WHERE is_preorder = false AND status IN ('confirmed','paid','handed_over','out_for_delivery')

-- NEW awaiting_fulfilment:
SELECT COUNT(*) FROM sale_order
WHERE is_preorder = true AND fulfilled_at IS NULL
  AND status NOT IN ('cancelled','failed')
```

Rename the response field `fulfilment.orders_pending` → `fulfilment.awaiting_fulfilment`. Update the dashboard (`apps/admin/src/routes/owner/dashboard.tsx`) operational strip: the tile becomes **"Awaiting fulfilment"** with hint `${preorders_open} open preorders`. The `preorders_open` and `bags_queue` and `pending_transfers` fields are unchanged. Update `reports-overview.test.ts` to assert the new field name + that fulfilled/walk-up orders do not count.

> Note: `awaiting_fulfilment` and `preorders_open` will now be closely related (both about preorders). Keep both: `preorders_open` already counts `is_preorder=true AND status IN ('confirmed','paid','handed_over','out_for_delivery')`; `awaiting_fulfilment` is the stricter "not yet fulfilled" cut. The dashboard tile uses `awaiting_fulfilment`.

## Phase 2 — Shift-session lifecycle

### Data model (migration `0053_shift_session.sql`)

Promote `shift_open` into the session; link the close to it.

`shift_open` — add:
- `status text NOT NULL DEFAULT 'open'` (values `'open'` | `'closed'`; enforced by a CHECK or a pg enum `shift_status`).
- `closed_at timestamptz NULL`
- `closed_by_user_id uuid NULL REFERENCES admin_user(id)`
- `shift_number integer NOT NULL DEFAULT 1` (sequence per branch per business_date)
- **Drop** `unique (branch_id, business_date)`.
- **Add** partial unique index `uq_shift_open_one_open_per_branch` `ON shift_open (branch_id) WHERE status = 'open'` — enforces at most one open shift per branch.

`daily_close` — add:
- `shift_id uuid NULL REFERENCES shift_open(id)` (the shift this close finalizes).
- **Drop** `unique (branch_id, business_date)`.

**Backfill (idempotent):** for each existing `shift_open`, set `status='closed'`, `closed_at = dc.submitted_at`, `closed_by_user_id = dc.submitted_by_user_id` when a `daily_close` exists for the same `(branch_id, business_date)`, else leave `status='open'`; set `daily_close.shift_id` = the matching `shift_open.id` by `(branch_id, business_date)`; `shift_number = 1` for all existing rows. (Prod transactional data was wiped to a fresh slate, so this mostly affects future data; it must still be correct.)

Add the migration to `migrations/meta/_journal.json` (idx 52) and rebuild `@ms/db`.

Add `shiftStatus` to `@ms/db` schema (`shift-open.ts`): the new columns + a pg enum or text. Export a small helper or just query in routes.

### API

**`POST /branches/:branchId/shift-open`** (open / re-count):
- If an `open` shift exists for the branch: this is a **re-count** of that shift — update its counts (current upsert-of-counts behavior), keep it open. Do NOT create a second shift.
- If no open shift exists: **INSERT a new shift** (`status='open'`, `shift_number = COALESCE(MAX(shift_number) for branch+today, 0) + 1`, `opened_at`, `opened_by`). Then write counts.
- Remove the `onConflictDoUpdate` on `(branch, business_date)`; replace with the "find open shift" logic above. The partial unique index is the backstop (two concurrent opens → second errors → surface as `409 shift_already_open`).
- Audit + `shift_open.submitted` outbox unchanged.

**`POST /daily-close`** (close — conclusive):
- Find the branch's **open** shift. If none → `409 no_open_shift` ("no open shift to close").
- If the open shift already has a submitted `daily_close` → impossible (close sets it closed), but guard: if status already `closed` → `409 shift_already_closed`.
- Insert a `daily_close` (status `submitted`) with `shift_id = openShift.id`; reconciliation computed over the **shift window** (see domain below). In the same transaction, set the shift `status='closed'`, `closed_at = now`, `closed_by_user_id`. Remove the `onConflictDoUpdate` on `(branch, business_date)`.
- Existing `daily_close.submitted` outbox + audit unchanged (add `shift_id` to payload).

**Sales gating** (`apps/api/src/routes/sales.ts`, the create path `POST /`):
- Before creating any till sale (walk-up or preorder), require an `open` shift for `body.branch_id`/scoped branch. If none → `409 no_open_shift` ("Open a shift before selling"). Applies to **all** capabilities. (Preorder-only creation by admin/manager via `pos.preorder` is also gated — they too need an open shift at the till.)
- This replaces the old branch_staff-only opening-count gate on the server. (The opening count itself is still required to *open* a shift, so the count discipline remains.)

**`GET /daily-close/:id`** and **preview**: join the shift via `daily_close.shift_id` (not `(branch, date)`). Where a shift's reconciliation/preview is computed, use the shift window.

### Domain (`packages/domain/src/daily-close.ts`)

Add shift-window variants used by close submit + preview:
- `expectedCashForShift(tx, branchId, openedAt, closedAt)` and `cashSalesForShift(...)` — same logic as the `*ForDay` functions but filtering `created_at_local` to `[openedAt, closedAt)` instead of the calendar day. Keep the `*ForDay` functions (still used by day-bucketed reports) or refactor the day ones to delegate to a window. Prefer a shared internal `(...window...)` core to avoid duplication.

### Offline POS (`apps/admin/src/sync/` + `apps/admin/src/routes/branch/`)

Local shift state must reflect open/closed and survive offline, replacing the today-only `isOpenedToday` marker.

- **Local store (Dexie `local`):** add a `currentShift` record per branch: `{ branchId, shiftOpenLocalId, openedAt, status }`. Set `status='open'` on local open; clear/`'closed'` on local close.
- **`hasOpenShift(branchId): Promise<boolean>`** — true iff the local `currentShift` for the branch is `open` (or the last server pull says an open shift exists). Replaces `isOpenedToday` for sell gating.
- **Open offline** (`fileLocalShiftOpen`): also write/refresh the `currentShift` (status open) in the same transaction as the marker + outbox POST.
- **Close offline:** new `fileLocalShiftClose(branchId, ...)` — set `currentShift.status='closed'` (or delete it) and enqueue the close POST. After this, `hasOpenShift` is false → sell screen shows the reopen prompt.
- **Sync pull** (`/sync/pull`): include the branch's current open-shift state (`open_shift: { id, opened_at } | null`) so the local mirror heals across devices/reinstalls. Mirror into `local.meta`/`currentShift` on pull.

### POS UI (`apps/admin/src/routes/branch/`)

- **`sell.tsx`:** gate **all** checkout on `hasOpenShift(branchId)` (not just stock by branch_staff). When no open shift: show the "Start your shift / Open a shift to start selling" panel (extend the existing "Start your shift" block, which currently only shows for branch_staff missing the opening count) with a CTA to `/branch/shift-start`. Remove the `canSellStock && !isOwner && opened===false` special-case; the gate is now universal `!hasOpenShift`.
- **`shift-start.tsx`:** opening files the count and opens the session (calls `fileLocalShiftOpen`, which now also sets `currentShift`). If a shift is already open, route to Sell (or to close) rather than re-opening.
- **`close.tsx`:** closing is conclusive — on success, the local `currentShift` clears and the screen shows "Shift closed" with an **"Open a new shift"** CTA → `/branch/shift-start`. Block the close action if there is no open shift.
- **`closes.tsx`:** the list now shows multiple shift-end rows per day (no longer one-per-day); show `shift_number` / opened→closed times.

### Reporting ripple

- `daily-close` detail/preview: join by `shift_id`.
- Day-bucketed reports (`/reports/revenue`, `/reports/timeseries`, `/reports/variances`, `/reports/overview`) are unaffected — they bucket sales by date, not by shift, and `shift_open` keeps `business_date`.

## Error handling

- `no_open_shift` (409) on sale create and on close-with-no-open-shift.
- `shift_already_open` (409) if a second open is attempted concurrently (partial-unique backstop).
- Offline: sell screen blocks gracefully (CTA), never errors; open/close enqueue and sync later.
- Migration backfill must be safe to re-run (idempotent `UPDATE ... WHERE`).

## Testing

- **Domain unit:** `expectedCashForShift`/`cashSalesForShift` window filtering (sale just before `opened_at` excluded; within window included; at/after `closed_at` excluded).
- **API integration:**
  - shift-open: first open creates shift (status open, shift_number 1); second open while open = re-count (no new shift); opening after a close creates shift_number 2.
  - sales: create returns `409 no_open_shift` when no open shift; succeeds with one open.
  - daily-close: close with no open shift → 409; close sets shift `closed` + links `shift_id`; second close → 409 (conclusive); reconciliation uses the shift window.
  - overview (Phase 1): `awaiting_fulfilment` counts an unfulfilled preorder, excludes a paid walk-up and a fulfilled preorder.
- **Permissions:** sale gating applies to owner too (owner with no open shift → 409).

## Migration / rollout notes

- Migration `0053_shift_session.sql` — **number collision** with the concurrent `feat/size-aware-shift-counts` branch's `0053_shift_counts_variant.sql`. Whichever merges to master second must renumber (and re-order the journal). Both touch shift tables — coordinate the merge.
- Admin is a PWA — existing tills must hard-refresh to load the new bundle. On first load post-deploy a branch will have **no open shift** and must open one before selling (expected, matches the new model).
- The offline `currentShift` is new local state; the `/sync/pull` open-shift field heals devices that were offline during the cutover.

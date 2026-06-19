# Shift start: opening stock count + till open-gate

**Date:** 2026-06-19
**Branch:** build on `feat/till-preorder-and-bulk-stock` (current), which already reworked the
preorder model (auto-preorder on stock shortfall; branch preorder routes gated `pos.sell`).
**Status:** approved design, pending spec review → implementation plan.

## Problem

The branch till has a **shift-end** flow (`daily_close`): at close the worker counts cash + every
product, and the system records `counted` vs `expected` vs `variance` per product. There is **no
opening attestation**. A worker who inherits stock that is already short has no way to say "it was
like this when I arrived," so any end-of-day shortfall lands on her even if she did not cause it.

The owner wants the worker to **confirm the stock she meets at the start of her shift** — a full
opening count that mirrors the close — so variance during her shift is unambiguous and
accountability splits cleanly between shifts.

## Locked decisions

1. **One shift per day.** Opening pairs 1:1 with the existing per-day close. No `shift` entity.
2. **Full opening count.** She physically counts every flavour/size and enters numbers, exactly
   like the closing count. Her opening count is the baseline.
3. **Record only — never touch stock.** The opening variance (`counted − system_expected`) is
   recorded and notified, but system on-hand is **not** changed. This keeps the close math
   non-invasive: shift-attributable shrinkage is readable as `closing_variance − opening_variance`.
4. **Hard-block the till** (stock-sale path) until the opening count is filed for today.
5. **Offline = unlock locally on this device.** Filing writes a local marker that unlocks the till
   immediately, plus an outbox row that POSTs the count when the network returns. Never strands a
   sale.
6. **Logout-safe.** The gate is keyed to the Lagos **business date**, not the session; logout does
   not clear Dexie, so a re-login the same day does **not** re-trigger the count.
7. **Owner exempt** from the gate.
8. **Sell-policy enforced:** on the till, **manager/admin can only create preorders + view** (no
   stock-consuming sales). Stock-consuming sales become **owner + branch_staff only**. Because
   managers/admins no longer deplete stock, they are **never gated**; the gate applies to
   **branch_staff** alone.

## Architecture

### Capability split (`packages/shared/src/permissions.ts`)

- Keep **`pos.sell`** = ring up a **stock-consuming** walk-up sale. Holders after this change:
  **owner, branch_staff** only. (Remove from `ADMIN_CAPS` and `MANAGER_CAPS`.)
- Add **`pos.preorder`** = create/fulfil **preorders** (made-to-order, consumes no stock). Holders:
  **owner, admin, manager, branch_staff**.
- Add **`shift_open.submit`** = file an opening count. Holders: **owner, admin, manager,
  branch_staff** (same set as `daily_close.submit`; only branch_staff is actually gated, but the
  capability is granted broadly so an owner/manager can file on a worker's behalf).
- Update `packages/shared/src/permissions.test.ts` for the new caps and reassignments.

**Route re-gating (depends on current branch):** the branch preorder routes added this branch
(`GET /v1/branches/:branchId/preorders`, `PATCH …/preorders/:id/fulfil`, the `Preorders` nav link)
are gated `pos.sell` today. Move them to **`pos.preorder`** so manager/admin retain preorder access
after losing `pos.sell`.

### Data model (`packages/db/src/schema/shift-open.ts`) — Approach ① separate table

Mirror image of `daily_close`, isolated from the close's approval state machine:

```
shift_open
  id              uuid pk
  branch_id       uuid not null → branch.id
  business_date   date not null            -- Lagos business date
  opened_by_user_id uuid → admin_user.id
  opened_at       timestamptz
  notes           text
  created_at / updated_at timestamptz
  UNIQUE (branch_id, business_date)

shift_open_stock_count
  id                uuid pk
  shift_open_id     uuid not null → shift_open.id (on delete cascade)
  product_id        uuid not null → product.id
  system_quantity   integer not null         -- expectedStockForDay at open
  counted_quantity  integer not null
  variance          integer not null         -- counted − system
  variance_reason   text
```

- New migration `00NN_*.sql` **and** a `migrations/meta/_journal.json` entry; rebuild `@ms/db`.
- No `status`/approval workflow — an opening count is a worker attestation, not an approvable doc.

### API (`apps/api/src/routes/shift-open.ts`) — mirrors `daily-close.ts`

Mounted branch-scoped (`requireAuth` + `requireBranchScope`), same as daily-close.

- `GET …/shift-open/preview?date=` → `{ expected_stock }` (reuse `expectedStockForDay`) to prefill
  the grid. Open to any branch-scoped user.
- `POST …/shift-open` — cap `shift_open.submit`. Body: `business_date`, `stock_counts[]`
  (`product_id`, `counted_quantity`, `variance_reason?`), `notes?`. For each line
  `system_quantity = expectedStockForDay[product_id] ?? 0`, `variance = counted − system`.
  **Writes no inventory ledger.** Upsert on `(branch_id, business_date)`; replace stock-count rows
  atomically (delete+insert, like daily-close). `writeAudit({action:"shift_open.submit", …})`.
  Enqueue `shift_open.submitted` outbox notification (who opened, branch, business date, any
  opening variances) — joins the existing rich-named Telegram footer pattern.
  - **Empty catalog:** `stock_counts` may be **empty** (relax the `.min(1)` the close uses) so the
    gate can never deadlock when there are no products.
  - Server requires `variance_reason` on any line where `variance !== 0` (mirror close).
- `GET …/shift-open?date=` → today's `shift_open` + counts + resolved `opened_by` email/name, or
  `null`. Drives the gate's online check and the close screen's open→close summary.
- **`/sync/pull` gains `opened_today: boolean`** for the device's branch (is there a `shift_open`
  row for today's Lagos business date?). Lets a second device self-heal without re-counting.

### Till gate (offline-first)

The gate is **device-local + self-healing**. Gate satisfied when **either**:
- a **local Dexie marker** exists for `(branch_id, business_date=today-Lagos)`, **or**
- the last `/sync/pull` returned `opened_today = true`.

**Local storage (`apps/admin/src/db/local.ts`):** add a `shift_open_marker` store
(`id = "${branch_id}::${business_date}"`, `{ branch_id, business_date, opened_at }`) via a Dexie
`.version()` bump (no destructive upgrade). The marker is **not** cleared on logout (logout only
hits the API + redirects); only the explicit "Refresh app" button (`local.delete()`) wipes it,
after which the next online pull restores `opened_today`.

**Filing path (`apps/admin/src/sync/local-shift-open.ts`, mirrors `local-sale.ts`):** in one Dexie
transaction — write the `shift_open_marker` (unlocks instantly) **and** an outbox row
`POST /v1/branches/:id/shift-open`. The existing sync engine replays it when online; the server
upsert is idempotent per `(branch, date)`.

**Enforcement point (`apps/admin/src/routes/branch/sell.tsx`):** before rendering the cart/sell
grid, evaluate role + gate:
- **owner** → never gated (full till).
- **manager/admin** → no `pos.sell`; till runs in **preorder-only** mode (instant stock sales
  hidden/disabled, preorder + view available) and is **never gated**.
- **branch_staff** → has `pos.sell`; if the gate is **unsatisfied**, render a full-card
  **"Start your shift — count your opening stock"** block (button → Shift start route) **instead of**
  the sell grid. Stock-consuming checkout is blocked until satisfied.

Preorder creation is always allowed for anyone with `pos.preorder`, even when the stock-sale path is
gated (preorders consume no stock).

### UI — Shift start page (`apps/admin/src/routes/branch/shift-start.tsx`)

Twin of `close.tsx`: a stock-count grid (**Product · Expected · Counted · Variance ·
Reason-if-variance**), prefilled from `…/shift-open/preview`, with a notes field and a **"Confirm
opening stock"** submit that calls the local filing path (offline-capable). No cash section —
opening is about product; cash is reconciled at close. Add a **"Shift start"** nav entry in
`BranchShell` (cap `shift_open.submit`).

On success: toast, write marker, navigate to the till. If today is already open (server or marker),
show a read-only "Opened by X at HH:MM" state with an "Edit count" affordance (re-submit upserts).

### Close screen enrichment

- `daily-close.ts` `GET /:id` and the owner **close-detail** view: surface the matching
  `shift_open` for the same `(branch, business_date)` so the owner sees **opening variance beside
  closing variance**, and the derived **shift-attributable shrinkage = closing − opening** per
  product.

### Notifications

`shift_open.submitted` event → worker (`outbox.ts` / audit humanizer / `audit-humanize.ts`): add the
human label and a Telegram message listing who opened, the branch, the business date, and any
non-zero opening variances. Follows the established rich-named footer convention.

## Edge cases

1. **First shift / post-wipe:** system expected = 0, so the opening shows a large variance vs 0 once;
   expected behaviour, record-only absorbs it. Worker must give a reason on each non-zero line.
2. **Offline at open:** local marker unlocks instantly; outbox syncs the count later. ✓
3. **Two devices both offline AM:** each may file its own opening; the server upsert is
   last-write-wins per `(branch, date)`, and the notification flags when a second opening lands the
   same day. Single-till branches never hit this.
4. **Re-count / miscount:** re-submitting upserts and replaces the count rows (like the close).
5. **Lagos day rollover:** the gate keys off the **Lagos** business date (`nowLagos`), not UTC. A
   shift running past Lagos-midnight would be asked to re-open at 00:00 — unlikely for a juice shop;
   flagged, not handled specially.
6. **Empty catalog:** opening accepts 0 count rows so the gate cannot deadlock.
7. **Logout / re-login same day:** gate is date-keyed and the marker survives logout → no re-count.
8. **"Refresh app" wipe:** marker gone, but the next online pull returns `opened_today` → re-heals
   without a re-count (if offline after a wipe, branch_staff would re-count — acceptable, rare).
9. **PWA cache:** existing tills need a hard-refresh to pick up the gate + capability changes
   (every ship does).
10. **Owner/manager files on a worker's behalf:** allowed via `shift_open.submit`; `opened_by`
    records who actually filed.

## Out of scope

- Multiple reconciled shifts per day (would need a real `shift` entity).
- Auto-correcting stock from the opening count (explicitly record-only).
- Opening cash float (cash is reconciled at close only).
- Owner approval workflow for openings (an attestation, not an approvable document).

## Testing

- **API:** integration test for `POST/GET …/shift-open` (upsert, variance math, no inventory
  written, empty-catalog allowed, reason required on variance) — mirror `daily-close-flow.test.ts`.
- **Permissions:** unit test the new cap assignments (`pos.sell` owner+branch_staff only;
  `pos.preorder` four roles; `shift_open.submit`).
- **Sync engine / local filing:** marker write + outbox enqueue in one txn; gate satisfied by marker
  while offline; `opened_today` from pull satisfies gate without a marker.
- **Branch preorder routes** still reachable by manager/admin after re-gating to `pos.preorder`.
- Quality gates: 0 lint errors, clean typecheck, full suites green.

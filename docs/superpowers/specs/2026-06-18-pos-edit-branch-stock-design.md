# In-POS branch stock edit — design

**Date:** 2026-06-18
**Status:** Built, tests green (not yet committed/deployed)

## Goal

Let the **owner** correct a branch's on-hand stock directly from the till
(POS / Sell screen), per can size, without leaving for the Inventory page.

## Context / what already existed

- `POST /v1/inventory/adjust` (owner/admin/manager cap `stock.adjust`) already
  sets a new absolute on-hand for a `factory` **or `branch`** location, writing
  an `adjustment` row to `stock_ledger` with a required reason + audit + Telegram.
- The Admin Inventory page (`/owner/inventory`) already exposes this for branches
  (Branches grid cell click + Bulk-adjust modal). Its bulk modal *defaults* its
  location-type dropdown to Factory — the likely reason it "looked factory-only";
  the branch path was correct but **untested**.
- The POS recomputes each branch's on-hand as `SUM(stock_ledger.delta)` on every
  `/sync/pull`, so any branch adjustment already propagates to the till on resync.

So this is a thin client feature — no API, schema, or migration changes.

## Decisions (user-approved)

- **Online-only.** A correction must hit the server to be authoritative; the
  helper throws + the form disables when offline. Reads stay fully offline. This
  avoids re-introducing the phantom-stock divergence class of bugs.
- **Per-size entry point** in the till's Size Picker. The owner always gets the
  Size Picker (even single-size flavours) so the per-size "Edit stock" affordance
  is reachable everywhere. Non-owners are unchanged (single tap → cart).
- **Owner-only**, matching the Inventory page's `isOwner` gate.

## Implementation

- `apps/admin/src/lib/stock-adjust.ts` — shared `REASONS` + `adjustBranchStock()`:
  posts `/inventory/adjust` with `location_type: "branch"`, then `resyncStock()`
  to overwrite the local snapshot with fresh server truth (no optimistic patch).
- `apps/admin/src/routes/branch/sell.tsx` — `SizePicker` gains `canEdit`/`onEdit`
  (row restructured so the Edit button isn't nested in the pick button); new
  `EditStockModal` (current on-hand from the local `stock` snapshot for that exact
  variant, new-count input, reason select, offline guard, would-go-negative map).

## Tests

- `apps/admin/src/lib/stock-adjust.test.ts` (4): branch-scoped body + resync;
  reason_note trimming; offline refusal (no network); would-go-negative propagation.
- `apps/api/test/integration/inventory-adjust.test.ts` (+1): owner sets on-hand at
  a **branch** → `/reports/branch-stock` reflects it (the till's source of truth).

## Out of scope / follow-ups

- Offline-capable editing (queued via outbox) — deliberately deferred.
- Mirror is admin-app only; the Tauri desktop app inherits it on next resync.
- 🔴 Not click-tested with a real owner login; PWA hard-refresh needed for the
  new bundle. Not committed/deployed.

# Confirmation summary dialogs for transfers & production runs

**Date:** 2026-06-18
**Scope:** admin app UI only — no API, schema, or routing changes.

## Problem

Two irreversible, ledger-affecting actions commit with no review step:

- **Send transfer** (`apps/admin/src/routes/transfers.tsx` → `CreateTransferModal.submit`)
  POSTs `/transfers` immediately on submit. Dispatching moves stock out of the factory.
- **Complete production run** (`apps/admin/src/routes/factory/run-detail.tsx` → `complete`)
  PATCHes `/production-runs/:id/complete` immediately. Completion posts bottles to the
  factory ledger and cannot be undone.

The owner wants a summary modal to appear before either action commits, so the numbers
can be eyeballed first.

## Decision

A **separate confirm dialog** pops over the existing screen for **both** flows (per user
choice). Build it on the existing accessible `Modal` (`apps/admin/src/components/Modal.tsx`),
which already provides focus trap, Escape-to-close, scroll lock, and focus restoration.

## Component: `ConfirmModal.tsx`

New file `apps/admin/src/components/ConfirmModal.tsx`. A thin wrapper around `Modal` that
supplies a scrollable body + pinned footer with Cancel / Confirm.

Props:

| Prop | Type | Notes |
|------|------|-------|
| `title` | `string` | Passed to `Modal`. |
| `children` | `ReactNode` | The flow-specific read-only summary. |
| `confirmLabel` | `string` | e.g. `"Send transfer"`, `"Complete run"`. |
| `busyLabel` | `string` | Shown on the confirm button while `busy`. |
| `onConfirm` | `() => void` | Fires the real action. |
| `onCancel` | `() => void` | Closes; also passed as `Modal.onClose`. |
| `busy` | `boolean` | Disables both buttons; confirm shows `busyLabel`. |
| `tone?` | `"primary" \| "danger"` | Confirm button class; default `"primary"`. |
| `maxWidth?` | `number` | Forwarded to `Modal`; default 560. |

Layout (the scroll requirement):

- Render children inside a wrapper with `maxHeight: "min(60vh, 520px)"` and
  `overflowY: "auto"` so a long item list scrolls **inside** the dialog.
- Footer (Cancel + Confirm) sits **outside** that scroll wrapper, separated by a
  `border-top: 1px solid var(--line)`, so the buttons stay visible no matter how long the
  list is — on both small phones and large desktops. `Modal` itself already caps the card
  at `calc(100vh - 32px)` with `overflow: auto`, so the whole dialog also never exceeds the
  viewport.
- Footer buttons: `btn btn--subtle` (Cancel) + `btn btn--primary` / `btn btn--danger`
  (Confirm), right-aligned with `display:flex; justify-content:flex-end; gap:8`.

## Transfer flow changes (`transfers.tsx`)

1. Add `const [showConfirm, setShowConfirm] = useState(false)` to `CreateTransferModal`.
2. Rename the current `submit`'s POST body into a new `async function doSubmit()` that keeps
   the existing try/catch, `submitting` state, and `onSaved()` call.
3. `submit(e)` now: `preventDefault`, run the existing over-sent validation (unchanged — sets
   `error` and returns if a line exceeds factory stock), and if valid call
   `setShowConfirm(true)` instead of POSTing.
4. When `showConfirm`, render `<ConfirmModal>` with summary body:
   - **Factory → Branch** (names resolved from the `factories`/`branches` props).
   - Vehicle and Driver lines, shown only when filled.
   - Read-only table of every line: column for item (flavour name + size label, or
     `🛍 {bag name}`), quantity, unit cost (₦). Reuse `sizeLabel`.
   - Footer totals: line count and **total quantity** (sum of `quantity_sent`).
   - `confirmLabel="Send transfer"`, `busyLabel="Sending…"`, `busy={submitting}`,
     `onConfirm={doSubmit}`, `onCancel={() => setShowConfirm(false)}`.
5. The existing form's submit button keeps its label; it now opens the review instead of
   sending. On a successful `doSubmit`, `onSaved` closes the whole create modal as today.

Note: `CreateTransferModal` is still an ad-hoc fixed-position div (not the shared `Modal`).
Leave that as-is — migrating it is out of scope; the new `ConfirmModal` renders above it
(`Modal` uses `zIndex: 50`, same as the create modal, and is mounted later in the tree so it
paints on top).

## Production-run flow changes (`run-detail.tsx`)

1. Add `const [showConfirm, setShowConfirm] = useState(false)`.
2. The **Complete run · post to ledger** button's `onClick` becomes `setShowConfirm(true)`
   instead of `void complete()`. `complete()` itself is unchanged.
3. When `showConfirm`, render `<ConfirmModal>` with summary body:
   - Factory name, run date (`formatDate`).
   - Items table: product · size · quantity · batch code (mirrors the existing Items table).
   - **Total bottles produced** (`totalBottles`).
   - A one-line warning: completing posts bottles to the factory ledger and can't be undone.
   - `confirmLabel="Complete run"`, `busyLabel="Completing…"`, `busy={acting}`,
     `tone="primary"`, `onConfirm={async () => { await complete(); setShowConfirm(false); }}`,
     `onCancel={() => setShowConfirm(false)}`.
   - `complete()` already calls `load()` on success, which flips the run out of `draft` so the
     button/dialog disappear.

## Error handling

- Transfer: API errors from `doSubmit` continue to surface via the existing `error` state in
  the create form (the confirm dialog closes / form re-enables on failure). Keep current
  behaviour — set `submitting=false` on error so the user can retry.
- Run: errors continue to surface via `toast.error` inside `complete()`.

## Testing

- Reuse the project's quality gates: `pnpm --filter @ms/admin typecheck` and lint must stay
  clean.
- Manual: open a transfer draft → Send → verify summary numbers match entered lines → Confirm
  posts; Cancel returns with data intact. Open a draft run → Complete → verify totals →
  Confirm posts to ledger. Verify on a narrow viewport that a long item list scrolls inside
  the dialog while Cancel/Confirm stay pinned.
- No new automated tests required (admin app has no component test harness for these routes);
  if a `ConfirmModal` render smoke test is cheap to add alongside `StatHero.test.tsx`, include
  one asserting confirm/cancel callbacks fire.

## Out of scope

- Migrating `CreateTransferModal` to the shared `Modal`.
- Any API/validation/permission changes.
- A two-step "Review" page inside the create modal (user chose the separate-dialog approach).

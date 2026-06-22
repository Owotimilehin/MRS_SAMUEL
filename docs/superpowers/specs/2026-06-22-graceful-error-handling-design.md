# Graceful error handling, whole-app — design

**Date:** 2026-06-22
**Status:** Approved, ready for plan
**Scope:** admin/POS, customer storefront, worker/cron, API backend (verification), audit-log readability

## Goal

Make every failure in the app land gracefully — a shop owner, till operator, or
customer never sees a blank screen, a raw stack trace, a technical token, or a
silently-swallowed background job. Build the missing structural pieces once, then
sweep each surface to use them.

This is a hardening pass on an already-mature base: the API has a central
`onError` + `AppError` taxonomy + Sentry; admin `api.ts` already retries,
refreshes 401s, and humanizes messages; the audit page already humanizes most
events. The work is closing the **coverage and consistency gaps**, not rebuilding.

## Principle: three failure buckets, three treatments

Every failure is classified and handled one way:

1. **A user action fails** (a mutation: save, dispatch, pay, adjust) →
   friendly toast. Already done in admin (`api()` auto-toasts mutations); extend
   the same guarantee to customer write paths.
2. **A screen's data fails to load** (a GET / route loader) → inline **error
   state with a Retry button**. Never a blank screen, never only a toast floating
   over empty content.
3. **A screen crashes while rendering** → a **per-route error boundary** isolates
   the broken screen; navigation and every other screen stay usable.

## Current state (verified)

- **API backend** — mature. `apps/api/src/lib/errors.ts` (`AppError`/`BusinessError`/`SystemError`),
  central `apps/api/src/middleware/error.ts` (`onError`) handling `AppError`, `ZodError`,
  and unknown → `internal_error` with `request_id` + Sentry. Solid.
- **Admin `apps/admin/src/lib/api.ts`** — excellent: retry w/ backoff on 502/503/504/429,
  idempotency keys reused across retries, single-flight 401 refresh w/ cross-tab Web Lock,
  offline-aware wait, `humanizeError`/`describeValidation`/`describeByCode`. Auto-toasts
  failed mutations. `humanizeError` exported for call sites.
- **Admin error boundary** — ONE app-level `components/ErrorBoundary.tsx` with chunk-reload
  self-heal. No per-route boundaries → a single route render crash blanks the whole app.
- **Customer `apps/customer/src/lib/api/client.ts`** — clean `ApiError` with cross-RPC
  serialization (`serialize`/`asApiError`), but `apiFetch` does a single fetch with **no
  retry/backoff** — a transient 502 during an API restart fails the customer instantly.
- **Customer routing** — only `__root.tsx` defines `errorComponent`; data routes
  (`juices.$id`, `order.$orderNumber`, `track`, `checkout`, `blog.$slug`, `shop`,
  `juices.index`) have no per-route error/pending components.
- **Worker `apps/worker/src/index.ts`** — one outer `try/catch` per 5s tick. If an early
  job (`drainOutbox`) throws, **every later job that tick is skipped**. Only
  `runDueCronJobs` has its own guard. Inside `runDueCronJobs`, sub-jobs run sequentially —
  a P&L digest throw aborts recurring-expense + subscription billing.
- **Audit humanizer `apps/admin/src/lib/audit-humanize.ts`** — humanizes most actions/
  entities/diffs with fallbacks, but the default branch and unmapped actions/entities can
  still surface raw `snake_case` tokens or sliced UUIDs to a non-developer.

## Phase 0 — Shared primitives (build once)

- **Admin `<DataState>`** (new, `apps/admin/src/components/DataState.tsx`): a wrapper that
  renders one of `loading | error+retry | empty | content` from a small state object, so
  every page's GET follows one pattern. Includes a `<DataError onRetry message>` piece that
  uses `humanizeError`.
- **Customer `apiFetch` resilience** (`apps/customer/src/lib/api/client.ts`): port admin's
  retry/backoff + offline-aware wait. GET-safe by default; mutations only retried on
  network/gateway errors (idempotent reads are always safe). Preserve `ApiError` +
  serialization.
- **Customer `<RouteError>`** (new): shared friendly error UI with a retry/reset action,
  used as `errorComponent` across routes.
- **Per-route boundary factory** for each router (admin + customer) so attaching a boundary
  to a route is one line and visually consistent.

## Phase 1 — Admin / POS (ships first, highest stakes)

- Attach a per-route `errorComponent` to every admin route via the factory, so a crash on
  the till or any owner screen isolates to that screen — nav + other tabs survive.
- Sweep GET call-sites that currently do `catch → toast.error → leave content blank`;
  convert to `<DataState>` error+retry. Target the route files surfaced by the audit:
  branch/*, factory/*, owner/* screens that fetch on mount.
- Verify every `catch` that shows a message uses `humanizeError(err)` — no raw `err.message`
  reaching staff (audit-log page currently does `err instanceof Error ? err.message`; fix).

## Phase 2 — Customer storefront

- Add `errorComponent` + `pendingComponent` to the data routes listed above. Loader
  failures render `<RouteError onRetry>` instead of falling through to the root boundary
  (which blanks the whole site).
- Ensure checkout failures (payment init, quote) surface a clear, retryable message rather
  than dead-ending the buyer.
- With `apiFetch` now retrying, transient 502s during API restarts self-heal silently.

## Phase 3 — Worker / cron (job isolation)

- Introduce a `runJob(name, fn)` helper that wraps a single job: on throw it logs
  `{ err, job }` (+ Sentry if configured) and returns, so the loop continues to the next
  job. Apply to every job in the main loop (`drainOutbox`, sweep, late-close, reminders,
  delivery-watchdog, audit-export) — not just cron.
- Apply the same isolation inside `runDueCronJobs` so P&L digest / recurring expenses /
  subscription billing failures don't cascade.
- Preserve existing idempotency (cron_run claims, FOR UPDATE sweeps) — isolation wraps,
  never replaces, the claim logic.

## Phase 4 — API backend (verification pass)

- Grep for handlers throwing raw `Error` or returning ad-hoc `c.json({ error })` instead of
  `AppError`. Normalize any found so every error flows through `onError` with a stable code +
  `request_id`. Expected to be a small/empty diff given current maturity — this is a
  confirmation pass, fixes only where a real gap exists.

## Phase 5 — Audit-log readability

- Make `humanizeAction` / `humanizeEntity` / `humanizeDiff` default branches **graceful**:
  any unmapped action, entity type, or field renders as tidied human text (e.g.
  `production_run.create_draft` → "Production run — create draft"), never a raw token or a
  bare sliced UUID with no label.
- Cross-check the live `/audit-log/facets` action + entity lists against the mappings and
  fill every gap, so a non-developer reading the log never meets a technical string.
- Keep the existing page layout and "Show raw data" toggle (raw JSON stays available for a
  developer; the default view is human).

## Testing

- **Customer** unit: `apiFetch` retries gateway/network errors with backoff, gives up after
  max attempts with an `ApiError`, does not retry a real 4xx.
- **Audit** unit: default-branch tidying turns unmapped keys into human text; no `_` or raw
  UUID in output for a representative unmapped action/entity.
- **Worker** unit: when one job throws, `runJob` logs and the remaining jobs are still
  invoked (spy/mock the jobs).
- Existing API/worker/shared suites stay green.
- Per-route boundaries smoke-checked with the existing route-walk harness (`ui-walk.mjs`)
  for 0 regressions / 0 blank screens.

## Out of scope

- No new monitoring/observability infrastructure.
- No Sentry rollout to frontends beyond what already exists.
- No redesign of the audit-log page layout.
- Only correctness/readability of error & audit surfaces.

## Risks & notes

- Both UIs are PWAs — shipped fixes need a hard-refresh/SW update to reach open tills (known
  pattern; the SW auto-update + chunk-reload already handle this).
- Customer `apiFetch` runs inside TanStack server functions — retry must remain server-side
  and not change the `ApiError` serialization contract used by `asApiError`.
- Phased ship: each phase lands + is verified before the next; admin/POS first.

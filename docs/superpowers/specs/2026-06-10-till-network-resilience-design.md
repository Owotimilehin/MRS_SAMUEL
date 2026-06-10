# Till Network Resilience — Design

- **Date:** 2026-06-10
- **Status:** Approved (architecture); pending spec review
- **Scope:** Phase 1 of "rugged from login to close of business." Phase 2 (cold offline login) is sketched only.

## Problem

A branch till must survive a full ~10-hour business day — from morning login to the evening daily close — over a flaky network. Investigation of the current admin app found four hard gaps, two of which break even on a *perfect* network:

1. **Session dies ~15 min in.** The access token (`ms_session`) has a 15-minute TTL (`apps/api/src/auth/jwt.ts` `ACCESS_TTL = "15m"`, cookie `maxAge: 60*15` in `apps/api/src/auth/routes.ts`). A `/v1/auth/refresh` endpoint exists and the refresh cookie (`ms_refresh`) lives for days — but **the admin client never calls refresh**, and the API middleware (`apps/api/src/middleware/auth.ts`) does not auto-refresh. Nothing keeps the session alive.
2. **Queued sales die on token expiry.** The outbox sender (`apps/admin/src/sync/engine.ts` `sendOne`) treats `401` as a *permanent business rejection* and marks the row `dead`. So any sale rung up after the token expires fails to sync forever — effectively lost sales data.
3. **Reload while offline → logout.** `RequireAuth` (`apps/admin/src/lib/auth.tsx`) calls `/v1/auth/me` on mount; a network failure is caught and treated as *anonymous* → redirect to `/login`, which can't complete offline. One accidental refresh during an outage locks staff out mid-shift.
4. **Daily Close is online-only.** `apps/admin/src/routes/branch/close.tsx` fetches a server preview on mount (offline → form never populates, Submit stays disabled) and submits via a direct `api()` POST (offline → errors, nothing queued). Staff cannot close if the network is down at closing time.

For contrast, **Sell is already fully offline-capable**: `sell.tsx` reads products/prices/stock from the local IndexedDB mirror via `useLiveQuery`, and `createLocalSale` (`apps/admin/src/sync/local-sale.ts`) writes the sale + optimistic ledger + outbox rows with zero network calls.

## Goals

- A logged-in session survives a full business day on good network (no surprise re-logins).
- Network blips and offline page reloads never log the cashier out.
- Queued sales never die because of token expiry — they sync once connectivity/auth returns.
- Daily Close can be fully completed offline (preview + submit), syncing on reconnect.

## Non-goals (Phase 2 / out of scope)

- **Cold offline login** — authenticating with *no* network at opening. Sketched at the end; gets its own spec.
- Changes to the customer app.
- Changing the server auth model (cookies/JWT/refresh stay as-is).

## Current architecture (relevant pieces)

- **Auth:** HTTP-only cookies. `ms_session` = HS256 JWT, 15-min TTL. `ms_refresh` = opaque, multi-day TTL, path `/v1/auth`. `POST /v1/auth/refresh` rotates the refresh token and issues a fresh access token. `GET /v1/auth/me` returns the user, requires a valid access cookie.
- **Client auth gate:** `RequireAuth` → `/auth/me` on mount → in-memory `AuthContext`. No persistence, no refresh, no 401 recovery.
- **Sync engine:** outbox table (idempotency key = row id, exponential backoff, `depends_on` ordering, `in_flight` reclaim) + 30s delta pull + `SyncBadge` (online/queued/dead) in `BranchShell`.
- **Local mirror (Dexie, `apps/admin/src/db/local.ts`):** `products`, `prices`, `ledger`, `transfers`, `sales`, `outbox`, `reservations`, `meta`. No `returns` table.

## Design

### 1. Session keep-alive (proactive refresh loop)

New helper in `apps/admin/src/lib/session.ts`:

- `startRefreshLoop()` — `POST /v1/auth/refresh` (credentials included) every **10 minutes** (comfortably under the 15-min TTL), and also on `window` `focus` and `online` events. Skipped when `!navigator.onLine`. Best-effort: failures are swallowed (offline is normal).
- Started once for the authenticated shell (mounted from `RequireAuth` once a user is resolved, so it covers both owner and branch shells).

**Effect:** the access cookie stays continuously valid across a 10-hour day of good network.

### 2. Recoverable 401 (refresh-and-retry, single-flight)

A shared single-flight refresh so concurrent 401s don't stampede `/refresh`:

- `refreshSession(): Promise<boolean>` in `lib/session.ts` — dedupes concurrent callers onto one in-flight `POST /v1/auth/refresh`; resolves `true` on 200, `false` on 401/failure.
- **`api.ts` wrapper:** on a `401` response, call `refreshSession()`; if `true`, retry the original request **once**; if `false`, throw `ApiError(401)` as today (caller decides).
- **`engine.ts` `sendOne`:** remove `401` from the immediate-`dead` list. On `401`: call `refreshSession()`, then retry once. If refresh fails, **leave the row `pending`** (NOT `dead`) so it flushes after the user re-authenticates. Keep `400/403/404/409/422` as immediate `dead` (genuine business rejections).

**Effect:** expired-token 401s self-heal; sales are never lost to auth expiry.

### 3. Cached user + offline grace (RequireAuth)

- On successful login (`login.tsx`) and every successful `/auth/me`, persist the user to `localStorage` under `ms-auth-user` with a `cached_at` timestamp.
- `RequireAuth` decision tree:
  - `GET /v1/auth/me`:
    - **200** → render with fresh user; refresh cache.
    - **401** (server reachable, explicit) → via the `api.ts` wrapper this already attempted a refresh+retry; if still 401 → **clear cache, redirect `/login`**.
    - **Network error** (fetch rejects / offline) → if a cached user exists and `cached_at` is within max-age (= refresh-token TTL, `REFRESH_TTL_DAYS`), render with the **cached user**; else redirect `/login`.
- The distinction is mechanical: a thrown fetch = network failure (trust cache); a `res.status === 401` = explicit logout (clear cache).

**Effect:** reloads and blips keep the cashier in; only an explicit server rejection (while reachable) logs them out.

### 4. Daily Close offline

**Local preview** — new `apps/admin/src/sync/close-preview.ts`:

- `localExpectedStock(branchId)` → group `local.ledger` by `product_id` where `location_type='branch'` and `location_id=branchId`, sum `delta`. Matches `expectedStockForDay` exactly.
- `localExpectedCash(branchId, businessDate)` → sum `local.sales.total_ngn` where `branch_id=branchId`, `payment_method='cash'`, `status ∈ {paid, handed_over, delivered, confirmed}`, and `created_at_local` within the business day. `confirmed` is included so locally-queued (not-yet-synced) cash sales count as cash-in-drawer.
  - **Known limitation:** cash refunds (`sale_return`) are not mirrored locally, so the offline figure does not subtract same-day cash refunds. This is an *estimate* for staff guidance; the **server recomputes the authoritative `expected_cash` and `variance` on submit** (`daily-close.ts` POST handler), so the stored close is always correct. Same-day cash refunds are rare; acceptable for Phase 1. (Future: mirror returns to close the gap.)
- `close.tsx`: try the server `/daily-close/preview` first (authoritative, includes refunds); **on network failure, fall back to the local preview** and show an "offline estimate" badge.

**Submit via outbox** — new `apps/admin/src/sync/local-close.ts`:

- `createLocalClose(branchId, body)` writes one outbox row: `POST /v1/branches/:branchId/daily-close`, idempotency-keyed (row id). The server upsert is idempotent on `(branch_id, business_date)`, so replays are safe.
- `close.tsx` `submit()` calls `createLocalClose` instead of the direct `api()` POST and shows "Close saved — will submit when online." It flushes via the existing sync loop.

### Error handling summary

- Refresh is single-flight; offline failures are silent.
- A 401 that survives a refresh attempt → in the outbox the row stays `pending` (re-flushes after re-login); in `RequireAuth` it means explicit logout only when the server was reachable.
- Daily Close submit is idempotent server-side; safe to replay.

### Testing

- **Unit:**
  - `refreshSession` single-flight (concurrent callers share one request).
  - `api.ts`: 401 → refresh → retry once; failed refresh → throws.
  - `engine.ts` `sendOne`: 401 no longer marks `dead`; refresh+retry path; non-401 business codes still `dead`.
  - `close-preview.ts`: local stock/cash computation matches server formula on a sample ledger/sales fixture.
  - `RequireAuth`: network-failure (trust cache within max-age) vs explicit-401 (clear + login) branching.
- **Playwright (offline emulation, `apps/admin/e2e`):**
  - Reload while offline → stays logged in.
  - Sell offline, advance past 15 min, reconnect → sale flushes (not `dead`).
  - Daily Close offline → queued → reconnect → server has the close.

### Files touched (Phase 1)

- New: `apps/admin/src/lib/session.ts`, `apps/admin/src/sync/close-preview.ts`, `apps/admin/src/sync/local-close.ts`.
- Modified: `apps/admin/src/lib/api.ts`, `apps/admin/src/lib/auth.tsx`, `apps/admin/src/sync/engine.ts`, `apps/admin/src/routes/branch/close.tsx`, `apps/admin/src/routes/login.tsx` (cache user on login).
- No server changes required (the `/auth/refresh` endpoint and idempotent close upsert already exist).

## Phase 2 (sketch — separate spec): cold offline login

Enable login with no network at opening:

- On first online login, the user sets a 4–6 digit **device PIN**. Store an argon2/scrypt hash of the PIN + the cached user + a sealed session locally (IndexedDB, encrypted at rest via WebCrypto with a PIN-derived key).
- Offline login verifies the PIN against the local hash and grants a local session; a re-auth with the server is queued for when the network returns.
- **Security controls:** PIN brute-force protection (attempt limit + device lockout), encryption at rest, and server-side device revocation honored on next sync.
- Deferred to its own design; depends on Phase 1 landing first.

## Open questions / risks

- **Refresh-token rotation races:** `/auth/refresh` rotates the refresh cookie. Single-flight prevents intra-tab stampedes; a single till device with one tab makes cross-tab races unlikely. Acceptable for Phase 1.
- **Offline expected-cash estimate** excludes same-day cash refunds (documented; server is authoritative on submit).
- **`localStorage` for the cached user** is acceptable (non-sensitive profile + capabilities; no secrets). The session itself remains in HTTP-only cookies.

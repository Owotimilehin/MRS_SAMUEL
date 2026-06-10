# Till Network Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the branch till survive a full business day (login → close) on flaky network: keep the session alive, stop queued sales dying on token expiry, keep cashiers logged in through offline reloads, and let Daily Close run fully offline.

**Architecture:** Phase 1 of `docs/superpowers/specs/2026-06-10-till-network-resilience-design.md`. Client-side: a single-flight `/auth/refresh` shared by a 10-min keep-alive loop, the API wrapper, and the sync engine; a DOM-free auth-state module that trusts a cached user on network failure but logs out on an explicit 401; and an offline Daily Close that computes its preview from the local mirror and submits through the outbox. No server changes.

**Tech Stack:** React 18 + TanStack Router, Dexie (IndexedDB), Vitest + fake-indexeddb (node env, no jsdom), Playwright e2e, pnpm workspaces.

---

## File Structure

- **New** `apps/admin/src/lib/session.ts` — `refreshSession()` (single-flight) + `startRefreshLoop()`.
- **New** `apps/admin/src/lib/session.test.ts` — single-flight + outcome tests.
- **New** `apps/admin/src/lib/auth-state.ts` — `AuthUser` type, cache helpers, pure `resolveAuthState()`.
- **New** `apps/admin/src/lib/auth-state.test.ts` — decision + cache tests.
- **New** `apps/admin/src/lib/api.test.ts` — 401→refresh→retry tests.
- **New** `apps/admin/src/sync/close-preview.ts` — `localExpectedStock` + `localExpectedCash`.
- **New** `apps/admin/src/sync/close-preview.test.ts`.
- **New** `apps/admin/src/sync/local-close.ts` — `createLocalClose`.
- **New** `apps/admin/src/sync/local-close.test.ts`.
- **Modify** `apps/admin/src/lib/api.ts` — 401 recovery.
- **Modify** `apps/admin/src/lib/auth.tsx` — use auth-state + cache + keep-alive loop; re-export `AuthUser`.
- **Modify** `apps/admin/src/sync/engine.ts` — `sendOne` 401 recovery; 401 no longer dead-letters.
- **Modify** `apps/admin/src/sync/engine.test.ts` — append 401 tests.
- **Modify** `apps/admin/src/routes/login.tsx` — cache user on login.
- **Modify** `apps/admin/src/routes/branch/close.tsx` — local preview fallback + outbox submit.
- **New** `apps/admin/e2e/offline-resilience.spec.ts` — offline reload + offline sell (capstone).

All test commands run from the repo root: `C:\Users\owoti\Desktop\MRS SAMUEL FRUIT JUICE\mrs-samuel`.

---

### Task 0: Feature branch

Deploy triggers only on push to `master`, so isolate this work on a branch.

- [ ] **Step 1: Create and switch to the branch**

Run: `git checkout -b feat/till-network-resilience`
Expected: `Switched to a new branch 'feat/till-network-resilience'`

---

### Task 1: Session refresh helper (`session.ts`)

**Files:**
- Create: `apps/admin/src/lib/session.ts`
- Test: `apps/admin/src/lib/session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/lib/session.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshSession } from "./session.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("refreshSession", () => {
  it("POSTs /v1/auth/refresh with credentials and resolves true on 200", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(refreshSession()).resolves.toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/v1/auth/refresh");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
  });

  it("resolves false on a 401", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))));
    await expect(refreshSession()).resolves.toBe(false);
  });

  it("resolves false when fetch throws (offline)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    await expect(refreshSession()).resolves.toBe(false);
  });

  it("is single-flight: concurrent callers share one request", async () => {
    let resolve!: (r: Response) => void;
    const fetchSpy = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal("fetch", fetchSpy);

    const a = refreshSession();
    const b = refreshSession();
    resolve(new Response(null, { status: 200 }));

    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/admin test src/lib/session.test.ts`
Expected: FAIL — cannot resolve `./session.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/admin/src/lib/session.ts`:

```ts
/**
 * Session lifecycle helpers for the admin SPA.
 *
 * The access cookie (ms_session) lives only 15 minutes; the refresh cookie
 * (ms_refresh) lives for days. Nothing kept the access token alive, so a long
 * shift silently expired. These helpers proactively refresh it and expose a
 * single-flight refresh that the api wrapper and sync engine share on a 401.
 */

let inFlight: Promise<boolean> | null = null;

/**
 * Refresh the access token using the refresh cookie. Concurrent callers share
 * one in-flight request so a burst of 401s does not stampede the endpoint.
 * Resolves true on success, false on any failure (including offline).
 */
export async function refreshSession(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch("/v1/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

const REFRESH_INTERVAL_MS = 10 * 60_000;

/**
 * Keep the 15-minute access token alive across a full business day. Refreshes
 * every 10 minutes and on focus/online events; skipped while offline. Returns
 * a stop function. Call once per authenticated shell.
 */
export function startRefreshLoop(): () => void {
  const tick = (): void => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    void refreshSession();
  };
  const handle = setInterval(tick, REFRESH_INTERVAL_MS);
  window.addEventListener("focus", tick);
  window.addEventListener("online", tick);
  return () => {
    clearInterval(handle);
    window.removeEventListener("focus", tick);
    window.removeEventListener("online", tick);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/admin test src/lib/session.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/session.ts apps/admin/src/lib/session.test.ts
git commit -m "feat(admin): single-flight session refresh + keep-alive loop"
```

---

### Task 2: API wrapper 401 recovery (`api.ts`)

**Files:**
- Modify: `apps/admin/src/lib/api.ts`
- Test: `apps/admin/src/lib/api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/lib/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function res(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api 401 recovery", () => {
  it("on 401 refreshes once and retries, reusing the same idempotency-key", async () => {
    const keys: Array<string | null> = [];
    let sale = 0;
    const fetchSpy = vi.fn((url: string, init: RequestInit = {}) => {
      if (url === "/v1/auth/refresh") return Promise.resolve(res(200, null));
      keys.push(new Headers(init.headers).get("idempotency-key"));
      sale += 1;
      return Promise.resolve(sale === 1 ? res(401, { error: { message: "expired" } }) : res(200, { data: { ok: true } }));
    });
    vi.stubGlobal("fetch", fetchSpy);

    const out = await api<{ data: { ok: boolean } }>("/branches/B1/sales", {
      method: "POST",
      body: JSON.stringify({ x: 1 }),
    });

    expect(out).toEqual({ data: { ok: true } });
    expect(sale).toBe(2); // original + retry
    expect(keys[0]).toBe(keys[1]); // replay-safe
    expect(keys[0]).toBeTruthy();
  });

  it("throws ApiError(401) when the refresh also fails", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      Promise.resolve(url === "/v1/auth/refresh" ? res(401, null) : res(401, { error: { message: "nope" } })),
    ));

    await expect(api("/auth/me")).rejects.toMatchObject({ status: 401 } as ApiError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/admin test src/lib/api.test.ts`
Expected: FAIL — current `api` does not refresh/retry; second test passes but first fails (only one sale call).

- [ ] **Step 3: Edit the implementation**

In `apps/admin/src/lib/api.ts`, add the import at the top (after the file header comment block, alongside no existing imports):

```ts
import { refreshSession } from "./session.js";
```

Then replace the fetch-and-error block inside `api` (currently the `const res = await fetch(...)` through the `if (!res.ok)` body) with:

```ts
  const doFetch = (): Promise<Response> =>
    fetch(API_BASE + path, { ...init, credentials: "include", headers });

  // An expired 15-minute access token surfaces as 401. Refresh once and retry
  // before surfacing the error — the same idempotency-key header is reused, so
  // the retry is replay-safe.
  let res = await doFetch();
  if (res.status === 401 && (await refreshSession())) {
    res = await doFetch();
  }

  if (!res.ok) {
    let body: ErrorBody = {};
    try { body = (await res.json()) as ErrorBody; } catch { /* not json */ }
    throw new ApiError(
      res.status,
      body.error?.code ?? "unknown",
      body.error?.message ?? `request failed (${res.status})`,
      body.error?.details,
    );
  }
```

(The `if (res.status === 204) return undefined as T;` and final `return` lines stay unchanged below.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/admin test src/lib/api.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/api.ts apps/admin/src/lib/api.test.ts
git commit -m "feat(admin): api wrapper refreshes + retries once on 401"
```

---

### Task 3: Sync engine 401 recovery (`engine.ts`)

**Files:**
- Modify: `apps/admin/src/sync/engine.ts`
- Test: `apps/admin/src/sync/engine.test.ts` (append)

- [ ] **Step 1: Write the failing tests (append to the existing `describe`)**

Add these two tests inside the `describe("sync engine under bad networks", () => {` block in `apps/admin/src/sync/engine.test.ts`, before its closing `});`:

```ts
  it("401 then successful refresh: retries and acknowledges (never dead-letters)", async () => {
    let saleAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/v1/auth/refresh") return Promise.resolve(new Response(null, { status: 200 }));
        saleAttempts += 1;
        return Promise.resolve(
          saleAttempts === 1
            ? jsonResponse(401, { error: { message: "expired" } })
            : jsonResponse(201, { data: { id: "ok" } }),
        );
      }),
    );
    await local.outbox.put(saleRow({ id: "a1" }));

    await flushOutbox();

    expect(saleAttempts).toBe(2);
    expect((await local.outbox.get("a1"))?.status).toBe("acknowledged");
  });

  it("401 then failed refresh: row stays PENDING for re-login, never dead", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url === "/v1/auth/refresh"
            ? new Response(null, { status: 401 })
            : jsonResponse(401, { error: { message: "expired" } }),
        ),
      ),
    );
    await local.outbox.put(saleRow({ id: "a2" }));

    await flushOutbox();

    const row = await local.outbox.get("a2");
    expect(row?.status).toBe("pending"); // NOT dead — sale must not be lost
    expect(row?.attempt_count).toBe(1);
    expect(row?.next_attempt_at).toBeGreaterThan(Date.now());
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ms/admin test src/sync/engine.test.ts`
Expected: FAIL — first new test sees the sale dead-lettered on 401 (1 attempt); second sees status `dead`.

- [ ] **Step 3: Edit the implementation**

In `apps/admin/src/sync/engine.ts`, add the import below the existing `import { local, ... }` line:

```ts
import { refreshSession } from "../lib/session.js";
```

Replace the entire `async function sendOne(row: OutboxRow): Promise<void> { ... }` with:

```ts
async function sendOne(row: OutboxRow): Promise<void> {
  const doSend = (): Promise<Response> => {
    const init: RequestInit = {
      method: row.method,
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "idempotency-key": row.id,
      },
    };
    if (row.payload !== null) init.body = JSON.stringify(row.payload);
    return fetch(row.endpoint, init);
  };

  let res = await doSend();

  // An expired 15-minute access token shows up as 401. Refresh once and retry
  // before deciding anything — a transient 401 must never dead-letter a sale.
  if (res.status === 401 && (await refreshSession())) {
    res = await doSend();
  }

  if (res.ok) {
    await local.outbox.update(row.id, {
      status: "acknowledged",
      acknowledged_at: Date.now(),
    });
    return;
  }

  // Still unauthorized after a refresh attempt: the session is genuinely gone
  // (refresh token expired). Keep the row PENDING so it flushes once the user
  // logs back in — losing a recorded sale is never acceptable.
  if (res.status === 401) {
    const nextAttempts = row.attempt_count + 1;
    await local.outbox.update(row.id, {
      attempt_count: nextAttempts,
      next_attempt_at: Date.now() + backoffMs(nextAttempts),
      last_error: "unauthorized — awaiting re-login",
      status: "pending",
    });
    return;
  }

  // Business rule rejection — don't keep retrying.
  if ([400, 403, 404, 409, 422].includes(res.status)) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    await local.outbox.update(row.id, {
      status: "dead",
      last_error: body.error?.message ?? `HTTP ${res.status}`,
    });
    return;
  }

  // Transient — bump attempt count, schedule next try.
  const nextAttempts = row.attempt_count + 1;
  await local.outbox.update(row.id, {
    attempt_count: nextAttempts,
    next_attempt_at: Date.now() + backoffMs(nextAttempts),
    last_error: `HTTP ${res.status}`,
    status: nextAttempts > 50 ? "dead" : "pending",
  });
}
```

(Note: `401` is removed from the business-rejection list and handled separately above.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ms/admin test src/sync/engine.test.ts`
Expected: PASS — all original tests plus the 2 new ones. (The original "business rejection (409)" test still passes; 401 is no longer in that list but 409 remains.)

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/sync/engine.ts apps/admin/src/sync/engine.test.ts
git commit -m "fix(admin): 401 refreshes+retries in outbox, never dead-letters a sale"
```

---

### Task 4: Auth-state module (`auth-state.ts`)

**Files:**
- Create: `apps/admin/src/lib/auth-state.ts`
- Test: `apps/admin/src/lib/auth-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/lib/auth-state.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveAuthState,
  saveCachedUser,
  loadCachedUser,
  clearCachedUser,
  type AuthUser,
} from "./auth-state.js";

const USER: AuthUser = {
  id: "u1",
  email: "a@b.c",
  role: "branch_staff",
  branch_id: "B1",
  capabilities: [],
};

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveAuthState", () => {
  it("ok outcome → ready with the server user", () => {
    expect(resolveAuthState({ kind: "ok", user: USER }, null)).toEqual({ kind: "ready", user: USER });
  });
  it("unauthorized outcome → anon even if a cache exists", () => {
    expect(resolveAuthState({ kind: "unauthorized" }, USER)).toEqual({ kind: "anon" });
  });
  it("network-error with a cached user → ready from cache", () => {
    expect(resolveAuthState({ kind: "network-error" }, USER)).toEqual({ kind: "ready", user: USER });
  });
  it("network-error with no cache → anon", () => {
    expect(resolveAuthState({ kind: "network-error" }, null)).toEqual({ kind: "anon" });
  });
});

describe("cache helpers", () => {
  it("round-trips a saved user", () => {
    saveCachedUser(USER);
    expect(loadCachedUser()).toEqual(USER);
  });
  it("clear removes it", () => {
    saveCachedUser(USER);
    clearCachedUser();
    expect(loadCachedUser()).toBeNull();
  });
  it("expires a cache older than the max age", () => {
    saveCachedUser(USER);
    const future = Date.now() + 15 * 24 * 60 * 60_000; // 15 days
    expect(loadCachedUser(future)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/admin test src/lib/auth-state.test.ts`
Expected: FAIL — cannot resolve `./auth-state.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/admin/src/lib/auth-state.ts`:

```ts
import type { AdminRole, Capability } from "@ms/shared";

export interface AuthUser {
  id: string;
  email: string;
  role: AdminRole;
  branch_id: string | null;
  capabilities: Capability[];
}

const CACHE_KEY = "ms-auth-user";
// Trust a cached identity offline for this long. Matches the refresh-token
// lifetime so a device that cannot reach the server still works through a shift
// but won't trust a stale identity forever.
const MAX_AGE_MS = 14 * 24 * 60 * 60_000; // 14 days

interface CachedEnvelope {
  user: AuthUser;
  cached_at: number;
}

export function saveCachedUser(user: AuthUser): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ user, cached_at: Date.now() }));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export function loadCachedUser(now: number = Date.now()): AuthUser | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEnvelope;
    if (now - parsed.cached_at > MAX_AGE_MS) return null;
    return parsed.user;
  } catch {
    return null;
  }
}

export function clearCachedUser(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** Result of trying GET /v1/auth/me. */
export type MeOutcome =
  | { kind: "ok"; user: AuthUser }
  | { kind: "unauthorized" }
  | { kind: "network-error" };

export type AuthDecision = { kind: "ready"; user: AuthUser } | { kind: "anon" };

/**
 * Decide what to render given the /auth/me outcome and any cached user. Pure
 * and synchronous so it is unit-testable without a DOM:
 *   - ok            → ready (caller should re-cache)
 *   - unauthorized  → anon  (caller should clear cache + redirect)
 *   - network-error → trust a fresh-enough cached user, else anon
 */
export function resolveAuthState(outcome: MeOutcome, cached: AuthUser | null): AuthDecision {
  if (outcome.kind === "ok") return { kind: "ready", user: outcome.user };
  if (outcome.kind === "unauthorized") return { kind: "anon" };
  return cached ? { kind: "ready", user: cached } : { kind: "anon" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/admin test src/lib/auth-state.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/auth-state.ts apps/admin/src/lib/auth-state.test.ts
git commit -m "feat(admin): DOM-free auth-state with cached-user offline grace"
```

---

### Task 5: Wire RequireAuth to use auth-state (`auth.tsx`)

**Files:**
- Modify: `apps/admin/src/lib/auth.tsx`

This is wiring; correctness of the decision logic is covered by Task 4's unit tests, and the offline behavior by Task 10's e2e. No new unit test (rendering needs jsdom, which the project does not use).

- [ ] **Step 1: Replace the file contents**

Replace the whole of `apps/admin/src/lib/auth.tsx` with:

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { PageLoader } from "../components/Spinner.js";
import type { Capability } from "@ms/shared";
import {
  resolveAuthState,
  loadCachedUser,
  saveCachedUser,
  clearCachedUser,
  type AuthUser,
  type MeOutcome,
} from "./auth-state.js";
import { refreshSession, startRefreshLoop } from "./session.js";

export type { AuthUser };

const AuthContext = createContext<AuthUser | null>(null);

export function useAuthUser(): AuthUser {
  const u = useContext(AuthContext);
  if (!u) throw new Error("useAuthUser called outside RequireAuth");
  return u;
}

/** Returns a predicate to test the current user's capabilities. */
export function useCan(): (cap: Capability) => boolean {
  const u = useAuthUser();
  return (cap: Capability) => u.capabilities.includes(cap);
}

/**
 * Fetch the current user. A 401 first triggers a single refresh+retry; only a
 * still-401 counts as an explicit logout. A thrown fetch (offline) or a 5xx is
 * reported as a network error so the caller can fall back to the cached user.
 */
async function fetchMe(): Promise<MeOutcome> {
  try {
    let res = await fetch("/v1/auth/me", { credentials: "include" });
    if (res.status === 401 && (await refreshSession())) {
      res = await fetch("/v1/auth/me", { credentials: "include" });
    }
    if (res.ok) {
      const body = (await res.json()) as { data: AuthUser };
      return { kind: "ok", user: body.data };
    }
    if (res.status === 401) return { kind: "unauthorized" };
    return { kind: "network-error" };
  } catch {
    return { kind: "network-error" };
  }
}

export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready"; user: AuthUser } | { kind: "anon" }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const outcome = await fetchMe();
      if (cancelled) return;
      const decision = resolveAuthState(outcome, loadCachedUser());
      if (decision.kind === "ready") {
        if (outcome.kind === "ok") saveCachedUser(decision.user);
        setState({ kind: "ready", user: decision.user });
      } else {
        if (outcome.kind === "unauthorized") clearCachedUser();
        setState({ kind: "anon" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the 15-minute access token alive for the whole authenticated session.
  useEffect(() => {
    if (state.kind !== "ready") return;
    return startRefreshLoop();
  }, [state.kind]);

  if (state.kind === "loading") {
    return <PageLoader />;
  }

  if (state.kind === "anon") {
    const here = window.location.pathname + window.location.search;
    const next = here && here !== "/login" ? `?next=${encodeURIComponent(here)}` : "";
    window.location.replace(`/login${next}`);
    return <></>;
  }

  return <AuthContext.Provider value={state.user}>{children}</AuthContext.Provider>;
}
```

- [ ] **Step 2: Typecheck the package**

Run: `pnpm --filter @ms/admin exec tsc --noEmit`
Expected: no errors. (Confirms `AuthUser` re-export still satisfies every importer of `../lib/auth`.)

- [ ] **Step 3: Run the admin test suite (no regressions)**

Run: `pnpm --filter @ms/admin test`
Expected: PASS — all suites green.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/lib/auth.tsx
git commit -m "feat(admin): RequireAuth survives offline reloads + starts keep-alive"
```

---

### Task 6: Cache the user on login (`login.tsx`)

**Files:**
- Modify: `apps/admin/src/routes/login.tsx`

So the cache exists immediately after login even if the device drops offline before the next `/auth/me`. The login response already includes `capabilities` (see `apps/api/src/auth/routes.ts` login handler).

- [ ] **Step 1: Update the response type**

In `apps/admin/src/routes/login.tsx`, replace the `LoginResponse` interface with one that includes capabilities, and add the import. Change the existing interface:

```ts
interface LoginResponse {
  data: {
    user: {
      id: string;
      email: string;
      role: "owner" | "admin" | "manager" | "branch_staff";
      branch_id: string | null;
    };
  };
}
```

to:

```ts
import type { Capability } from "@ms/shared";
import { saveCachedUser } from "../lib/auth-state.js";

interface LoginResponse {
  data: {
    user: {
      id: string;
      email: string;
      role: "owner" | "admin" | "manager" | "branch_staff";
      branch_id: string | null;
      capabilities: Capability[];
    };
  };
}
```

(Place the two `import` lines with the other imports at the top of the file, not inside the interface.)

- [ ] **Step 2: Cache the user after a successful login**

In the `handleSubmit` function, immediately after the `const res = await api<LoginResponse>("/auth/login", { ... });` call and before the `const params = ...` line, add:

```ts
      saveCachedUser(res.data.user);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @ms/admin exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/routes/login.tsx
git commit -m "feat(admin): cache the authed user on login for offline grace"
```

---

### Task 7: Local Daily-Close preview (`close-preview.ts`)

**Files:**
- Create: `apps/admin/src/sync/close-preview.ts`
- Test: `apps/admin/src/sync/close-preview.test.ts`

Mirrors `packages/domain/src/daily-close.ts` against the local Dexie mirror.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/sync/close-preview.test.ts`:

```ts
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { local } from "../db/local.js";
import { localExpectedStock, localExpectedCash } from "./close-preview.js";

const DAY = "2026-06-11";
const iso = (d: string) => new Date(`${d}T10:00:00`).toISOString();

beforeEach(async () => {
  await local.ledger.clear();
  await local.sales.clear();
});

function ledger(o: { product_id: string; delta: number; branch?: string }) {
  return {
    id: crypto.randomUUID(),
    location_type: "branch",
    location_id: o.branch ?? "B1",
    product_id: o.product_id,
    delta: o.delta,
    source_type: "seed",
    source_id: crypto.randomUUID(),
    recorded_at: iso(DAY),
  };
}
function sale(o: { total: number; method?: string; status?: string; branch?: string; date?: string }) {
  return {
    id: crypto.randomUUID(),
    order_number: "X",
    branch_id: o.branch ?? "B1",
    channel: "walkup",
    status: o.status ?? "paid",
    total_ngn: o.total,
    payment_method: o.method ?? "cash",
    created_at_local: iso(o.date ?? DAY),
    idempotency_key: crypto.randomUUID(),
  };
}

describe("localExpectedStock", () => {
  it("sums branch ledger deltas per product, ignoring other branches", async () => {
    await local.ledger.bulkPut([
      ledger({ product_id: "p1", delta: 10 }),
      ledger({ product_id: "p1", delta: -3 }),
      ledger({ product_id: "p2", delta: 5 }),
      ledger({ product_id: "p1", delta: 99, branch: "B2" }),
    ]);
    expect(await localExpectedStock("B1")).toEqual({ p1: 7, p2: 5 });
  });
});

describe("localExpectedCash", () => {
  it("sums cash sales for the day incl. locally-confirmed; excludes non-cash, other days, other branches", async () => {
    await local.sales.bulkPut([
      sale({ total: 1000 }),                          // paid cash today
      sale({ total: 500, status: "confirmed" }),      // queued cash today (counts)
      sale({ total: 700, method: "card" }),           // card (excluded)
      sale({ total: 900, date: "2026-06-10" }),       // yesterday (excluded)
      sale({ total: 300, branch: "B2" }),             // other branch (excluded)
    ]);
    expect(await localExpectedCash("B1", DAY)).toBe(1500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/admin test src/sync/close-preview.test.ts`
Expected: FAIL — cannot resolve `./close-preview.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/admin/src/sync/close-preview.ts`:

```ts
import { local } from "../db/local.js";

/**
 * Offline equivalents of the server daily-close preview formulas
 * (packages/domain/src/daily-close.ts), computed from the local mirror so the
 * close screen populates with no network.
 */

/** Per-product expected stock = sum of branch ledger deltas. Mirrors expectedStockForDay. */
export async function localExpectedStock(
  branchId: string,
): Promise<Record<string, number>> {
  const rows = await local.ledger.toArray();
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.location_type !== "branch" || r.location_id !== branchId) continue;
    out[r.product_id] = (out[r.product_id] ?? 0) + r.delta;
  }
  return out;
}

const CASH_IN_DRAWER_STATUSES = new Set([
  "paid",
  "handed_over",
  "delivered",
  "confirmed", // locally-queued sale: cash is in the drawer, not yet synced
]);

/**
 * Expected cash for the business date = sum of cash sales recorded that day.
 * Includes locally-`confirmed` sales. It CANNOT subtract same-day cash refunds
 * (sale_return is not mirrored locally), so this is an estimate; the server
 * recomputes the authoritative figure on submit. Mirrors expectedCashForDay
 * minus that refund term.
 */
export async function localExpectedCash(
  branchId: string,
  businessDate: string,
): Promise<number> {
  const start = new Date(businessDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const rows = await local.sales.toArray();
  let total = 0;
  for (const s of rows) {
    if (s.branch_id !== branchId) continue;
    if (s.payment_method !== "cash") continue;
    if (!CASH_IN_DRAWER_STATUSES.has(s.status)) continue;
    const t = new Date(s.created_at_local).getTime();
    if (t >= start.getTime() && t < end.getTime()) total += s.total_ngn;
  }
  return total;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/admin test src/sync/close-preview.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/sync/close-preview.ts apps/admin/src/sync/close-preview.test.ts
git commit -m "feat(admin): local daily-close preview from the offline mirror"
```

---

### Task 8: Queue Daily Close via outbox (`local-close.ts`)

**Files:**
- Create: `apps/admin/src/sync/local-close.ts`
- Test: `apps/admin/src/sync/local-close.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/admin/src/sync/local-close.test.ts`:

```ts
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { local } from "../db/local.js";
import { createLocalClose } from "./local-close.js";

beforeEach(async () => {
  await local.outbox.clear();
});

describe("createLocalClose", () => {
  it("writes one pending outbox row targeting the daily-close endpoint", async () => {
    await createLocalClose({
      branchId: "B1",
      business_date: "2026-06-11",
      cash_counted_ngn: 1500,
      transfers_counted_ngn: 0,
      notes: "all good",
      stock_counts: [{ product_id: "p1", counted_quantity: 7 }],
    });

    const rows = await local.outbox.toArray();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe("pending");
    expect(row.method).toBe("POST");
    expect(row.endpoint).toBe("/v1/branches/B1/daily-close");
    expect(row.payload).toMatchObject({
      business_date: "2026-06-11",
      cash_counted_ngn: 1500,
      transfers_counted_ngn: 0,
      notes: "all good",
      stock_counts: [{ product_id: "p1", counted_quantity: 7 }],
    });
  });

  it("omits notes when not provided", async () => {
    await createLocalClose({
      branchId: "B1",
      business_date: "2026-06-11",
      cash_counted_ngn: 0,
      transfers_counted_ngn: 0,
      stock_counts: [{ product_id: "p1", counted_quantity: 0 }],
    });
    const row = (await local.outbox.toArray())[0]!;
    expect(row.payload).not.toHaveProperty("notes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/admin test src/sync/local-close.test.ts`
Expected: FAIL — cannot resolve `./local-close.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/admin/src/sync/local-close.ts`:

```ts
import { local } from "../db/local.js";

export interface LocalCloseInput {
  branchId: string;
  business_date: string;
  cash_counted_ngn: number;
  transfers_counted_ngn: number;
  notes?: string;
  stock_counts: Array<{
    product_id: string;
    counted_quantity: number;
    variance_reason?: string;
  }>;
}

/**
 * Queue a daily-close submission through the outbox so it survives a bad
 * network. The server upsert is idempotent on (branch_id, business_date), so
 * the row id doubles as a replay-safe Idempotency-Key.
 */
export async function createLocalClose(input: LocalCloseInput): Promise<void> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await local.outbox.put({
    id,
    endpoint: `/v1/branches/${input.branchId}/daily-close`,
    method: "POST",
    payload: {
      business_date: input.business_date,
      cash_counted_ngn: input.cash_counted_ngn,
      transfers_counted_ngn: input.transfers_counted_ngn,
      ...(input.notes ? { notes: input.notes } : {}),
      stock_counts: input.stock_counts,
    },
    attempt_count: 0,
    next_attempt_at: now,
    status: "pending",
    created_at_local: now,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/admin test src/sync/local-close.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/sync/local-close.ts apps/admin/src/sync/local-close.test.ts
git commit -m "feat(admin): queue daily close through the outbox"
```

---

### Task 9: Wire Daily Close to offline preview + outbox submit (`close.tsx`)

**Files:**
- Modify: `apps/admin/src/routes/branch/close.tsx`

Wiring; covered by Tasks 7–8 unit tests + Task 10 e2e.

- [ ] **Step 1: Add imports**

In `apps/admin/src/routes/branch/close.tsx`, add to the import block:

```ts
import { createLocalClose } from "../../sync/local-close.js";
import { localExpectedStock, localExpectedCash } from "../../sync/close-preview.js";
```

- [ ] **Step 2: Add an offline-estimate flag**

Add next to the other `useState` declarations:

```ts
  const [offlineEstimate, setOfflineEstimate] = useState(false);
```

- [ ] **Step 3: Fall back to the local preview on fetch failure**

Replace the preview `useEffect`'s inner `try { ... } catch (err) { ... }` so the catch computes the local preview instead of only setting an error. The full effect becomes:

```tsx
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await api<PreviewBody>(
          `/branches/${branchId}/daily-close/preview?date=${businessDate}`,
        );
        if (!cancelled) {
          setPreview(res.data);
          setOfflineEstimate(false);
          const init: Record<string, string> = {};
          for (const [pid, qty] of Object.entries(res.data.expected_stock)) {
            init[pid] = String(qty);
          }
          setCounts(init);
        }
      } catch {
        // Offline or server unreachable: compute the preview from the local
        // mirror so the cashier can still close.
        const expected_stock = await localExpectedStock(branchId);
        const expected_cash_ngn = await localExpectedCash(branchId, businessDate);
        if (!cancelled) {
          setPreview({ expected_cash_ngn, expected_stock });
          setOfflineEstimate(true);
          const init: Record<string, string> = {};
          for (const [pid, qty] of Object.entries(expected_stock)) {
            init[pid] = String(qty);
          }
          setCounts(init);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId, businessDate]);
```

- [ ] **Step 4: Submit through the outbox**

In `submit()`, replace the `await api(\`/branches/${branchId}/daily-close\`, { ... });` call with:

```tsx
      await createLocalClose({
        branchId,
        business_date: businessDate,
        cash_counted_ngn: Number(cash) || 0,
        transfers_counted_ngn: Number(transfers) || 0,
        notes: notes || undefined,
        stock_counts: stockRows.map((r) => ({
          product_id: r.product_id,
          counted_quantity: r.counted,
          variance_reason: r.variance !== 0 ? r.reason : undefined,
        })),
      });
```

And change the success flash line to:

```tsx
      setFlash("Close saved — will submit when online.");
```

- [ ] **Step 5: Show the offline-estimate badge**

Immediately after the opening `<BranchShell branchId={branchId} title="Daily close">` tag, add:

```tsx
      {offlineEstimate && (
        <div
          className="card"
          style={{
            background: "rgba(245,158,11,0.10)",
            borderColor: "rgba(245,158,11,0.25)",
            color: "#92400e",
            marginBottom: 16,
          }}
        >
          Offline estimate — expected cash excludes any same-day refunds and will
          be recomputed by the server when this close syncs.
        </div>
      )}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @ms/admin exec tsc --noEmit`
Expected: no errors. (`api` is still imported and used for the online preview path.)

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/routes/branch/close.tsx
git commit -m "feat(admin): daily close works offline (local preview + outbox submit)"
```

---

### Task 10: Offline e2e capstone (`offline-resilience.spec.ts`)

**Files:**
- Create: `apps/admin/e2e/offline-resilience.spec.ts`

**Prerequisites:** the full local stack running and seeded per the `reference_local_run` memory (pg + redis with published ports, `DATABASE_URL` exported, migrate + seed, API on :3001, admin dev on :3010). These tests drive a real browser with `context.setOffline`.

- [ ] **Step 1: Inspect the existing e2e for the login helper & base URL**

Run: `cat apps/admin/e2e/smoke.spec.ts`
Expected: note how it authenticates (seeded credentials, login form fill) and the `baseURL` (`http://localhost:3010` from `playwright.config.ts`). Reuse the same login steps below — replace the `EMAIL`/`PASSWORD` constants with whatever the smoke test uses.

- [ ] **Step 2: Write the spec**

Create `apps/admin/e2e/offline-resilience.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

// Match the seeded branch-staff credentials used by smoke.spec.ts.
const EMAIL = "staff@mrssamuel.ng";
const PASSWORD = "password123";

async function login(page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("offline reload keeps the cashier logged in", async ({ page, context }) => {
  await login(page);
  await page.goto("/branch/sell");
  await expect(page).toHaveURL(/\/branch\/sell/);

  await context.setOffline(true);
  await page.reload();

  // Must NOT bounce to /login while offline.
  await expect(page).toHaveURL(/\/branch\/sell/);
  await expect(page.getByText(/offline/i)).toBeVisible();

  await context.setOffline(false);
});

test("a sale rung up offline syncs after reconnect", async ({ page, context }) => {
  await login(page);
  await page.goto("/branch/sell");

  await context.setOffline(true);
  // Add the first available product to the cart and charge.
  await page.locator(".card--hoverable").first().click();
  await page.getByRole("button", { name: /charge/i }).click();
  await expect(page.getByText(/saved locally/i)).toBeVisible();
  await expect(page.getByText(/offline/i)).toBeVisible();

  await context.setOffline(false);
  // The sync badge should resolve to Synced once the outbox drains.
  await expect(page.getByText(/synced/i)).toBeVisible({ timeout: 60_000 });
});
```

- [ ] **Step 3: Run the e2e (stack must be up)**

Run: `pnpm --filter @ms/admin test:e2e offline-resilience`
Expected: PASS (2 tests). If the product/charge selectors differ, adjust to match `sell.tsx` (product tiles use `.card--hoverable`; the charge button label starts with "Charge").

- [ ] **Step 4: Commit**

```bash
git add apps/admin/e2e/offline-resilience.spec.ts
git commit -m "test(admin): e2e for offline reload + offline sale recovery"
```

---

### Task 11: Full verification

- [ ] **Step 1: Lint the repo**

Run: `pnpm lint`
Expected: 0 errors (warnings tolerated per the existing baseline).

- [ ] **Step 2: Typecheck the repo**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Run the admin unit suite**

Run: `pnpm --filter @ms/admin test`
Expected: PASS — `session`, `api`, `auth-state`, `engine` (incl. new 401 tests), `close-preview`, `local-close` all green.

- [ ] **Step 4: Build the admin app**

Run: `pnpm --filter @ms/admin build`
Expected: build succeeds.

- [ ] **Step 5: Final commit (if anything was adjusted)**

```bash
git add -A
git commit -m "chore(admin): till network resilience — verification pass"
```

---

## Notes for the implementer

- **Do not push to `master`.** This branch is `feat/till-network-resilience`; integration (PR/merge) is a separate, explicit decision.
- The repo working tree already contained unrelated uncommitted changes before this plan (OPay/delivery/customers + migrations). Only stage the files named in each task's commit — never `git add -A` except in Task 11 Step 5, and even then verify `git status` first so you don't sweep up unrelated work.
- Server-side needs **no** changes: `/v1/auth/refresh` already exists, and the daily-close POST is already idempotent on `(branch_id, business_date)`.
- Phase 2 (cold offline PIN login) is intentionally out of scope; it gets its own spec.
```

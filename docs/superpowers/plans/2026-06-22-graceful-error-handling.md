# Graceful Error Handling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every failure in the app (admin/POS, customer storefront, worker/cron, API) lands gracefully — no blank screens, no raw stack traces, no technical tokens, no silently-skipped background jobs — and make the audit log fully readable to a non-developer.

**Architecture:** Build the missing structural primitives once (route-level error boundaries via TanStack `defaultErrorComponent`, a customer fetch with retry/backoff, a worker job-isolation wrapper, an admin `<DataState>`), then sweep each surface to use them. The API and admin client are already mature; this is a coverage/consistency hardening pass, not a rebuild.

**Tech Stack:** TypeScript, React, TanStack Router (admin 1.49.1, customer 1.168.25), Hono (API), pino (worker), Vitest + @testing-library/react.

## Global Constraints

- Both frontends are PWAs — shipped fixes reach open tills only after the service-worker auto-update + chunk-reload cycle (already in place). Do not add new SW logic.
- Customer `apiFetch` runs inside TanStack server functions — retries stay server-side and MUST NOT change the `ApiError` serialization contract used by `asApiError`.
- Admin error copy is for non-technical shop staff; never surface a raw `err.message`. Always route through `humanizeError` (`apps/admin/src/lib/api.ts`).
- Worker has NO Sentry (only the API does). Worker job isolation logs via the existing pino `logger`; do not add Sentry to the worker.
- Phased ship: land + verify each phase before the next. Order: admin/POS → customer → worker → API → audit.
- Run unit tests per workspace with `pnpm --filter <pkg> test` (admin: `@ms/admin`, customer: `@ms/customer`, worker: `@ms/worker` — confirm names in each `package.json`).
- TanStack `defaultErrorComponent` catches errors thrown during a route's render and loader; it isolates the failing route while keeping the rest of the app mounted.

---

## Phase 1 — Admin / POS

### Task 1: Admin route-level error isolation

A single route render/loader crash currently blanks the whole admin app (only one app-level `ErrorBoundary` exists). Add a route-scoped error component so a crash on the till or any owner screen isolates to that screen.

**Files:**
- Create: `apps/admin/src/components/RouteErrorComponent.tsx`
- Create: `apps/admin/src/components/RouteErrorComponent.test.tsx`
- Modify: `apps/admin/src/router.tsx` (the `createRouter({ ... })` call, ~line 666)

**Interfaces:**
- Produces: `RouteErrorComponent` — a TanStack `ErrorComponent` `(props: { error: Error; reset: () => void }) => JSX.Element`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/admin/src/components/RouteErrorComponent.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RouteErrorComponent } from "./RouteErrorComponent.js";

describe("RouteErrorComponent", () => {
  it("shows a friendly message and a working retry button", () => {
    const reset = vi.fn();
    render(<RouteErrorComponent error={new Error("boom")} reset={reset} />);
    expect(screen.getByText(/couldn't load this screen/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("never renders the raw error message to staff", () => {
    render(<RouteErrorComponent error={new Error("TypeError: x is undefined")} reset={() => {}} />);
    expect(screen.queryByText(/TypeError/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/admin test -- RouteErrorComponent`
Expected: FAIL — cannot find `./RouteErrorComponent.js`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// apps/admin/src/components/RouteErrorComponent.tsx
import { useEffect } from "react";
import { humanizeError } from "../lib/api.js";
import { isChunkLoadError, reloadOnceForStaleChunk, browserReloadEnv } from "../lib/chunk-reload.js";

/**
 * Route-scoped error UI. TanStack Router renders this in place of a route whose
 * render or loader threw, so the failure is contained to that screen while the
 * nav and every other tab stay usable. Staff see a friendly line (never the raw
 * error); a stale-chunk crash self-heals with a single reload.
 */
export function RouteErrorComponent({ error, reset }: { error: Error; reset: () => void }): JSX.Element {
  useEffect(() => {
    if (isChunkLoadError(error)) reloadOnceForStaleChunk(browserReloadEnv());
    else console.error("[admin] route error", error);
  }, [error]);

  return (
    <main style={{ padding: 24, display: "grid", placeItems: "center", minHeight: "60vh", textAlign: "center" }}>
      <div style={{ maxWidth: 460 }}>
        <div className="t-eyebrow" style={{ marginBottom: 8 }}>Error</div>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 8px" }}>We couldn't load this screen.</h1>
        <p style={{ color: "var(--ink-soft)", margin: "0 0 16px" }}>{humanizeError(error)}</p>
        <button type="button" className="btn btn--primary" onClick={reset}>Try again</button>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/admin test -- RouteErrorComponent`
Expected: PASS (both tests).

- [ ] **Step 5: Wire it into the router**

In `apps/admin/src/router.tsx`, add the import near the other component imports (top of file):

```tsx
import { RouteErrorComponent } from "./components/RouteErrorComponent.js";
```

Change the router creation (currently lines ~666-669):

```tsx
export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFound,
  defaultErrorComponent: RouteErrorComponent,
});
```

- [ ] **Step 6: Verify build + typecheck**

Run: `pnpm --filter @ms/admin build`
Expected: succeeds, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/components/RouteErrorComponent.tsx apps/admin/src/components/RouteErrorComponent.test.tsx apps/admin/src/router.tsx
git commit -m "feat(admin): isolate route crashes with a friendly route error boundary"
```

---

### Task 2: Admin `<DataState>` primitive + audit-log adoption

Pages that fetch on mount currently do `catch → toast → leave content blank` — a failed GET shows nothing. Add a reusable wrapper that renders loading / error+retry / empty / content, and adopt it on the audit-log page as the exemplar.

**Files:**
- Create: `apps/admin/src/components/DataState.tsx`
- Create: `apps/admin/src/components/DataState.test.tsx`
- Modify: `apps/admin/src/routes/owner/audit-log.tsx`

**Interfaces:**
- Consumes: `humanizeError` (`apps/admin/src/lib/api.ts`), `InlineLoader` (`apps/admin/src/components/Spinner.js`).
- Produces: `DataState` — `(props: { loading: boolean; error: unknown; isEmpty?: boolean; emptyTitle?: string; emptyHint?: string; onRetry: () => void; children: ReactNode }) => JSX.Element`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/admin/src/components/DataState.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DataState } from "./DataState.js";

describe("DataState", () => {
  it("shows children when loaded with data", () => {
    render(<DataState loading={false} error={null} onRetry={() => {}}><p>hello</p></DataState>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
  it("shows a retry button on error and calls onRetry", () => {
    const onRetry = vi.fn();
    render(<DataState loading={false} error={new Error("x")} onRetry={onRetry}><p>hello</p></DataState>);
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });
  it("shows the empty state when isEmpty", () => {
    render(<DataState loading={false} error={null} isEmpty emptyTitle="Nothing here" onRetry={() => {}}><p>hello</p></DataState>);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/admin test -- DataState`
Expected: FAIL — cannot find `./DataState.js`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// apps/admin/src/components/DataState.tsx
import type { ReactNode } from "react";
import { InlineLoader } from "./Spinner.js";
import { humanizeError } from "../lib/api.js";

/**
 * One pattern for every page that loads data on mount: loading → error+retry →
 * empty → content. Keeps a failed GET from leaving a blank screen, and gives the
 * user a one-click retry instead of a dead end.
 */
export function DataState({
  loading,
  error,
  isEmpty = false,
  emptyTitle = "Nothing to show",
  emptyHint = "There's nothing here yet.",
  onRetry,
  children,
}: {
  loading: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  onRetry: () => void;
  children: ReactNode;
}): JSX.Element {
  if (loading) return <InlineLoader />;
  if (error) {
    return (
      <div className="empty" style={{ display: "grid", gap: 12, justifyItems: "center" }}>
        <div className="empty__title">We couldn't load this</div>
        <div style={{ color: "var(--ink-soft)", maxWidth: 420, textAlign: "center" }}>{humanizeError(error)}</div>
        <button type="button" className="btn btn--primary btn--sm" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  if (isEmpty) {
    return (
      <div className="empty">
        <div className="empty__title">{emptyTitle}</div>
        {emptyHint}
      </div>
    );
  }
  return <>{children}</>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/admin test -- DataState`
Expected: PASS (all three).

- [ ] **Step 5: Adopt on the audit-log page**

In `apps/admin/src/routes/owner/audit-log.tsx`:

Add an error state next to `loading` (after the `const [loading, setLoading] = useState(true);` line):

```tsx
  const [loadError, setLoadError] = useState<unknown>(null);
```

Add the import (with the other component imports):

```tsx
import { DataState } from "../../components/DataState.js";
```

In `load()`, capture the error into state instead of only toasting:

```tsx
  async function load(): Promise<void> {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (entityType) params.set("entity_type", entityType);
      if (action) params.set("action", action);
      if (actorUserId) params.set("actor_user_id", actorUserId);
      if (from) params.set("from", new Date(from).toISOString());
      if (to) params.set("to", new Date(to).toISOString());
      params.set("limit", "100");
      const res = await api<{ data: AuditRow[] }>(`/audit-log?${params}`);
      setRows(res.data);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }
```

Replace the `{loading ? (<InlineLoader />) : rows.length === 0 ? (...) : (<div className="table-wrap">...)}` block with a `DataState` wrapper:

```tsx
      <DataState
        loading={loading}
        error={loadError}
        isEmpty={rows.length === 0}
        emptyTitle="No activity in view"
        emptyHint="Adjust filters or wait for new activity."
        onRetry={() => void load()}
      >
        <div className="table-wrap">
          {/* ...existing <table className="table"> ... unchanged ... */}
        </div>
      </DataState>
```

Remove the now-unused `InlineLoader` import if nothing else on the page uses it (check first).

- [ ] **Step 6: Verify build**

Run: `pnpm --filter @ms/admin build`
Expected: succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/components/DataState.tsx apps/admin/src/components/DataState.test.tsx apps/admin/src/routes/owner/audit-log.tsx
git commit -m "feat(admin): add DataState wrapper; audit-log no longer blanks on a failed load"
```

---

### Task 3: Admin humanizeError consistency sweep

48 route files surface raw `err.message` to staff via the pattern `err instanceof Error ? err.message : String(err)`. Replace each with `humanizeError(err)` so the friendly wording (and network/validation translation) is used everywhere.

**Files:**
- Modify: all 48 files under `apps/admin/src/routes/` matching the pattern (enumerated below).

**Interfaces:**
- Consumes: `humanizeError` (`apps/admin/src/lib/api.ts`).

- [ ] **Step 1: Find every occurrence**

Run: `grep -rn "err instanceof Error ? err.message" apps/admin/src/routes`
Expected: ~48 matches across the files listed in the design doc (branch/*, factory/*, owner/*, transfers*, transfer-detail).

- [ ] **Step 2: Replace the expression**

For each match, replace:

```tsx
err instanceof Error ? err.message : String(err)
```

with:

```tsx
humanizeError(err)
```

Most occurrences are inside `toast.error(...)` or `setError(...)`. The `catch (err)` binding name is already `err`; keep it.

- [ ] **Step 3: Add the import to each touched file**

If a file does not already import `humanizeError`, add it to its existing `../../lib/api.js` (or `../lib/api.js`, depending on depth) import. Example for `apps/admin/src/routes/owner/audit-log.tsx`:

```tsx
import { api, humanizeError } from "../../lib/api.js";
```

For `apps/admin/src/routes/transfers.tsx` and `transfer-detail.tsx` (one level under `routes/`), the path is `../lib/api.js`.

- [ ] **Step 4: Verify no occurrences remain**

Run: `grep -rn "instanceof Error ? err.message" apps/admin/src/routes`
Expected: no matches.

- [ ] **Step 5: Verify build + tests**

Run: `pnpm --filter @ms/admin build && pnpm --filter @ms/admin test`
Expected: build succeeds; existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/routes
git commit -m "refactor(admin): route catches use humanizeError instead of raw err.message"
```

---

## Phase 2 — Customer storefront

### Task 4: Customer `apiFetch` retry/backoff

A transient 502 during an API restart fails the customer instantly. Add admin-style retry/backoff (GET-safe) while preserving the `ApiError` serialization contract.

**Files:**
- Modify: `apps/customer/src/lib/api/client.ts`
- Modify: `apps/customer/src/lib/api/client.test.ts`

**Interfaces:**
- Produces: `apiFetch<T>(path, init?)` — unchanged signature; now retries network + 429/502/503/504 with backoff. `ApiError` / `serialize` / `asApiError` unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `apps/customer/src/lib/api/client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch, ApiError } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("apiFetch retry", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("retries a 502 then succeeds, returning data", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(502, { error: { code: "upstream", message: "bad gateway" } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    const out = await apiFetch<{ ok: boolean }>("/health");
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a real 404", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(404, { error: { code: "not_found", message: "nope" } }));
    await expect(apiFetch("/missing")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after max attempts on persistent network failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(apiFetch("/health")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ms/customer test -- client`
Expected: FAIL — current `apiFetch` calls fetch once (no retry).

- [ ] **Step 3: Implement retry/backoff**

Replace the body of `apiFetch` in `apps/customer/src/lib/api/client.ts` (keep `ApiError`, `serialize`, `asApiError` untouched). Add the constants and a backoff helper above it:

```ts
// Gateway/transient statuses worth retrying — these appear while the API is
// restarting (nginx can't reach the upstream yet) or briefly overloaded.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

function backoff(attempt: number): Promise<void> {
  const base = 300 * 2 ** (attempt - 1); // 300ms, 600ms, 1200ms
  return new Promise((r) => setTimeout(r, base + Math.random() * 200));
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const last = attempt === MAX_ATTEMPTS;

    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: { accept: "application/json", ...(init?.headers ?? {}) },
      });
    } catch (err) {
      if (last) throw new ApiError("network_error", err instanceof Error ? err.message : "network error", 0);
      await backoff(attempt);
      continue;
    }

    if (RETRYABLE_STATUS.has(res.status) && !last) {
      await backoff(attempt);
      continue;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      if (res.ok) return undefined as T;
      throw new ApiError("upstream_error", `API ${res.status}`, res.status);
    }

    const json = (await res.json()) as { data?: T; error?: { code: string; message: string } };
    if (!res.ok || json.error) {
      const e = json.error ?? { code: "upstream_error", message: `API ${res.status}` };
      throw new ApiError(e.code, e.message, res.status);
    }
    return json.data as T;
  }
  // Unreachable — the loop returns or throws.
  throw new ApiError("network_error", "network error", 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ms/customer test -- client`
Expected: PASS (all retry tests + existing client tests).

- [ ] **Step 5: Commit**

```bash
git add apps/customer/src/lib/api/client.ts apps/customer/src/lib/api/client.test.ts
git commit -m "feat(customer): apiFetch retries transient gateway/network errors with backoff"
```

---

### Task 5: Customer route-level error + pending isolation

Only `__root.tsx` defines `errorComponent`; a leaf-route loader failure bubbles to root and blanks the whole site (nav + footer gone). Extract the root's error UI into a shared `<RouteError>` and set it as `defaultErrorComponent` so a leaf error is caught at the leaf, preserving the layout.

**Files:**
- Create: `apps/customer/src/components/RouteError.tsx`
- Modify: `apps/customer/src/router.tsx`
- Modify: `apps/customer/src/routes/__root.tsx` (reuse the shared component)

**Interfaces:**
- Produces: `RouteError` — `(props: { error: Error; reset: () => void }) => JSX.Element` (uses `useRouter().invalidate()` + `reset()` for the retry).

- [ ] **Step 1: Create the shared component**

```tsx
// apps/customer/src/components/RouteError.tsx
import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { reportLovableError } from "../lib/lovable-error-reporting";

/**
 * Friendly, retryable error UI shared by the root boundary and every route's
 * defaultErrorComponent. As a route-level boundary it isolates a failed leaf
 * loader/render, so the nav and the rest of the site stay usable.
 */
export function RouteError({ error, reset }: { error: Error; reset: () => void }): JSX.Element {
  const router = useRouter();
  useEffect(() => {
    console.error(error);
    reportLovableError(error, { boundary: "tanstack_route_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">This page didn't load</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try again or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Set it as the router default**

In `apps/customer/src/router.tsx`, import and register it:

```tsx
import { RouteError } from "./components/RouteError";
// ...
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: RouteError,
  });
```

- [ ] **Step 3: Reuse it in the root route**

In `apps/customer/src/routes/__root.tsx`, replace the local `ErrorComponent` function and its `errorComponent: ErrorComponent` reference with the shared component:

```tsx
import { RouteError } from "../components/RouteError";
// ...delete the local `function ErrorComponent({ error, reset }) { ... }` block...
// ...in the route options:
  errorComponent: RouteError,
```

- [ ] **Step 4: Verify build + typecheck**

Run: `pnpm --filter @ms/customer build`
Expected: succeeds; no unused-import or type errors (confirm `useRouter` / `reportLovableError` imports removed from `__root.tsx` if no longer used there).

- [ ] **Step 5: Commit**

```bash
git add apps/customer/src/components/RouteError.tsx apps/customer/src/router.tsx apps/customer/src/routes/__root.tsx
git commit -m "feat(customer): isolate leaf-route errors with a shared route error boundary"
```

---

## Phase 3 — Worker / cron

### Task 6: Worker job isolation

If an early job in the 5s tick throws, every later job is skipped until the next tick. Wrap each job so a failure logs and the rest still run, and apply the same isolation inside `runDueCronJobs`.

**Files:**
- Create: `apps/worker/src/jobs/run-job.ts`
- Create: `apps/worker/test/run-job.test.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/jobs/cron.ts`

**Interfaces:**
- Produces: `runJob<T>(logger: { error: (obj: object, msg?: string) => void }, name: string, fn: () => Promise<T>): Promise<T | undefined>` — runs `fn`; on throw, logs `{ err, job: name }` and returns `undefined` (never rethrows).

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/test/run-job.test.ts
import { describe, it, expect, vi } from "vitest";
import { runJob } from "../src/jobs/run-job.js";

const fakeLogger = { error: vi.fn() };

describe("runJob", () => {
  it("returns the job result on success", async () => {
    const out = await runJob(fakeLogger, "ok", async () => 42);
    expect(out).toBe(42);
  });

  it("swallows a throw, logs it, and returns undefined", async () => {
    fakeLogger.error.mockClear();
    const out = await runJob(fakeLogger, "boom", async () => {
      throw new Error("kaboom");
    });
    expect(out).toBeUndefined();
    expect(fakeLogger.error).toHaveBeenCalledTimes(1);
    const [obj] = fakeLogger.error.mock.calls[0];
    expect(obj).toMatchObject({ job: "boom" });
  });

  it("does not let one failing job stop the next", async () => {
    const second = vi.fn(async () => "ran");
    await runJob(fakeLogger, "first", async () => { throw new Error("x"); });
    const out = await runJob(fakeLogger, "second", second);
    expect(second).toHaveBeenCalled();
    expect(out).toBe("ran");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ms/worker test -- run-job`
Expected: FAIL — cannot find `../src/jobs/run-job.js`.

- [ ] **Step 3: Implement the helper**

```ts
// apps/worker/src/jobs/run-job.ts
/**
 * Run a single worker job in isolation. A throw is logged with the job name and
 * swallowed, so one failing job never starves the others in the same tick.
 * Returns the job's result on success, or undefined on failure.
 */
export async function runJob<T>(
  logger: { error: (obj: object, msg?: string) => void },
  name: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, job: name }, "worker job failed");
    return undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ms/worker test -- run-job`
Expected: PASS (all three).

- [ ] **Step 5: Apply in the main loop**

In `apps/worker/src/index.ts`, import the helper and wrap each job. Replace the inner body of the `while (!stopping)` `try` block so each job is isolated. Example for the first few (apply the same wrap to `drainOutbox`, the reservation sweep, late-close, reminders, delivery-watchdog, cron, audit-export):

```ts
import { runJob } from "./jobs/run-job.js";
// ...
      const processed = await runJob(logger, "outbox", () => drainOutbox(db));
      if ((processed ?? 0) > 0) logger.info({ processed }, "outbox batch drained");

      const now = Date.now();
      if (now - lastSweepAt > SWEEP_INTERVAL_MS) {
        const swept = await runJob(logger, "reservation_sweep", () => sweepExpiredReservations(db));
        if ((swept ?? 0) > 0) logger.info({ swept }, "expired reservations swept");
        lastSweepAt = now;
      }
```

Continue the same pattern for: `checkLateCloses` → `runJob(logger, "late_close", ...)`, `queuePaymentReminders` → `"payment_reminders"`, `runDeliveryWatchdog` → `"delivery_watchdog"`, `runDueCronJobs` → `"cron"` (replacing its existing inline try/catch), and `exportAuditLog` → `"audit_export"`. Keep the outer `try/catch` as a final safety net. For numeric guards that previously read e.g. `if (swept > 0)`, use `(swept ?? 0) > 0` since `runJob` may return `undefined`.

For `exportAuditLog`, preserve the skip/log behaviour:

```ts
      if (isAuditExportWindow(lastAuditExportDate)) {
        const result = await runJob(logger, "audit_export", () => exportAuditLog(db));
        if (result && !result.skipped) {
          logger.info({ key: result.key, bytes: result.bytes }, "audit export uploaded");
        }
        lastAuditExportDate = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
      }
```

- [ ] **Step 6: Isolate the cron sub-jobs**

In `apps/worker/src/jobs/cron.ts`, import a logger and wrap the three sub-jobs so a P&L digest failure can't abort recurring-expense + subscription billing. Add a `logger` parameter to `runDueCronJobs` (caller already has one) OR use a module pino logger. Use the parameter approach to keep it testable:

```ts
import pino from "pino";
import { runJob } from "./run-job.js";
const cronLogger = pino({ base: { service: "ms-worker", scope: "cron" } });

export async function runDueCronJobs(db: DbClient): Promise<void> {
  const lagos = nowLagos();
  if (shouldFirePnlDigestNow(lagos)) {
    const prevMonthIso = (() => {
      const y = lagos.month === 1 ? lagos.year - 1 : lagos.year;
      const m = lagos.month === 1 ? 12 : lagos.month - 1;
      return `${y}-${String(m).padStart(2, "0")}`;
    })();
    if (await claimCronRun(db, "pnl_monthly_digest", prevMonthIso)) {
      await runJob(cronLogger, "pnl_digest", () => fireMonthlyPnlDigest(db, prevMonthIso));
    }
  }
  if (lagos.hour >= 6) {
    const todayIso = `${lagos.year}-${String(lagos.month).padStart(2, "0")}-${String(lagos.day).padStart(2, "0")}`;
    if (await claimCronRun(db, "recurring_expenses", todayIso)) {
      await runJob(cronLogger, "recurring_expenses", () => sweepRecurringExpenses(db, todayIso, lagos));
    }
  }
  await runJob(cronLogger, "subscription_billing", () => sweepSubscriptionBilling(db));
  await runJob(cronLogger, "past_due_cancellations", () => sweepPastDueCancellations(db));
}
```

Note: `claimCronRun` stays OUTSIDE `runJob` — a claim error is a real DB problem that should propagate to the outer guard, and we must not mark a job claimed-but-failed silently without the run actually attempted. (The claim is followed immediately by the isolated run.)

- [ ] **Step 7: Verify build + tests**

Run: `pnpm --filter @ms/worker build && pnpm --filter @ms/worker test`
Expected: build succeeds; `run-job`, `cron`, and `outbox` tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/jobs/run-job.ts apps/worker/test/run-job.test.ts apps/worker/src/index.ts apps/worker/src/jobs/cron.ts
git commit -m "feat(worker): isolate each job so one failure can't starve the others"
```

---

## Phase 4 — API backend (verification)

### Task 7: Normalize stray API error responses

The API is mature (`onError` + `AppError`), but verify no handler throws a raw `Error` or returns an ad-hoc error envelope that bypasses the central handler (such errors would lose the `code` + `request_id`).

**Files:**
- Modify: only files found to bypass `AppError` (likely few or none).

**Interfaces:**
- Consumes: `AppError`, `BusinessError`, `SystemError` (`apps/api/src/lib/errors.ts`).

- [ ] **Step 1: Find ad-hoc error responses in routes**

Run: `grep -rn "c.json({ error" apps/api/src/routes apps/api/src/auth`
Expected: a list. The legitimate ones are inside `onError` itself; route-level ones that build `{ error: ... }` by hand are candidates to normalize.

- [ ] **Step 2: Find raw throws that aren't AppError**

Run: `grep -rn "throw new Error(" apps/api/src/routes apps/api/src/auth apps/api/src/payments apps/api/src/delivery`
Expected: a list. A `throw new Error(...)` inside a request handler returns a generic 500; if it represents a user-facing condition it should be an `AppError` with a code + status.

- [ ] **Step 3: Normalize each genuine gap**

For each handler-level raw throw that represents a known condition, convert it. Example shape:

```ts
import { BusinessError } from "../lib/errors.js";
// before: throw new Error("branch not found");
// after:
throw new BusinessError("not_found", "branch not found", 404);
```

Leave truly-unexpected throws (programming invariants) as-is — `onError` already turns them into a safe `internal_error` with a `request_id`. Only convert throws that map to a real client-facing outcome. If Step 1/2 surface nothing actionable, record that and skip to Step 4 — this is a verification pass.

- [ ] **Step 4: Verify tests**

Run: `pnpm --filter @ms/api test`
Expected: existing API suites pass (re-run any flaky testcontainer file individually per the quality-gates note).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "refactor(api): route errors flow through AppError + onError (verification pass)"
```

If no changes were needed, skip the commit and note "API verification: no gaps found" in the phase summary.

---

## Phase 5 — Audit-log readability

### Task 8: Graceful fallbacks for unmapped audit entities, types, and diffs

`humanizeAction` already tidies unmapped actions, but `humanizeEntity` falls back to a bare UUID slice, `entityTypeLabel` returns the raw type, and `humanizeDiff` returns nothing for entity types without a field-label map — so a non-developer can still meet a hex string or an empty "what changed" view.

**Files:**
- Modify: `apps/admin/src/lib/audit-humanize.ts`
- Create: `apps/admin/src/lib/audit-humanize.test.ts`

**Interfaces:**
- Consumes: existing `tidy`, `pick`, `j`, `AuditRow`, `entityTypeLabel` (same file).
- Produces: improved `humanizeEntity`, `entityTypeLabel`, `humanizeDiff` (signatures unchanged).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/admin/src/lib/audit-humanize.test.ts
import { describe, it, expect } from "vitest";
import { humanizeEntity, entityTypeLabel, humanizeDiff, type AuditRow } from "./audit-humanize.js";

function row(partial: Partial<AuditRow>): AuditRow {
  return {
    id: "1", actorUserId: null, actorRole: null, actorBranchId: null,
    action: "thing.did", entityType: "thing", entityId: "a1b2c3d4e5f6",
    beforeJson: null, afterJson: null, ipAddress: null, userAgent: null,
    occurredAt: new Date().toISOString(), ...partial,
  };
}

describe("entityTypeLabel", () => {
  it("tidies and title-cases an unmapped type instead of returning a raw token", () => {
    expect(entityTypeLabel("some_new_thing")).toBe("Some new thing");
  });
});

describe("humanizeEntity", () => {
  it("prefers a human name field over the UUID", () => {
    expect(humanizeEntity(row({ entityType: "thing", afterJson: { name: "Mango Crush" } }))).toBe("Mango Crush");
  });
  it("falls back to a labeled reference, not a bare hex slice", () => {
    const out = humanizeEntity(row({ entityType: "some_new_thing", afterJson: {} }));
    expect(out).not.toBe("a1b2c3d4");
    expect(out.toLowerCase()).toContain("some new thing");
  });
});

describe("humanizeDiff generic fallback", () => {
  it("diffs primitive fields for an entity type with no field-label map", () => {
    const lines = humanizeDiff({ note: "old", weirdInternalId: "x" }, { note: "new", weirdInternalId: "y" }, "vendor");
    const noteLine = lines.find((l) => l.label.toLowerCase() === "note");
    expect(noteLine).toBeDefined();
    expect(noteLine?.before).toBe("old");
    expect(noteLine?.after).toBe("new");
  });
  it("hides noise fields (ids, timestamps) from the generic diff", () => {
    const lines = humanizeDiff({ id: "1", createdAt: "t", note: "a" }, { id: "1", createdAt: "t2", note: "b" }, "vendor");
    expect(lines.some((l) => l.field === "id" || l.field === "createdAt")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ms/admin test -- audit-humanize`
Expected: FAIL — current `entityTypeLabel` returns the raw token, `humanizeEntity` returns the hex slice, `humanizeDiff` returns `[]` for `vendor`.

- [ ] **Step 3: Improve `entityTypeLabel`**

Change its fallback (line ~372) from `return map[entityType] ?? entityType;` to tidy + sentence-case:

```ts
  if (map[entityType]) return map[entityType];
  const words = entityType.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : entityType;
```

- [ ] **Step 4: Improve `humanizeEntity` default**

Replace the `default: return id8;` branch (line ~344) with a generic name probe, then a labeled reference:

```ts
    default: {
      const after = j(row.afterJson);
      const before = j(row.beforeJson);
      const named = pick(after, "name", "title", "label", "email", "code", "number", "orderNumber") ??
        pick(before, "name", "title", "label", "email", "code", "number", "orderNumber");
      if (typeof named === "string" && named.trim()) return named;
      return `${entityTypeLabel(row.entityType)} #${id8}`;
    }
```

- [ ] **Step 5: Add a generic diff fallback**

In `humanizeDiff`, replace `if (!labels) return [];` (line ~469) with a generic path that diffs primitive fields, skipping noise. Add a noise predicate above `humanizeDiff`:

```ts
const NOISE_FIELD = /(^id$|Id$|_id$|At$|_at$|^createdAt|^updatedAt|json$|Json$|hash|token|secret)/;

function genericDiff(b: Record<string, unknown>, a: Record<string, unknown>): DiffLine[] {
  const fields = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out: DiffLine[] = [];
  for (const field of fields) {
    if (NOISE_FIELD.test(field)) continue;
    const bv = b[field];
    const av = a[field];
    if (typeof bv === "object" && bv !== null) continue; // skip nested objects/arrays in the generic view
    if (typeof av === "object" && av !== null) continue;
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    out.push({ field, label: tidyLabel(field), before: fmtValue(field, bv), after: fmtValue(field, av) });
  }
  return out;
}

/** "weirdInternalId" / "reject_reason" → "Weird internal id" / "Reject reason". */
function tidyLabel(field: string): string {
  const words = field.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field;
}
```

Then in `humanizeDiff`:

```ts
  const b = j(before) ?? {};
  const a = j(after) ?? {};
  const labels = FIELD_LABELS[entityType];
  if (!labels) return genericDiff(b as Record<string, unknown>, a as Record<string, unknown>);
  // ...existing mapped path unchanged...
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @ms/admin test -- audit-humanize`
Expected: PASS (all cases).

- [ ] **Step 7: Verify build + full admin tests**

Run: `pnpm --filter @ms/admin build && pnpm --filter @ms/admin test`
Expected: build succeeds; all admin tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/lib/audit-humanize.ts apps/admin/src/lib/audit-humanize.test.ts
git commit -m "feat(admin): audit log never shows raw types, UUIDs, or empty diffs to non-developers"
```

---

## Final verification (after all phases)

- [ ] Run each workspace test suite: `pnpm --filter @ms/admin test`, `pnpm --filter @ms/customer test`, `pnpm --filter @ms/worker test`, `pnpm --filter @ms/api test`.
- [ ] Run lint/typecheck repo-wide per the project's quality gates.
- [ ] Route-walk the admin app with the existing `ui-walk.mjs` harness to confirm 0 blank screens / 0 regressions.
- [ ] Confirm each phase shipped + verified before moving to the next (admin → customer → worker → API → audit).

## Self-Review Notes

- **Spec coverage:** Phase 0 primitives are folded into Tasks 1 (route boundary), 2 (DataState), 4 (customer retry), 5 (RouteError). Phase 1 = Tasks 1-3; Phase 2 = Tasks 4-5; Phase 3 = Task 6; Phase 4 = Task 7; Phase 5 = Task 8. Every spec section maps to a task.
- **Type consistency:** `humanizeError(err: unknown): string` (existing) used by Tasks 1-3; `runJob` signature is identical in its test, helper, and both call sites; `DataState` prop shape matches its test and the audit-log adoption; `humanizeDiff`/`humanizeEntity`/`entityTypeLabel` signatures unchanged.
- **No placeholders:** every code step contains the actual code; the API task (7) is explicitly a verification pass with a defined skip-if-empty outcome.

/**
 * Recovery for stale code-split chunks after a deploy.
 *
 * Route pages are lazy-loaded via dynamic `import()`, so each is a separate
 * hash-named chunk. A deploy replaces those chunks and deletes the old hashes
 * (nginx serves `/assets/*` as `immutable`). A long-open admin tab still holds
 * the previous build's chunk filenames in memory, so the first time it lazily
 * loads a route it hadn't visited yet, the dynamic import 404s with
 * "Failed to fetch dynamically imported module".
 *
 * Reloading once pulls the fresh index.html (served `no-cache`) and its current
 * chunk graph, which resolves it. We guard against reload loops so a genuinely
 * broken build surfaces as an error instead of refreshing forever.
 */

/** True when an error looks like a stale code-split chunk that 404'd post-deploy. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return (
    /failed to fetch dynamically imported module/i.test(msg) || // Chromium
    /error loading dynamically imported module/i.test(msg) || // Firefox
    /importing a module script failed/i.test(msg) || // Safari
    /is not a valid javascript mime type/i.test(msg) // index.html served in place of a missing chunk
  );
}

/** Injectable side-effect surface so the reload guard is unit-testable. */
export interface ReloadEnv {
  now: () => number;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  reload: () => void;
}

const RELOAD_KEY = "ms-admin-chunk-reload-at";
const RELOAD_COOLDOWN_MS = 15_000;

/**
 * Reload once to recover from a stale-chunk error. If a reload was already
 * triggered within the cooldown, do nothing (the failure is persistent, not a
 * stale deploy) and let the caller surface the error. Returns true if it
 * triggered a reload.
 */
export function reloadOnceForStaleChunk(env: ReloadEnv): boolean {
  const last = Number(env.getItem(RELOAD_KEY) ?? "0");
  if (Number.isFinite(last) && last > 0 && env.now() - last < RELOAD_COOLDOWN_MS) {
    return false;
  }
  env.setItem(RELOAD_KEY, String(env.now()));
  env.reload();
  return true;
}

/** Browser-backed ReloadEnv. sessionStorage so the guard resets in a new tab/session. */
export function browserReloadEnv(): ReloadEnv {
  return {
    now: () => Date.now(),
    getItem: (k) => {
      try {
        return window.sessionStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        window.sessionStorage.setItem(k, v);
      } catch {
        /* storage may be unavailable (private mode); reload still proceeds */
      }
    },
    reload: () => window.location.reload(),
  };
}

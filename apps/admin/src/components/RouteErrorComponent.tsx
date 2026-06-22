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

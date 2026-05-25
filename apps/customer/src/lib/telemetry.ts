/**
 * Lightweight client-side error reporting. No external SDK — just hooks
 * window error events and posts them to /v1/public/telemetry/error.
 *
 * Behaviour:
 *   - Captures both `error` and `unhandledrejection`.
 *   - Logs to console regardless.
 *   - POSTs (fire-and-forget) when window.location.hostname is not localhost.
 *   - Rate-limited locally to avoid storms (max 1/sec, 20/min).
 *
 * Drop-in compatible with adding @sentry/browser later; just call its init()
 * before installTelemetry() and the window-level handlers will still fire.
 */

interface ErrorPayload {
  message: string;
  stack?: string;
  url?: string;
  line?: number;
  col?: number;
  ts: string;
  ua: string;
  app: "customer" | "admin";
}

const ENDPOINT = "/v1/public/telemetry/error";
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
let recent: number[] = [];
let lastSent = 0;

function withinRate(): boolean {
  const now = Date.now();
  recent = recent.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) return false;
  if (now - lastSent < 1000) return false;
  recent.push(now);
  lastSent = now;
  return true;
}

export function installTelemetry(app: "customer" | "admin"): void {
  function send(payload: ErrorPayload): void {
    if (!withinRate()) return;
    if (typeof window === "undefined") return;
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") return;
    // Use sendBeacon if available so it survives a navigation.
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) return;
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      /* swallow */
    });
  }

  window.addEventListener("error", (e) => {
    const err = e.error instanceof Error ? e.error : null;
    const payload: ErrorPayload = {
      message: err?.message ?? e.message ?? "unknown error",
      ts: new Date().toISOString(),
      ua: navigator.userAgent,
      app,
    };
    if (err?.stack) payload.stack = err.stack;
    if (e.filename) payload.url = e.filename;
    if (e.lineno) payload.line = e.lineno;
    if (e.colno) payload.col = e.colno;
    console.error("[telemetry]", payload);
    send(payload);
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const payload: ErrorPayload = {
      message: reason instanceof Error ? reason.message : String(reason ?? "unhandled rejection"),
      ts: new Date().toISOString(),
      ua: navigator.userAgent,
      app,
    };
    if (reason instanceof Error && reason.stack) payload.stack = reason.stack;
    console.error("[telemetry] unhandled", payload);
    send(payload);
  });
}

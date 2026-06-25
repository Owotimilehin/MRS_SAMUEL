/**
 * useOnlineOrderSignal — polls GET /online-orders/active-count every 25 s.
 *
 * Returns:
 *   count     — total active awaiting-fulfilment orders right now
 *   newCount  — orders that arrived since the last acknowledge()
 *   acknowledge — clears newCount + advances lastSeen
 *
 * Side-effects on new_since > 0 (fired ONCE per new batch):
 *   • toast.info — "🔔 New online order(s) received"
 *   • (optional) a WebAudio beep, guarded by localStorage flag `onlineOrderChime`
 *     (default ON). Pass { chime: true } to enable.
 *
 * Behaviour:
 *   • Pauses polling while document.hidden (resuming on visibility change)
 *   • Guards against overlapping in-flight requests
 *   • Degrades silently on fetch error (offline till)
 *   • Persists lastSeen in localStorage so a page reload doesn't re-alert
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../lib/toast.js";

const POLL_MS = 25_000;
const LS_LAST_SEEN = "ms_ool_lastSeen";
const LS_CHIME = "onlineOrderChime";

interface ActiveCountResponse {
  data: {
    count: number;
    newest: string | null;   // ISO or null
    new_since: number;       // count of orders created after the ?since= param
  };
}

function readLastSeen(): string | null {
  try {
    return localStorage.getItem(LS_LAST_SEEN);
  } catch {
    return null;
  }
}

function writeLastSeen(v: string): void {
  try {
    localStorage.setItem(LS_LAST_SEEN, v);
  } catch {
    /* private mode — fine */
  }
}

function chimeEnabled(): boolean {
  try {
    const v = localStorage.getItem(LS_CHIME);
    // Default ON — only OFF when explicitly set to "0" or "false"
    return v !== "0" && v !== "false";
  } catch {
    return true;
  }
}

/** Short WebAudio beep — no asset file needed. */
function playChime(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.25);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => void ctx.close();
  } catch {
    /* AudioContext not available (SSR / unsupported) — ignore */
  }
}

interface SignalOptions {
  /** Pass true in BranchShell to enable the chime side-effect. */
  chime?: boolean;
  /** Only start polling when true — lets callers gate on auth. */
  enabled?: boolean;
}

export interface OnlineOrderSignal {
  count: number;
  newCount: number;
  acknowledge: () => void;
}

export function useOnlineOrderSignal(opts: SignalOptions = {}): OnlineOrderSignal {
  const { chime = false, enabled = true } = opts;

  const [count, setCount] = useState(0);
  const [newCount, setNewCount] = useState(0);

  // lastSeen is the ISO timestamp of the newest order we've told the user about.
  const lastSeenRef = useRef<string | null>(readLastSeen());
  // In-flight guard: prevents a slow request from overlapping the next tick.
  const inFlightRef = useRef(false);
  // Track whether we've already fired side-effects for the current new batch.
  const sideEffectFiredRef = useRef(false);

  const poll = useCallback(async () => {
    if (!enabled) return;
    if (inFlightRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;

    inFlightRef.current = true;
    try {
      // A null cursor means a fresh device / cleared storage: this poll is a
      // baseline, not a delta — we set the cursor but suppress the alert.
      const isFirstPoll = lastSeenRef.current === null;
      const since = lastSeenRef.current ?? "";
      const url = `/v1/online-orders/active-count${since ? `?since=${encodeURIComponent(since)}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return; // 401/403/5xx — degrade silently
      const body = (await res.json()) as ActiveCountResponse;
      const { count: c, newest, new_since } = body.data;

      setCount(c);

      if (new_since > 0 && !sideEffectFiredRef.current) {
        sideEffectFiredRef.current = true;
        // Always advance the cursor — even when `newest` is null — so a future
        // poll never re-counts this batch and re-fires the toast after an
        // acknowledge(). Fall back to "now" when the API omits `newest`.
        const cursor = newest ?? new Date().toISOString();
        lastSeenRef.current = cursor;
        writeLastSeen(cursor);
        // On the very first poll (no prior cursor) treat the response as a
        // baseline: record the cursor but suppress the toast/chime so a fresh
        // device doesn't alert for orders that were already there. Only deltas
        // after this baseline alert.
        if (!isFirstPoll) {
          setNewCount((prev) => prev + new_since);
          // Toast (fires in both shells)
          toast.info(
            new_since === 1
              ? "🔔 New online order received — check the queue."
              : `🔔 ${new_since} new online orders received — check the queue.`,
          );
          // Chime (only in BranchShell — caller passes chime:true)
          if (chime && chimeEnabled()) {
            playChime();
          }
        }
      } else if (newest && newest > (lastSeenRef.current ?? "")) {
        // No new_since but newest advanced — advance our cursor silently.
        lastSeenRef.current = newest;
        writeLastSeen(newest);
      }
    } catch {
      /* network/offline — degrade silently */
    } finally {
      inFlightRef.current = false;
    }
  }, [enabled, chime]);

  // Reset the side-effect guard once per new batch (after we've set newCount).
  // The guard is reset when newCount returns to 0 via acknowledge().
  const acknowledge = useCallback(() => {
    setNewCount(0);
    sideEffectFiredRef.current = false;
  }, []);

  useEffect(() => {
    if (!enabled) return;

    // Poll immediately, then on interval.
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);

    // Also poll when the tab becomes visible again (user returns to page).
    const onVisible = (): void => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    // And on window focus (extra safety).
    const onFocus = (): void => void poll();
    window.addEventListener("focus", onFocus);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, poll]);

  return { count, newCount, acknowledge };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, isNotFound } from "@tanstack/react-router";
import { trackOrder } from "@/lib/api/server-fns";
import { ApiError } from "@/lib/api/client";
import { readEntries, removeEntry, reconcileEntries, type ActiveOrder } from "@/lib/ongoing-orders";

/**
 * Site-wide "ongoing order" recovery banner. Surfaces any in-progress order this
 * browser placed (stored at checkout as `ms_track_<orderNumber>`), so a customer
 * who closed the tab can get back to live tracking — or resume an unpaid order —
 * from any page. Each entry is re-authorized server-side (the tracking call
 * checks the phone), and entries self-clear once the order is delivered/closed
 * or after 48h. Client-only: renders nothing on the server (no localStorage).
 */

const isOrderGone = (err: unknown): boolean =>
  isNotFound(err) || (err instanceof ApiError && err.status === 404);

export function OngoingOrders() {
  const [pills, setPills] = useState<ActiveOrder[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    let storage: Storage;
    try {
      storage = window.localStorage;
    } catch {
      return; // storage unavailable (SSR / privacy mode) — nothing to do
    }
    const entries = readEntries(storage);
    if (entries.length === 0) {
      setPills([]);
      return;
    }
    const { active, prune } = await reconcileEntries(
      entries,
      (e) => trackOrder({ data: { orderNumber: e.orderNumber, phone: e.phone } }),
      { now: Date.now(), isNotFound: isOrderGone },
    );
    for (const orderNumber of prune) removeEntry(storage, orderNumber);
    setPills(active);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
      // Only keep polling while the tab is visible — backgrounded tabs idle.
      if (!cancelled && document.visibilityState === "visible") {
        timerRef.current = setTimeout(tick, 60_000);
      }
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timerRef.current);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const dismiss = (orderNumber: string) => {
    try {
      removeEntry(window.localStorage, orderNumber);
    } catch {
      /* ignore */
    }
    setPills((p) => p.filter((x) => x.orderNumber !== orderNumber));
  };

  if (pills.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,28rem)] -translate-x-1/2 flex-col gap-2">
      {pills.map((p) => (
        <div
          key={p.orderNumber}
          className="flex items-center justify-between gap-2 rounded-full border border-black/5 bg-white/95 px-4 py-2.5 shadow-lg backdrop-blur"
        >
          <Link
            to="/order/$orderNumber"
            params={{ orderNumber: p.orderNumber }}
            className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-[color:var(--brand)]"
          >
            <span aria-hidden>🧃</span>
            <span className="truncate">{p.orderNumber}</span>
            <span className="font-normal text-neutral-400">·</span>
            <span className="truncate font-medium text-neutral-700">
              {p.awaitingPayment ? "Resume payment" : p.label}
            </span>
            <span aria-hidden className="ml-auto text-[color:var(--brand)]">
              →
            </span>
          </Link>
          <button
            type="button"
            onClick={() => dismiss(p.orderNumber)}
            aria-label={`Dismiss order ${p.orderNumber}`}
            className="shrink-0 rounded-full p-1 text-neutral-400 transition hover:text-neutral-700"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

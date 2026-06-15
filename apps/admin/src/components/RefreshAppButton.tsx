import { useState } from "react";
import { local } from "../db/local.js";

/**
 * One-tap "force fresh" for the PWA. The admin is a service-worker PWA, so a new
 * deploy can keep serving the old cached UI until the worker is replaced. This
 * button unregisters the worker, clears the Cache Storage precache, and — when
 * there are no unsynced sales — wipes the local till DB so stock re-syncs clean
 * from the server. Then it hard-reloads.
 *
 * Safety: if the outbox still holds pending/in-flight sales, it does the
 * code-only refresh and KEEPS local data so nothing unsynced is lost.
 */
async function clearCaches(): Promise<void> {
  if ("serviceWorker" in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
}

export function RefreshAppButton(): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    try {
      const pending = await local.outbox
        .where("status")
        .anyOf("pending", "in_flight")
        .count();

      if (pending > 0) {
        const ok = window.confirm(
          `You have ${pending} unsynced sale(s). I'll refresh the app but KEEP local data so nothing is lost. ` +
            `Continue?`,
        );
        if (!ok) {
          setBusy(false);
          return;
        }
        await clearCaches();
      } else {
        const ok = window.confirm(
          "Refresh the app and re-sync stock from the server? This clears the cached app and reloads.",
        );
        if (!ok) {
          setBusy(false);
          return;
        }
        await clearCaches();
        try {
          await local.delete(); // drop the local till DB → full re-sync on reload
        } catch {
          /* ignore — caches are cleared, reload still helps */
        }
      }
      // Cache-busting reload so the browser refetches the shell + new worker.
      window.location.reload();
    } catch {
      setBusy(false);
      window.alert("Couldn't refresh automatically. Try a hard refresh (Ctrl+Shift+R).");
    }
  }

  return (
    <button
      type="button"
      className="btn btn--subtle btn--sm"
      disabled={busy}
      onClick={() => void run()}
      title="Clear cached app + re-sync (fixes stale screens after an update)"
    >
      {busy ? "Refreshing…" : "↻ Refresh app"}
    </button>
  );
}

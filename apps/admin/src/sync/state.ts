import { useEffect, useState } from "react";
import { local } from "../db/local.js";

export interface SyncState {
  online: boolean;
  queued: number;
  dead: number;
}

/**
 * Subscribe to sync indicator state for display in the branch shell.
 * Polls the local outbox table every few seconds — cheap because IDB.
 */
export function useSyncState(): SyncState {
  const [state, setState] = useState<SyncState>({
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    queued: 0,
    dead: 0,
  });

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const queued = await local.outbox.where("status").equals("pending").count();
      const dead = await local.outbox.where("status").equals("dead").count();
      if (alive) {
        setState((s) => ({ ...s, queued, dead }));
      }
    };
    void tick();
    const interval = setInterval(tick, 4000);
    const onOnline = (): void => setState((s) => ({ ...s, online: true }));
    const onOffline = (): void => setState((s) => ({ ...s, online: false }));
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      alive = false;
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return state;
}

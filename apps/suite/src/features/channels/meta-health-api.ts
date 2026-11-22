/** GET /v1/meta-health: what the hourly Meta connection check last found (Watchdog, blueprint stage 1). */
import { api } from "@admin/lib/api.js";
import type { MetaHealthItem, MetaHealthStatus } from "@ms/shared";

export interface MetaHealth {
  checked_at: string | null;
  /** The worker has not completed a check for over 3 hours (or never). */
  stale: boolean;
  overall: MetaHealthStatus;
  items: Omit<MetaHealthItem, "alerted_at">[];
}

export const metaHealthKeys = { all: ["meta-health"] as const };

/** A read the screen polls; a failure shows nothing rather than a toast. */
export const metaHealthApi = {
  get: async () => (await api<{ data: MetaHealth }>("/meta-health", {}, { silentError: true })).data,
};

/** sessionStorage key for a dismissed amber banner (by the problems' signature). */
export const HEALTH_DISMISS_KEY = "suite.metaHealth.dismissed";

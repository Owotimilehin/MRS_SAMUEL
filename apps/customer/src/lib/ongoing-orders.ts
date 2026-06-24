import { deriveJourney, type TrackingOrderLike } from "./order-journey";
import type { ApiOrderTracking } from "./api/types";

/**
 * Browser-persisted "ongoing order" recovery. When a customer checks out we
 * stash `ms_track_<orderNumber> = { phone, placedAt }` in localStorage (see
 * checkout). This module reads those entries back so a banner can surface any
 * in-progress order even after the customer closed the tab — and prune them once
 * the order is done. Identity is "orders placed from THIS browser"; every entry
 * is still re-authorized server-side (the tracking API checks the phone), so a
 * forged/mismatched entry simply fails and is pruned.
 *
 * Pure + storage-injected so it is unit-testable without a DOM.
 */

export interface OngoingEntry {
  orderNumber: string;
  phone: string;
  /** ISO timestamp of checkout. Null for legacy entries written before this. */
  placedAt: string | null;
}

const KEY_PREFIX = "ms_track_";

/** How long an entry may linger before it is pruned regardless of status — a
 *  safety net for orders that never reach a clean terminal state (e.g. an
 *  abandoned-unpaid order whose reservation quietly expired). */
export const STALE_MS = 48 * 60 * 60 * 1000;

/** Statuses at which an order's journey is over and the entry should clear. */
const TERMINAL_STATUSES = new Set(["delivered", "cancelled", "canceled", "refunded", "fulfilled"]);

export function entryKey(orderNumber: string): string {
  return KEY_PREFIX + orderNumber;
}

type ReadableStorage = Pick<Storage, "length" | "key" | "getItem">;

export function readEntries(storage: ReadableStorage): OngoingEntry[] {
  const out: OngoingEntry[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !key.startsWith(KEY_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      const v = JSON.parse(raw) as { phone?: unknown; placedAt?: unknown };
      if (typeof v.phone === "string" && v.phone) {
        out.push({
          orderNumber: key.slice(KEY_PREFIX.length),
          phone: v.phone,
          placedAt: typeof v.placedAt === "string" ? v.placedAt : null,
        });
      }
    } catch {
      // malformed JSON — ignore (only readable entries are surfaced)
    }
  }
  return out;
}

export function writeEntry(
  storage: Pick<Storage, "setItem">,
  orderNumber: string,
  phone: string,
  placedAt: string,
): void {
  storage.setItem(entryKey(orderNumber), JSON.stringify({ phone, placedAt }));
}

export function removeEntry(storage: Pick<Storage, "removeItem">, orderNumber: string): void {
  storage.removeItem(entryKey(orderNumber));
}

/** Done = the order reached a terminal state, so the entry should be cleared. */
export function isTerminalOrder(o: {
  status: string;
  delivered_at?: string | null;
  fulfilled_at?: string | null;
}): boolean {
  if (TERMINAL_STATUSES.has(o.status)) return true;
  if (o.delivered_at) return true;
  if (o.fulfilled_at) return true;
  return false;
}

/** Older than the 48h window. Legacy entries (no placedAt) are never stale on
 *  age alone — they clear only on terminal/not-found. */
export function isStale(entry: OngoingEntry, now: number): boolean {
  if (!entry.placedAt) return false;
  const t = Date.parse(entry.placedAt);
  if (Number.isNaN(t)) return false;
  return now - t > STALE_MS;
}

/** Unpaid + not cancelled → the pill offers "Resume payment". */
export function isAwaitingPayment(o: { status: string; payment_status: string }): boolean {
  return o.payment_status !== "paid" && o.status !== "cancelled";
}

/** Short label for the pill, reusing the shared journey derivation. */
export function statusLabel(o: TrackingOrderLike): string {
  return deriveJourney(o).currentStep.label;
}

export interface ActiveOrder {
  orderNumber: string;
  label: string;
  awaitingPayment: boolean;
}

/**
 * Decide which stored orders are still active (→ pills) and which to prune.
 * Pure apart from the injected `fetchStatus`, so the whole orchestration is
 * unit-testable without a DOM or network. Rules:
 *  - stale (>48h) → prune, never fetch
 *  - terminal (delivered/cancelled/refunded/fulfilled) → prune
 *  - fetch reports "not found" → prune (the order no longer exists)
 *  - any other fetch error → keep the entry silently (transient), no pill this
 *    round; the next poll retries. Never prune on a transient error.
 */
export async function reconcileEntries(
  entries: OngoingEntry[],
  fetchStatus: (entry: OngoingEntry) => Promise<ApiOrderTracking>,
  opts: { now: number; isNotFound: (err: unknown) => boolean },
): Promise<{ active: ActiveOrder[]; prune: string[] }> {
  const active: ActiveOrder[] = [];
  const prune: string[] = [];
  for (const entry of entries) {
    if (isStale(entry, opts.now)) {
      prune.push(entry.orderNumber);
      continue;
    }
    try {
      const o = await fetchStatus(entry);
      if (isTerminalOrder(o)) {
        prune.push(entry.orderNumber);
        continue;
      }
      active.push({
        orderNumber: entry.orderNumber,
        label: statusLabel(o),
        awaitingPayment: isAwaitingPayment(o),
      });
    } catch (err) {
      if (opts.isNotFound(err)) prune.push(entry.orderNumber);
      // otherwise transient — leave the entry for the next poll
    }
  }
  return { active, prune };
}

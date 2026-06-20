import { local } from "../db/local.js";
import { lagosToday } from "../lib/biz-date.js";

interface FileShiftOpenInput {
  branchId: string;
  businessDate: string;
  stockCounts: Array<{ product_id: string; counted_quantity: number; variance_reason?: string }>;
  notes?: string;
}

/** True iff this device has filed today's opening (local marker) OR the last
 *  pull said the server already has one (opened_today).
 *  @deprecated Prefer hasOpenShift — isOpenedToday is kept for the sell
 *  screen which migrates in Task 9. */
export async function isOpenedToday(branchId: string): Promise<boolean> {
  const today = lagosToday();
  const marker = await local.shiftOpenMarker.get(`${branchId}::${today}`);
  if (marker) return true;
  const meta = await local.meta.get("default");
  return meta?.branch_id === branchId && meta?.opened_today === true;
}

/**
 * True iff the branch has an open shift according to local state.
 *
 * Checks the `currentShift` table first (written by fileLocalShiftOpen,
 * fileLocalShiftClose, and the /sync/pull consumer). Falls back to the legacy
 * `opened_today` flag in meta so devices that haven't received a pull yet
 * aren't inadvertently locked out.
 */
export async function hasOpenShift(branchId: string): Promise<boolean> {
  const row = await local.currentShift.get(branchId);
  if (row) return row.status === "open";
  // Fallback: legacy opened_today from meta (present after any pull, before
  // the first open/close that writes currentShift).
  const meta = await local.meta.get("default");
  return meta?.branch_id === branchId && meta?.opened_today === true;
}

/** Write the unlock marker + enqueue the server POST in one transaction.
 *  Also upserts currentShift so hasOpenShift is immediately true offline. */
export async function fileLocalShiftOpen(input: FileShiftOpenInput): Promise<void> {
  const nowIso = new Date().toISOString();
  const nowEpoch = Date.now();
  await local.transaction(
    "rw",
    local.shiftOpenMarker,
    local.currentShift,
    local.outbox,
    async () => {
      await local.shiftOpenMarker.put({
        id: `${input.branchId}::${input.businessDate}`,
        branch_id: input.branchId,
        business_date: input.businessDate,
        opened_at: nowIso,
      });
      await local.currentShift.put({
        branchId: input.branchId,
        openedAt: nowIso,
        status: "open",
      });
      await local.outbox.put({
        id: crypto.randomUUID(),
        endpoint: `/v1/branches/${input.branchId}/shift-open`,
        method: "POST",
        payload: {
          business_date: input.businessDate,
          stock_counts: input.stockCounts,
          ...(input.notes ? { notes: input.notes } : {}),
        },
        attempt_count: 0,
        next_attempt_at: nowEpoch,
        status: "pending",
        created_at_local: nowEpoch,
      });
    },
  );
}

/**
 * Mark the local shift as closed. Does NOT enqueue the close POST — the
 * close.tsx screen posts to /shift-close directly via its own flow (Task 9).
 * This only flips the local gate so the till stops accepting sales immediately
 * after the owner confirms close, even while offline.
 */
export async function fileLocalShiftClose(branchId: string): Promise<void> {
  await local.transaction("rw", local.currentShift, async () => {
    const existing = await local.currentShift.get(branchId);
    await local.currentShift.put({
      ...(existing ?? { branchId }),
      branchId,
      status: "closed",
    });
  });
}

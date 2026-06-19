import { local } from "../db/local.js";
import { lagosToday } from "../lib/biz-date.js";

interface FileShiftOpenInput {
  branchId: string;
  businessDate: string;
  stockCounts: Array<{ product_id: string; counted_quantity: number; variance_reason?: string }>;
  notes?: string;
}

/** True iff this device has filed today's opening (local marker) OR the last
 *  pull said the server already has one (opened_today). */
export async function isOpenedToday(branchId: string): Promise<boolean> {
  const today = lagosToday();
  const marker = await local.shiftOpenMarker.get(`${branchId}::${today}`);
  if (marker) return true;
  const meta = await local.meta.get("default");
  return meta?.branch_id === branchId && meta?.opened_today === true;
}

/** Write the unlock marker + enqueue the server POST in one transaction. */
export async function fileLocalShiftOpen(input: FileShiftOpenInput): Promise<void> {
  const nowIso = new Date().toISOString();
  const nowEpoch = Date.now();
  await local.transaction("rw", local.shiftOpenMarker, local.outbox, async () => {
    await local.shiftOpenMarker.put({
      id: `${input.branchId}::${input.businessDate}`,
      branch_id: input.branchId,
      business_date: input.businessDate,
      opened_at: nowIso,
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
  });
}

/**
 * Shared helpers for the "Print receipt" buttons on the detail screens. Keeps
 * each screen's wiring to a couple of lines: fetch the branch header, then send
 * a composed receipt to the printer and toast the outcome.
 */
import { api } from "./api.js";
import { toast } from "./toast.js";
import { printReceipt } from "./print-receipt.js";
import type { ReceiptData, BranchInfo } from "./receipt-data.js";

/** Best-effort branch header for the receipt (works online; falls back cleanly). */
export async function fetchBranchInfo(branchId: string): Promise<BranchInfo> {
  try {
    const res = await api<{ data: { name: string; address: string | null; phone: string | null } }>(
      `/branches/${branchId}`,
    );
    return { name: res.data.name, address: res.data.address, phone: res.data.phone };
  } catch {
    return { name: "Mrs. Samuel", address: null, phone: null };
  }
}

/** Print a composed receipt and surface success/failure as a toast. */
export async function printAndToast(data: ReceiptData, openDrawer = false): Promise<void> {
  const res = await printReceipt(data, { promptIfNeeded: true, openDrawer });
  if (res.ok) toast.success(res.message);
  else toast.error(res.message);
}

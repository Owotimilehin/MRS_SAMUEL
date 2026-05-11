import { sql } from "drizzle-orm";
import type { DbClient } from "@ms/db";

export const REFUND_APPROVAL_THRESHOLD_NGN = 5_000;

export type ReturnReasonCategory =
  | "changed_mind"
  | "wrong_flavor"
  | "wrong_item"
  | "quality_issue"
  | "damaged_on_arrival"
  | "delivery_failed"
  | "other_with_note";

/**
 * Auto-approval matrix per the design spec §5.4:
 *   - quality_issue        → owner review (food safety concern)
 *   - refund > ₦5,000      → owner review (financial size)
 *   - wasted disposition   → owner review (we're writing off stock)
 *   - otherwise            → auto-complete
 */
export function shouldFlagForApproval(input: {
  reasonCategory: ReturnReasonCategory;
  refundAmountNgn: number;
  hasWastedDisposition: boolean;
}): boolean {
  if (input.reasonCategory === "quality_issue") return true;
  if (input.refundAmountNgn > REFUND_APPROVAL_THRESHOLD_NGN) return true;
  if (input.hasWastedDisposition) return true;
  return false;
}

const WINDOW_HOURS: Record<ReturnReasonCategory, number> = {
  changed_mind: 1,
  wrong_flavor: 24,
  wrong_item: 24,
  quality_issue: 48, // limited by product shelf life; caller can override
  damaged_on_arrival: 24,
  delivery_failed: 24,
  other_with_note: 24,
};

export function isWithinReturnWindow(input: {
  reasonCategory: ReturnReasonCategory;
  saleCreatedAt: Date;
  shelfLifeHours: number;
  ownerOverride: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (input.ownerOverride) return { ok: true };
  if (input.reasonCategory === "quality_issue") {
    const limit = input.shelfLifeHours * 60 * 60 * 1000;
    if (Date.now() - input.saleCreatedAt.getTime() > limit) {
      return { ok: false, reason: "past_shelf_life" };
    }
    return { ok: true };
  }
  const limit = WINDOW_HOURS[input.reasonCategory] * 60 * 60 * 1000;
  if (Date.now() - input.saleCreatedAt.getTime() > limit) {
    return { ok: false, reason: "past_return_window" };
  }
  return { ok: true };
}

export async function nextReturnNumber(db: DbClient): Promise<string> {
  const rows = await db.execute<{ nextval: string | number }>(
    sql`SELECT nextval('sale_return_seq') AS nextval`,
  );
  const value = rows[0]?.["nextval"];
  if (value === undefined) throw new Error("sale_return_seq returned no value");
  const seq = String(value).padStart(5, "0");
  return `RET-${new Date().getFullYear()}-${seq}`;
}

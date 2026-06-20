import { sql } from "drizzle-orm";
import type { DbExecutor } from "@ms/db";

// ---------------------------------------------------------------------------
// Private window-core helpers
// ---------------------------------------------------------------------------

/** Raw sum of paid transfer sales minus completed transfer refunds in [start, end). */
async function _expectedCashForWindow(
  db: DbExecutor,
  branchId: string,
  start: Date,
  end: Date,
): Promise<number> {
  const salesRows = await db.execute<{ total: number | string | null }>(sql`
    SELECT COALESCE(SUM(total_ngn), 0)::int AS total FROM sale_order
    WHERE branch_id = ${branchId} AND payment_method = 'transfer'
      AND status IN ('paid','handed_over','delivered')
      AND created_at_local >= ${start.toISOString()}
      AND created_at_local <  ${end.toISOString()}
  `);
  const refundRows = await db.execute<{ total: number | string | null }>(sql`
    SELECT COALESCE(SUM(refund_amount_ngn), 0)::int AS total FROM sale_return
    WHERE branch_id = ${branchId} AND refund_method = 'transfer'
      AND status = 'completed'
      AND created_at >= ${start.toISOString()}
      AND created_at <  ${end.toISOString()}
  `);
  const gross = Number(salesRows[0]?.total ?? 0);
  const refunds = Number(refundRows[0]?.total ?? 0);
  return gross - refunds;
}

/** Individual transfer sales in [start, end) for itemised display. */
async function _cashSalesForWindow(
  db: DbExecutor,
  branchId: string,
  start: Date,
  end: Date,
): Promise<CashSaleLine[]> {
  const rows = await db.execute<{
    order_number: string;
    channel: string;
    status: string;
    total_ngn: number | string;
    created_at_local: string;
  }>(sql`
    SELECT order_number, channel, status, total_ngn::int AS total_ngn,
           created_at_local::text AS created_at_local
    FROM sale_order
    WHERE branch_id = ${branchId} AND payment_method = 'transfer'
      AND status IN ('paid','handed_over','delivered')
      AND created_at_local >= ${start.toISOString()}
      AND created_at_local <  ${end.toISOString()}
    ORDER BY created_at_local
  `);
  return rows.map((r) => ({
    order_number: r.order_number,
    channel: r.channel,
    status: r.status,
    total_ngn: Number(r.total_ngn),
    created_at_local: r.created_at_local,
  }));
}

// ---------------------------------------------------------------------------
// Calendar-day variants (public, unchanged interface)
// ---------------------------------------------------------------------------

/**
 * Expected money taken at a branch on a given business date:
 *   sum(paid transfer sales) − sum(transfer refunds completed that day)
 *
 * The till books every walk-in sale as a bank transfer, so the shift-end
 * reconciliation expects transfers (not cash). Named `expectedCashForDay` /
 * `system_cash_total_ngn` for historical reasons — the persisted column predates
 * the transfer-only switch and isn't worth a rename migration.
 */
export async function expectedCashForDay(
  db: DbExecutor,
  branchId: string,
  businessDate: Date,
): Promise<number> {
  const start = new Date(businessDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return _expectedCashForWindow(db, branchId, start, end);
}

/** One transfer sale contributing to a day's expected take, for the close screen. */
export interface CashSaleLine {
  order_number: string;
  channel: string;
  status: string;
  total_ngn: number;
  created_at_local: string;
}

/**
 * The individual transfer sales that make up `expectedCashForDay`'s gross figure —
 * same filter, itemised. The close screen shows these so staff can see exactly
 * which sales produced "System expected ₦X" instead of assuming it's phantom.
 */
export async function cashSalesForDay(
  db: DbExecutor,
  branchId: string,
  businessDate: Date,
): Promise<CashSaleLine[]> {
  const start = new Date(businessDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return _cashSalesForWindow(db, branchId, start, end);
}

// ---------------------------------------------------------------------------
// Shift-window variants (public, new)
// ---------------------------------------------------------------------------

/**
 * Expected money taken at a branch during a shift window [openedAt, closedAt).
 * Same logic as `expectedCashForDay` but scoped to the exact shift timestamps
 * rather than a midnight-bounded calendar day.
 */
export async function expectedCashForShift(
  db: DbExecutor,
  branchId: string,
  openedAt: Date,
  closedAt: Date,
): Promise<number> {
  return _expectedCashForWindow(db, branchId, openedAt, closedAt);
}

/**
 * The individual transfer sales that make up `expectedCashForShift`'s gross
 * figure — same filter as `cashSalesForDay` but scoped to [openedAt, closedAt).
 */
export async function cashSalesForShift(
  db: DbExecutor,
  branchId: string,
  openedAt: Date,
  closedAt: Date,
): Promise<CashSaleLine[]> {
  return _cashSalesForWindow(db, branchId, openedAt, closedAt);
}

// ---------------------------------------------------------------------------
// Stock helper (unchanged)
// ---------------------------------------------------------------------------

/**
 * Current expected stock balance per product at a branch (ledger sum).
 */
export async function expectedStockForDay(
  db: DbExecutor,
  branchId: string,
): Promise<Record<string, number>> {
  const rows = await db.execute<{ product_id: string; balance: number | string }>(sql`
    SELECT product_id, COALESCE(SUM(delta), 0)::int AS balance
    FROM stock_ledger
    WHERE location_type = 'branch' AND location_id = ${branchId}
    GROUP BY product_id
  `);
  return Object.fromEntries(rows.map((r) => [r.product_id, Number(r.balance)]));
}

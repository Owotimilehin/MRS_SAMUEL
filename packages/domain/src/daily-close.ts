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
// Stock helper (per-size)
// ---------------------------------------------------------------------------

/** One per-size expected-balance line at a branch. `variant_id`/`size_ml` are
 *  null for the legacy "untyped" pool (ledger rows with no variant). */
export interface ExpectedStockLine {
  product_id: string;
  variant_id: string | null;
  size_ml: number | null;
  balance: number;
}

/** Stable map key for a (product, variant) pair; untyped variant → trailing "". */
export function expectedStockKey(productId: string, variantId: string | null): string {
  return `${productId}::${variantId ?? ""}`;
}

/** Build a balance lookup keyed by `expectedStockKey`. */
export function expectedStockMap(lines: ExpectedStockLine[]): Map<string, number> {
  return new Map(lines.map((l) => [expectedStockKey(l.product_id, l.variant_id), l.balance]));
}

/**
 * Current expected stock balance per (flavour, size) at a branch.
 *
 * Returns one line for EVERY active variant of any flavour that has branch
 * ledger activity — including sizes whose balance is 0, so staff can record
 * found stock for a size that "shouldn't" have any. Any legacy untyped pool
 * (ledger rows with a null variant) is surfaced as a separate null-variant
 * line when its balance is non-zero, so nothing is hidden.
 */
export async function expectedStockForDay(
  db: DbExecutor,
  branchId: string,
): Promise<ExpectedStockLine[]> {
  const rows = await db.execute<{
    product_id: string;
    variant_id: string | null;
    size_ml: number | null;
    balance: number | string;
  }>(sql`
    WITH bal AS (
      SELECT product_id, variant_id, COALESCE(SUM(delta), 0)::int AS balance
      FROM stock_ledger
      WHERE location_type = 'branch' AND location_id = ${branchId}
      GROUP BY product_id, variant_id
    )
    SELECT pv.product_id::text AS product_id,
           pv.id::text         AS variant_id,
           pv.size_ml          AS size_ml,
           COALESCE(b.balance, 0)::int AS balance
    FROM product_variant pv
    JOIN (SELECT DISTINCT product_id FROM bal) ap ON ap.product_id = pv.product_id
    LEFT JOIN bal b ON b.product_id = pv.product_id AND b.variant_id = pv.id
    WHERE pv.is_active = true AND pv.deleted_at IS NULL
    UNION ALL
    SELECT b.product_id::text, NULL::text AS variant_id, NULL::int AS size_ml, b.balance
    FROM bal b
    WHERE b.variant_id IS NULL AND b.balance <> 0
    ORDER BY product_id, size_ml NULLS LAST
  `);
  return rows.map((r) => ({
    product_id: r.product_id,
    variant_id: r.variant_id,
    size_ml: r.size_ml === null ? null : Number(r.size_ml),
    balance: Number(r.balance),
  }));
}

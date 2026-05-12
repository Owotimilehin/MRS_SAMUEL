import { sql } from "drizzle-orm";
import type { DbExecutor } from "@ms/db";

/**
 * Expected cash for a branch on a given business date:
 *   sum(paid cash sales) − sum(cash refunds completed that day)
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

  const salesRows = await db.execute<{ total: number | string | null }>(sql`
    SELECT COALESCE(SUM(total_ngn), 0)::int AS total FROM sale_order
    WHERE branch_id = ${branchId} AND payment_method = 'cash'
      AND status IN ('paid','handed_over','delivered')
      AND created_at_local >= ${start.toISOString()}
      AND created_at_local <  ${end.toISOString()}
  `);
  const refundRows = await db.execute<{ total: number | string | null }>(sql`
    SELECT COALESCE(SUM(refund_amount_ngn), 0)::int AS total FROM sale_return
    WHERE branch_id = ${branchId} AND refund_method = 'cash'
      AND status = 'completed'
      AND created_at >= ${start.toISOString()}
      AND created_at <  ${end.toISOString()}
  `);
  const gross = Number(salesRows[0]?.total ?? 0);
  const refunds = Number(refundRows[0]?.total ?? 0);
  return gross - refunds;
}

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

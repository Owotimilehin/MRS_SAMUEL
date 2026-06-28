import { sql, eq, and, gt, lte } from "drizzle-orm";
import { stockLedger, stockReservation, type DbExecutor } from "@ms/db";

/**
 * Stock available to a NEW sale at a branch right now.
 *
 *   available = SUM(ledger.delta for this branch+product)
 *             - SUM(active reservations for this branch+product)
 *
 * "Active" = expires_at in the future. Expired reservations are swept by the
 * worker, but we still subtract only the non-expired ones here so a race
 * between sweep and check doesn't over-sell.
 */
export async function availableAtBranch(
  db: DbExecutor,
  opts: { branchId: string; productId: string },
): Promise<number> {
  const [bal] = await db
    .select({
      sum: sql<number>`COALESCE(SUM(${stockLedger.delta}), 0)::int`,
    })
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.locationType, "branch"),
        eq(stockLedger.locationId, opts.branchId),
        eq(stockLedger.productId, opts.productId),
      ),
    );
  const [resv] = await db
    .select({
      sum: sql<number>`COALESCE(SUM(${stockReservation.quantity}), 0)::int`,
    })
    .from(stockReservation)
    .where(
      and(
        eq(stockReservation.branchId, opts.branchId),
        eq(stockReservation.productId, opts.productId),
        gt(stockReservation.expiresAt, new Date()),
      ),
    );
  return Number(bal?.sum ?? 0) - Number(resv?.sum ?? 0);
}

/**
 * Stock available to a NEW sale at a branch right now, per variant (per-size).
 *
 *   available = SUM(ledger.delta for this branch+variant)
 *             - SUM(active reservations for this branch+variant)
 *
 * "Active" = expires_at in the future. Expired reservations are swept by the
 * worker, but we still subtract only the non-expired ones here so a race
 * between sweep and check doesn't over-sell.
 */
export async function availableVariantAtBranch(
  db: DbExecutor,
  opts: { branchId: string; variantId: string },
): Promise<number> {
  const [bal] = await db
    .select({ sum: sql<number>`COALESCE(SUM(${stockLedger.delta}), 0)::int` })
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.locationType, "branch"),
        eq(stockLedger.locationId, opts.branchId),
        eq(stockLedger.variantId, opts.variantId),
      ),
    );
  const [resv] = await db
    .select({ sum: sql<number>`COALESCE(SUM(${stockReservation.quantity}), 0)::int` })
    .from(stockReservation)
    .where(
      and(
        eq(stockReservation.branchId, opts.branchId),
        eq(stockReservation.variantId, opts.variantId),
        gt(stockReservation.expiresAt, new Date()),
      ),
    );
  return Number(bal?.sum ?? 0) - Number(resv?.sum ?? 0);
}

/**
 * Delete every reservation whose expires_at is in the past. Returns the count
 * removed. Called on a 60-second cron from the worker.
 */
export async function sweepExpiredReservations(db: DbExecutor): Promise<number> {
  const result = await db
    .delete(stockReservation)
    .where(lte(stockReservation.expiresAt, new Date()))
    .returning();
  return result.length;
}

/**
 * Mint the next sale order number. Format: SO-{YYYY}-{NNNNN}
 * Must be called inside the confirm transaction.
 */
export async function nextOrderNumber(db: DbExecutor): Promise<string> {
  const rows = await db.execute<{ nextval: string | number }>(
    sql`SELECT nextval('sale_order_seq') AS nextval`,
  );
  const value = rows[0]?.["nextval"];
  if (value === undefined) throw new Error("sale_order_seq returned no value");
  const seq = String(value).padStart(5, "0");
  return `SO-${new Date().getFullYear()}-${seq}`;
}

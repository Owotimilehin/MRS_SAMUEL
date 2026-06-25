import { and, eq, lt } from "drizzle-orm";
import { saleOrder, stockReservation, type DbClient } from "@ms/db";

const WINDOW_MS = 60 * 60_000;

/**
 * Cancel unpaid 'confirmed' online orders that are past the 60-minute payment
 * window and release any stock reservations attached to them.
 *
 * Only touches orders where:
 *   channel = 'online' AND status = 'confirmed' AND paymentStatus = 'pending'
 *   AND createdAtLocal < now - 60 minutes
 *
 * Idempotent: already-cancelled rows no longer match `status='confirmed'`
 * so a second run is a no-op.
 *
 * Returns the number of orders cancelled.
 */
export async function expireUnpaidOrders(db: DbClient, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - WINDOW_MS);

  return db.transaction(async (tx) => {
    const stale = await tx
      .update(saleOrder)
      .set({
        status: "cancelled",
        cancelReason: "payment_expired",
        cancelledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(saleOrder.channel, "online"),
          eq(saleOrder.status, "confirmed"),
          eq(saleOrder.paymentStatus, "pending"),
          lt(saleOrder.createdAtLocal, cutoff),
        ),
      )
      .returning({ id: saleOrder.id });

    for (const s of stale) {
      await tx.delete(stockReservation).where(eq(stockReservation.saleOrderId, s.id));
    }

    return stale.length;
  });
}

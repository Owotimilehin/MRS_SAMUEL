import { and, eq, lt } from "drizzle-orm";
import { saleOrder, stockReservation, type DbClient } from "@ms/db";
import { refireProviderWebhook, providerOf, type PaymentProvider } from "./refire-webhook.js";

const WINDOW_MS = 60 * 60_000;

/** Injectable so tests can drive the re-verify step without real HTTP. */
export type RefireFn = (orderNumber: string, provider: PaymentProvider) => Promise<unknown>;

/**
 * Cancel unpaid 'confirmed' online orders that are past the 60-minute payment
 * window and release any stock reservations attached to them.
 *
 * Only touches orders where:
 *   channel = 'online' AND status = 'confirmed' AND paymentStatus = 'pending'
 *   AND createdAtLocal < now - 60 minutes
 *
 * BEFORE cancelling, every candidate gets ONE last provider re-verify (its
 * webhook re-fired). A payment that actually SUCCEEDED (money taken) but whose
 * callback was lost — common with OPay bank-transfer/USSD, which settle
 * asynchronously minutes after checkout — reconciles to `paid` here and is
 * then excluded from the cancel UPDATE below (which only matches
 * status='confirmed'). Without this last check we would cancel a genuinely
 * paid order and release its stock, leaving the customer paid but order-less
 * and needing a manual refund.
 *
 * Idempotent: already-cancelled/paid rows no longer match `status='confirmed'`
 * so a second run is a no-op.
 *
 * Returns the number of orders cancelled.
 */
export async function expireUnpaidOrders(
  db: DbClient,
  now: Date = new Date(),
  refire: RefireFn = refireProviderWebhook,
): Promise<number> {
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  const matches = and(
    eq(saleOrder.channel, "online"),
    eq(saleOrder.status, "confirmed"),
    eq(saleOrder.paymentStatus, "pending"),
    lt(saleOrder.createdAtLocal, cutoff),
  );

  // Last-chance re-verify. Best-effort and OUTSIDE the cancel transaction: the
  // webhook reconciles in its own committed transaction, so by the time each
  // await resolves a truly-paid order is already flipped to `paid` and will not
  // match the cancel UPDATE. A failed re-fire must never block cancellation.
  const candidates = await db
    .select({ orderNumber: saleOrder.orderNumber, paymentProvider: saleOrder.paymentProvider })
    .from(saleOrder)
    .where(matches)
    .limit(100);

  for (const c of candidates) {
    try {
      await refire(c.orderNumber, providerOf(c.paymentProvider));
    } catch {
      // ignore — an order that could not be re-verified simply gets cancelled
      // below, exactly as before this safety net existed.
    }
  }

  return db.transaction(async (tx) => {
    const stale = await tx
      .update(saleOrder)
      .set({
        status: "cancelled",
        cancelReason: "payment_expired",
        cancelledAt: now,
        updatedAt: now,
      })
      .where(matches)
      .returning({ id: saleOrder.id });

    for (const s of stale) {
      await tx.delete(stockReservation).where(eq(stockReservation.saleOrderId, s.id));
    }

    return stale.length;
  });
}

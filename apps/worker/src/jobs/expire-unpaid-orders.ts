import { and, eq, inArray, lt } from "drizzle-orm";
import { saleOrder, stockReservation, type DbClient } from "@ms/db";
import { refireProviderWebhook, providerOf, type PaymentProvider } from "./refire-webhook.js";

const WINDOW_MS = 60 * 60_000;

/**
 * How long an order whose payment status could NOT be checked is left open.
 * Past the 60-minute window an order is only cancelled once the provider has
 * actually answered "not paid"; while the check itself keeps failing (OPay or
 * our api down) it stays open for the next sweep. This cap stops that from
 * lasting forever: after it the order is cancelled unchecked, and the
 * late-payment sweep (payment-reconcile.ts) keeps asking the provider about it
 * for another 48 hours.
 */
const UNCHECKED_LIMIT_MS = 6 * 60 * 60_000;

/**
 * Re-verify one order with the provider. Resolves true only when the check
 * completed (whatever the provider said); false or a throw means we still do
 * not know whether the order was paid. Injectable so tests can drive it
 * without real HTTP.
 */
export type RefireFn = (orderNumber: string, provider: PaymentProvider) => Promise<boolean>;

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
 * An order is cancelled only if that re-verify COMPLETED. If it errored we do
 * not know whether the customer paid, so the order is left for the next sweep
 * (see UNCHECKED_LIMIT_MS for the bound).
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
  const uncheckedCutoff = new Date(now.getTime() - UNCHECKED_LIMIT_MS);
  const matches = and(
    eq(saleOrder.channel, "online"),
    eq(saleOrder.status, "confirmed"),
    eq(saleOrder.paymentStatus, "pending"),
    lt(saleOrder.createdAtLocal, cutoff),
  );

  // Last-chance re-verify. Best-effort and OUTSIDE the cancel transaction: the
  // webhook reconciles in its own committed transaction, so by the time each
  // await resolves a truly-paid order is already flipped to `paid` and will not
  // match the cancel UPDATE.
  const candidates = await db
    .select({
      id: saleOrder.id,
      orderNumber: saleOrder.orderNumber,
      paymentProvider: saleOrder.paymentProvider,
      createdAtLocal: saleOrder.createdAtLocal,
    })
    .from(saleOrder)
    .where(matches)
    .limit(100);

  const cancellable: string[] = [];
  for (const c of candidates) {
    let checked = false;
    try {
      checked = (await refire(c.orderNumber, providerOf(c.paymentProvider))) === true;
    } catch {
      // The check did not complete; `checked` stays false.
    }
    if (checked || c.createdAtLocal < uncheckedCutoff) cancellable.push(c.id);
  }
  if (cancellable.length === 0) return 0;

  return db.transaction(async (tx) => {
    const stale = await tx
      .update(saleOrder)
      .set({
        status: "cancelled",
        cancelReason: "payment_expired",
        cancelledAt: now,
        updatedAt: now,
      })
      // `matches` again, so an order the re-verify just flipped to paid is skipped.
      .where(and(matches, inArray(saleOrder.id, cancellable)))
      .returning({ id: saleOrder.id });

    for (const s of stale) {
      await tx.delete(stockReservation).where(eq(stockReservation.saleOrderId, s.id));
    }

    return stale.length;
  });
}

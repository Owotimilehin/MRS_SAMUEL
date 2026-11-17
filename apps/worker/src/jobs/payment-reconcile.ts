import { eq, and, lt, gt, desc, sql } from "drizzle-orm";
import { saleOrder, outboxEvent, type DbClient } from "@ms/db";
import pino from "pino";
import { refireProviderWebhook, providerOf, type PaymentProvider } from "./refire-webhook.js";

const logger = pino({ base: { service: "ms-worker", part: "payment-reconcile" } });

/** An order is "stuck" if the payment webhook never fired for it. Give the
 *  webhook this long to land before the sweep steps in. */
const STUCK_AFTER_SECONDS = 90;

/** How far back the sweep keeps re-verifying a stuck order. Payment happens in
 *  the provider cashier within minutes of order creation, so this window is orders
 *  of magnitude larger than any realistic pay-after-create delay; it exists to
 *  (a) survive worker downtime and (b) bound the work so we don't re-verify
 *  truly-abandoned orders against the provider forever. Past it, recovery falls to
 *  the admin "Recheck" action / payment-attention bucket. */
const LOOKBACK_HOURS = 48;

/**
 * Find online orders sitting in `confirmed` for >=90s (and <48h) — the customer
 * paid or is paying, but our webhook never landed (provider retries are not
 * guaranteed) — and re-fire the api's payment webhook for each, by order number,
 * over HTTP. This keeps the worker free of any `@ms/api` import: the webhook
 * itself owns the single money-reconcile path (verify + applyPaymentConfirmation,
 * which captures a preorder's payment without moving stock), so the sweep only
 * re-triggers it — it never re-implements ledger logic here.
 *
 * NOTE: this deliberately does NOT gate on a live stock reservation. An earlier
 * version only recovered orders whose reservation was still held, which silently
 * dropped two classes of genuinely-paid order: preorders (which never reserve
 * stock at all) and ordinary orders whose hold lapsed before the webhook
 * arrived. A completed payment must be recovered regardless of stock state — the
 * money was taken — so the only bound is the time window above.
 *
 * Best-effort: a thrown error or non-2xx response for one order is logged and
 * the loop continues — one bad POST must never abort the sweep.
 *
 * Returns the number of orders the webhook was re-fired for.
 */
export async function sweepStuckPaymentOrders(db: DbClient, now: Date = new Date()): Promise<number> {
  const stuckCutoff = new Date(now.getTime() - STUCK_AFTER_SECONDS * 1000);
  const lookbackCutoff = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);

  const candidates = await db
    .select({
      id: saleOrder.id,
      orderNumber: saleOrder.orderNumber,
      paymentProvider: saleOrder.paymentProvider,
    })
    .from(saleOrder)
    .where(
      and(
        eq(saleOrder.channel, "online"),
        eq(saleOrder.status, "confirmed"),
        lt(saleOrder.createdAt, stuckCutoff),
        gt(saleOrder.createdAt, lookbackCutoff),
      ),
    )
    .limit(100);

  if (candidates.length === 0) return 0;

  let posted = 0;
  for (const o of candidates) {
    // Each order carries the provider it was created under (Task 1 stamp). Null
    // on legacy rows → OPay, the only provider. Re-fire the
    // provider's webhook so the money is re-verified against the right API.
    const provider = providerOf(o.paymentProvider);
    try {
      const ok = await refireProviderWebhook(o.orderNumber, provider);
      if (!ok) {
        logger.warn(
          { orderId: o.id, orderNumber: o.orderNumber, provider },
          "reconcile: webhook re-fire returned non-2xx",
        );
        continue;
      }
      logger.info(
        { orderId: o.id, orderNumber: o.orderNumber, provider },
        "reconcile: webhook re-fired",
      );
      posted++;
    } catch (err) {
      logger.warn(
        { orderId: o.id, orderNumber: o.orderNumber, provider, err },
        "reconcile: webhook re-fire failed — continuing sweep",
      );
    }
  }
  return posted;
}

/** How long after the 60-minute auto-cancel we keep asking the provider whether
 *  the order was paid after all. OPay transfers/USSD can settle long after the
 *  customer left the cashier. */
const LATE_PAYMENT_HOURS = 48;

/** Give up on a sweep after this many checks in a row fail: the provider or our
 *  api is down, and hammering it once per order helps nobody. The next sweep
 *  starts again from the top. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Catch a payment that lands AFTER the order was auto-cancelled for non-payment.
 *
 * The sweep above only looks at open (`confirmed`) orders, so once an order was
 * cancelled as `payment_expired` a late payment was noticed only if OPay's own
 * callback happened to arrive. This re-fires the same webhook for those orders
 * for 48 hours after cancellation.
 *
 * It decides nothing itself. The webhook re-queries OPay and, on SUCCESS for a
 * cancelled order, takes its existing paid-after-cancel path
 * (applyPaymentConfirmation in the api): one `sale.paid_after_cancel` outbox
 * event, i.e. one "refund needed" alert to the owner. Nothing is refunded or
 * reinstated automatically. That path dedupes on the order, so a real callback
 * arriving as well changes nothing; and an order that already has the alert is
 * skipped here, so it is not asked about again.
 *
 * Only `payment_expired` cancellations are in scope: an order staff cancelled
 * by hand is their decision, not an expiry we should second-guess.
 *
 * Returns the number of orders whose check completed.
 */
export async function sweepExpiredOrdersForLatePayment(
  db: DbClient,
  now: Date = new Date(),
  refire: (orderNumber: string, provider: PaymentProvider) => Promise<boolean> = refireProviderWebhook,
): Promise<number> {
  const since = new Date(now.getTime() - LATE_PAYMENT_HOURS * 3600 * 1000);

  const candidates = await db
    .select({
      id: saleOrder.id,
      orderNumber: saleOrder.orderNumber,
      paymentProvider: saleOrder.paymentProvider,
    })
    .from(saleOrder)
    .where(
      and(
        eq(saleOrder.channel, "online"),
        eq(saleOrder.status, "cancelled"),
        eq(saleOrder.cancelReason, "payment_expired"),
        gt(saleOrder.cancelledAt, since),
        sql`not exists (
          select 1 from ${outboxEvent}
          where ${outboxEvent.eventType} = 'sale.paid_after_cancel'
            and ${outboxEvent.payload}->>'sale_order_id' = ${saleOrder.id}::text
        )`,
      ),
    )
    // Newest cancellations first: they are the likeliest to still settle.
    .orderBy(desc(saleOrder.cancelledAt))
    .limit(100);

  let checked = 0;
  let failuresInARow = 0;
  for (const o of candidates) {
    const provider = providerOf(o.paymentProvider);
    let ok = false;
    try {
      ok = await refire(o.orderNumber, provider);
    } catch (err) {
      logger.warn(
        { orderId: o.id, orderNumber: o.orderNumber, provider, err },
        "late-payment check: webhook re-fire failed",
      );
    }
    if (ok) {
      checked++;
      failuresInARow = 0;
      continue;
    }
    if (++failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
      logger.warn(
        { candidates: candidates.length, checked },
        "late-payment check: provider checks keep failing, stopping this sweep",
      );
      break;
    }
  }
  return checked;
}

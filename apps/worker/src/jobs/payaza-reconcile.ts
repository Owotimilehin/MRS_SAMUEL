import { eq, and, lt, gt, exists } from "drizzle-orm";
import { saleOrder, stockReservation, type DbClient } from "@ms/db";
import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "payaza-reconcile" } });

/** An order is "stuck" if Payaza's webhook never fired for it. */
const STUCK_AFTER_SECONDS = 90;

/**
 * Find online orders sitting in `confirmed` for >=90s with a still-live stock
 * reservation (the customer paid or is paying, but our webhook never landed —
 * Payaza retries are not guaranteed) and re-fire the api's Payaza webhook for
 * each, by order number, over HTTP. This keeps the worker free of any
 * `@ms/api` import: the webhook itself owns the single money-reconcile path
 * (verify + applyPayazaConfirmation), so the sweep only re-triggers it — it
 * never re-implements ledger logic here.
 *
 * Best-effort: a thrown error or non-2xx response for one order is logged and
 * the loop continues — one bad POST must never abort the sweep.
 *
 * Returns the number of orders the webhook was re-fired for.
 */
export async function sweepStuckPayazaOrders(db: DbClient, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_SECONDS * 1000);

  // Live reservation check is folded into the candidate query as an EXISTS
  // subquery (not a per-row query in the loop): only recover orders we'd
  // otherwise still be holding stock for — an order whose reservation already
  // expired has been swept back to available stock and isn't "stuck", it's
  // abandoned.
  const candidates = await db
    .select({
      id: saleOrder.id,
      orderNumber: saleOrder.orderNumber,
    })
    .from(saleOrder)
    .where(
      and(
        eq(saleOrder.channel, "online"),
        eq(saleOrder.status, "confirmed"),
        lt(saleOrder.createdAt, cutoff),
        exists(
          db
            .select({ one: stockReservation.id })
            .from(stockReservation)
            .where(
              and(
                eq(stockReservation.saleOrderId, saleOrder.id),
                gt(stockReservation.expiresAt, now),
              ),
            ),
        ),
      ),
    )
    .limit(100);

  if (candidates.length === 0) return 0;

  const base = process.env["INTERNAL_API_URL"] || "http://api:3001";
  const webhookUrl = `${base}/v1/webhooks/payaza`;

  let posted = 0;
  for (const o of candidates) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction_reference: o.orderNumber }),
      });
      if (!res.ok) {
        logger.warn(
          { orderId: o.id, orderNumber: o.orderNumber, status: res.status },
          "payaza reconcile: webhook re-fire returned non-2xx",
        );
        continue;
      }
      logger.info({ orderId: o.id, orderNumber: o.orderNumber }, "payaza reconcile: webhook re-fired");
      posted++;
    } catch (err) {
      logger.warn(
        { orderId: o.id, orderNumber: o.orderNumber, err },
        "payaza reconcile: webhook re-fire failed — continuing sweep",
      );
    }
  }
  return posted;
}

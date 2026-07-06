import { eq, and, lt, gt } from "drizzle-orm";
import { saleOrder, type DbClient } from "@ms/db";
import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "payaza-reconcile" } });

/** An order is "stuck" if Payaza's webhook never fired for it. Give the
 *  webhook this long to land before the sweep steps in. */
const STUCK_AFTER_SECONDS = 90;

/** How far back the sweep keeps re-verifying a stuck order. Payment happens in
 *  the Payaza popup within minutes of order creation, so this window is orders
 *  of magnitude larger than any realistic pay-after-create delay; it exists to
 *  (a) survive worker downtime and (b) bound the work so we don't re-verify
 *  truly-abandoned orders against Payaza forever. Past it, recovery falls to
 *  the admin "Recheck" action / payment-attention bucket. */
const LOOKBACK_HOURS = 48;

/**
 * Find online orders sitting in `confirmed` for >=90s (and <48h) — the customer
 * paid or is paying, but our webhook never landed (Payaza retries are not
 * guaranteed) — and re-fire the api's Payaza webhook for each, by order number,
 * over HTTP. This keeps the worker free of any `@ms/api` import: the webhook
 * itself owns the single money-reconcile path (verify + applyPayazaConfirmation,
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
export async function sweepStuckPayazaOrders(db: DbClient, now: Date = new Date()): Promise<number> {
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

  const base = process.env["INTERNAL_API_URL"] || "http://api:3001";

  let posted = 0;
  for (const o of candidates) {
    // Each order carries the provider it was created under (Task 1 stamp). Null
    // on legacy rows → Payaza, the original provider. Re-fire the MATCHING
    // provider's webhook so the money is re-verified against the right API.
    const provider = o.paymentProvider === "opay" ? "opay" : "payaza";
    const webhookUrl = `${base}/v1/webhooks/${provider}`;
    // Both webhooks accept a minimal { reference } re-fire and verify the money
    // server-to-server; payaza also reads transaction_reference for its callback
    // envelope shape.
    const body =
      provider === "opay"
        ? { reference: o.orderNumber }
        : { transaction_reference: o.orderNumber, reference: o.orderNumber };
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        logger.warn(
          { orderId: o.id, orderNumber: o.orderNumber, provider, status: res.status },
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

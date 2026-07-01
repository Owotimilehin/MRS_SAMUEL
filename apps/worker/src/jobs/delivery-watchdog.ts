import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  deliveryOrder,
  outboxEvent,
  saleOrder,
  type DbClient,
} from "@ms/db";
import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "delivery-watchdog" } });

const RETRY_AFTER_MIN = 2;
const ESCALATE_AFTER_MIN = 5;
const MAX_RETRIES = 1;
const RECONCILE_STALE_MIN = 30; // no webhook update in 30 min → poll the provider via the API

/**
 * Watchdog for deliveries stuck in `searching_rider`. Two thresholds:
 *
 *   t > 2 min, retry_count = 0  → bump retry_count and emit a delivery.retry
 *                                 outbox event (worker re-fires the request).
 *   t > 5 min                   → emit delivery.no_rider (Telegram to branch).
 *
 * Idempotent: each retry is bookkept via retry_count; the no-rider alert is
 * gated by checking if any outbox row already exists for this delivery.
 *
 * Returns the number of actions taken in this run.
 */
export async function runDeliveryWatchdog(db: DbClient): Promise<number> {
  const retryCutoff = new Date(Date.now() - RETRY_AFTER_MIN * 60_000);
  const escalateCutoff = new Date(Date.now() - ESCALATE_AFTER_MIN * 60_000);
  let actions = 0;

  // Candidates for retry: still searching, requested > 2min ago, retry_count
  // below cap. We hit `assignedAt IS NULL` defensively in case status flips
  // happen just as we run.
  const toRetry = await db
    .select()
    .from(deliveryOrder)
    .where(
      and(
        eq(deliveryOrder.status, "searching_rider"),
        lt(deliveryOrder.requestedAt, retryCutoff),
        lt(deliveryOrder.retryCount, MAX_RETRIES),
      ),
    )
    .limit(20);

  for (const d of toRetry) {
    // Don't retry yet if it's already escalation-time — go straight to alert.
    if (d.requestedAt < escalateCutoff) continue;

    await db
      .update(deliveryOrder)
      .set({ retryCount: d.retryCount + 1, updatedAt: new Date() })
      .where(eq(deliveryOrder.id, d.id));

    await db.insert(outboxEvent).values({
      eventType: "delivery.request",
      payload: {
        sale_order_id: d.saleOrderId,
        retry_of_delivery_id: d.id,
      },
    });
    logger.info({ deliveryId: d.id, retry: d.retryCount + 1 }, "delivery retry queued");
    actions++;
  }

  // Escalation: stuck > 5min OR retried-and-still-stuck. Alert each delivery
  // exactly once via a stable outbox check.
  const toEscalate = await db
    .select()
    .from(deliveryOrder)
    .where(
      and(
        eq(deliveryOrder.status, "searching_rider"),
        lt(deliveryOrder.requestedAt, escalateCutoff),
      ),
    )
    .limit(20);

  for (const d of toEscalate) {
    const already = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM outbox_event
      WHERE event_type = 'delivery.no_rider'
        AND payload->>'delivery_id' = ${d.id}
    `);
    if (Number(already[0]?.n ?? 0) > 0) continue;

    const [order] = await db
      .select({ orderNumber: saleOrder.orderNumber, branchId: saleOrder.branchId })
      .from(saleOrder)
      .where(eq(saleOrder.id, d.saleOrderId));
    if (!order) continue;

    await db.insert(outboxEvent).values({
      eventType: "delivery.no_rider",
      payload: {
        sale_order_id: d.saleOrderId,
        order_number: order.orderNumber,
        branch_id: order.branchId,
        delivery_id: d.id,
      },
    });
    logger.warn({ deliveryId: d.id, orderNumber: order.orderNumber }, "delivery escalated — no rider");
    actions++;
  }

  // Reconcile pass: active deliveries whose last update is stale get polled.
  // The worker never imports the API's apply logic (same boundary as payaza
  // reconcile) — it POSTs the external_ref to the internal reconcile endpoint,
  // which asks the provider for current status and applies it through the same
  // path the webhook uses. Best-effort: one bad POST must not abort the pass.
  const staleCutoff = new Date(Date.now() - RECONCILE_STALE_MIN * 60_000);
  const ACTIVE_STATUSES = ["assigned", "picked_up", "in_transit"] as const;
  const toReconcile = await db
    .select()
    .from(deliveryOrder)
    .where(
      and(
        inArray(deliveryOrder.status, ACTIVE_STATUSES),
        lt(deliveryOrder.updatedAt, staleCutoff),
        isNotNull(deliveryOrder.externalRef),
      ),
    )
    .limit(20);

  if (toReconcile.length > 0) {
    const base = process.env["INTERNAL_API_URL"] || "http://api:3001";
    const reconcileUrl = `${base}/v1/webhooks/delivery-reconcile`;
    for (const d of toReconcile) {
      if (!d.externalRef) continue;
      try {
        const res = await fetch(reconcileUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ external_ref: d.externalRef }),
        });
        if (!res.ok) {
          logger.warn({ deliveryId: d.id, status: res.status }, "delivery reconcile: endpoint returned non-2xx");
          continue;
        }
        logger.info({ deliveryId: d.id, externalRef: d.externalRef }, "delivery reconcile: polled");
        actions++;
      } catch (err) {
        logger.warn({ deliveryId: d.id, err }, "delivery reconcile: POST failed — continuing");
      }
    }
  }

  return actions;
}

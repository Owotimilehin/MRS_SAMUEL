import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import {
  deliveryOrder,
  saleOrder,
  outboxEvent,
  type DbClient,
} from "@ms/db";
import { getDeliveryProvider } from "../delivery/index.js";
import { BusinessError } from "../lib/errors.js";
import { logger } from "../logger.js";

/**
 * Bolt webhook receiver. Signed-payload verified, idempotent: replaying the
 * same event is a no-op once the row is at or beyond that status.
 *
 * Status flow on sale_order, driven by delivery_order webhooks:
 *   paid → out_for_delivery (when delivery goes picked_up or in_transit)
 *   out_for_delivery → delivered (when delivery.status = delivered)
 *
 * Failed / cancelled deliveries leave sale_order at `paid` so a human can
 * decide whether to retry, refund, or escalate.
 */
export function boltWebhookRoutes(db: DbClient) {
  return deliveryWebhookRoutes(db, "x-bolt-signature");
}

/** Shipbubble signs with `x-ship-signature` (HMAC-SHA512). */
export function shipbubbleWebhookRoutes(db: DbClient) {
  return deliveryWebhookRoutes(db, "x-ship-signature");
}

/**
 * Generic delivery webhook receiver. The active provider (selected by env)
 * verifies + normalizes the payload; the signature header name is the only
 * provider-specific bit, so it's a parameter.
 */
export function deliveryWebhookRoutes(db: DbClient, signatureHeader: string) {
  const r = new Hono();

  r.post("/", async (c) => {
    const raw = await c.req.raw.clone().text();
    const signature = c.req.header(signatureHeader) ?? null;
    const provider = getDeliveryProvider();

    let parsed;
    try {
      parsed = provider.parseWebhook(raw, signature);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "bolt webhook signature failure",
      );
      throw new BusinessError("unauthorized", "invalid signature", 401);
    }
    if (!parsed) {
      // Recognised payload, nothing to do.
      return c.json({ ok: true });
    }

    await db.transaction(async (tx) => {
      // Find the latest active delivery_order row matching this externalRef.
      const [delivery] = await tx
        .select()
        .from(deliveryOrder)
        .where(eq(deliveryOrder.externalRef, parsed.externalRef))
        .orderBy(desc(deliveryOrder.requestedAt))
        .limit(1);

      if (!delivery) {
        // Webhook for an externalRef we don't know about. Either the request
        // failed to persist or this is a stale callback. Log and ack.
        logger.warn(
          { externalRef: parsed.externalRef, status: parsed.status },
          "bolt webhook: unknown externalRef",
        );
        return;
      }

      // Idempotency: don't move backwards through the state machine.
      if (terminalStatus(delivery.status) && delivery.status === parsed.status) {
        return;
      }

      // Patch delivery_order.
      const now = new Date();
      const patch: Record<string, unknown> = {
        status: parsed.status,
        rawWebhookJson: parsed.raw,
        updatedAt: now,
      };
      if (parsed.rider?.name) patch["riderName"] = parsed.rider.name;
      if (parsed.rider?.phone) patch["riderPhone"] = parsed.rider.phone;
      if (parsed.rider?.vehicle) patch["riderVehicle"] = parsed.rider.vehicle;
      if (parsed.etaMinutes !== undefined) patch["etaMinutes"] = parsed.etaMinutes;
      if (parsed.actualFeeNgn !== undefined) patch["actualFeeNgn"] = parsed.actualFeeNgn;
      if (parsed.failReason) patch["failReason"] = parsed.failReason;
      if (parsed.status === "assigned" && !delivery.assignedAt) patch["assignedAt"] = now;
      if (parsed.status === "picked_up" && !delivery.pickedUpAt) patch["pickedUpAt"] = now;
      if (parsed.status === "delivered" && !delivery.deliveredAt) patch["deliveredAt"] = now;
      if (parsed.status === "failed" && !delivery.failedAt) patch["failedAt"] = now;
      if (parsed.status === "cancelled" && !delivery.cancelledAt) patch["cancelledAt"] = now;

      await tx
        .update(deliveryOrder)
        .set(patch)
        .where(eq(deliveryOrder.id, delivery.id));

      // Mirror status onto sale_order where appropriate.
      const [order] = await tx
        .select()
        .from(saleOrder)
        .where(eq(saleOrder.id, delivery.saleOrderId));
      if (!order) return;

      let saleStatusPatch: Record<string, unknown> | null = null;
      if (parsed.status === "picked_up" || parsed.status === "in_transit") {
        if (order.status === "paid") {
          saleStatusPatch = {
            status: "out_for_delivery" as const,
            outForDeliveryAt: now,
            updatedAt: now,
          };
        }
      } else if (parsed.status === "delivered") {
        if (
          order.status === "paid" ||
          order.status === "out_for_delivery"
        ) {
          saleStatusPatch = { status: "delivered" as const, updatedAt: now };
        }
      }
      if (saleStatusPatch) {
        await tx.update(saleOrder).set(saleStatusPatch).where(eq(saleOrder.id, order.id));
      }

      // Emit ops events for non-trivial transitions.
      if (parsed.status === "delivered") {
        await tx.insert(outboxEvent).values({
          eventType: "delivery.completed",
          payload: {
            sale_order_id: order.id,
            order_number: order.orderNumber,
            delivery_id: delivery.id,
          },
        });
      } else if (parsed.status === "failed" || parsed.status === "cancelled") {
        await tx.insert(outboxEvent).values({
          eventType: "delivery.failed",
          payload: {
            sale_order_id: order.id,
            order_number: order.orderNumber,
            delivery_id: delivery.id,
            branch_id: order.branchId,
            reason: parsed.failReason ?? parsed.status,
          },
        });
      }
    });

    return c.json({ ok: true });
  });

  return r;
}

function terminalStatus(s: string): boolean {
  return s === "delivered" || s === "cancelled" || s === "failed";
}

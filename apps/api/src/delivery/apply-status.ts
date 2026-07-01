import { eq, desc } from "drizzle-orm";
import { deliveryOrder, saleOrder, outboxEvent, type DbClient } from "@ms/db";
import type { NormalizedWebhook } from "./provider.js";
import { logger } from "../logger.js";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

function terminalStatus(s: string): boolean {
  return s === "delivered" || s === "cancelled" || s === "failed";
}

export async function applyDeliveryStatus(
  tx: Tx,
  parsed: NormalizedWebhook,
): Promise<{ changed: boolean }> {
  const [delivery] = await tx
    .select()
    .from(deliveryOrder)
    .where(eq(deliveryOrder.externalRef, parsed.externalRef))
    .orderBy(desc(deliveryOrder.requestedAt))
    .limit(1);

  if (!delivery) {
    logger.warn(
      { externalRef: parsed.externalRef, status: parsed.status },
      "delivery status: unknown externalRef",
    );
    return { changed: false };
  }
  if (terminalStatus(delivery.status) && delivery.status === parsed.status) {
    return { changed: false };
  }

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

  await tx.update(deliveryOrder).set(patch).where(eq(deliveryOrder.id, delivery.id));

  const [order] = await tx.select().from(saleOrder).where(eq(saleOrder.id, delivery.saleOrderId));
  if (!order) return { changed: true };

  let saleStatusPatch: Record<string, unknown> | null = null;
  if (parsed.status === "picked_up" || parsed.status === "in_transit") {
    if (order.status === "paid") {
      saleStatusPatch = { status: "out_for_delivery" as const, outForDeliveryAt: now, updatedAt: now };
    }
  } else if (parsed.status === "delivered") {
    if (order.status === "paid" || order.status === "out_for_delivery") {
      saleStatusPatch = { status: "delivered" as const, updatedAt: now };
    }
  }
  if (saleStatusPatch) {
    await tx.update(saleOrder).set(saleStatusPatch).where(eq(saleOrder.id, order.id));
  }

  if (parsed.status === "delivered") {
    await tx.insert(outboxEvent).values({
      eventType: "delivery.completed",
      payload: { sale_order_id: order.id, order_number: order.orderNumber, delivery_id: delivery.id },
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
  return { changed: true };
}

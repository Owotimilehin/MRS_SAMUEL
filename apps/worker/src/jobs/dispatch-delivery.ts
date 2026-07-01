import { eq, and, isNull } from "drizzle-orm";
import {
  saleOrder,
  customer,
  branch,
  deliveryOrder,
  type DbClient,
} from "@ms/db";
import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "delivery" } });

/**
 * Provider interface duplicated here as a structural type to keep the worker
 * free of an @ms/api dep. Mirrors apps/api/src/delivery/provider.ts.
 */
interface DeliveryRequestInput {
  saleOrderId: string;
  orderNumber: string;
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  dropoffAddress: string;
  customerName: string;
  customerPhone: string;
  /** The courier the customer chose, encoded requestToken::courierId::serviceCode. */
  providerQuoteId?: string;
  /** Validated dropoff address_code captured at quote time. */
  receiverAddressCode?: number;
}
interface DeliveryProviderShape {
  readonly name: "manual" | "shipbubble";
  requestDelivery(input: DeliveryRequestInput): Promise<{
    externalRef: string;
    trackingUrl: string | null;
    initialEtaMinutes: number | null;
  }>;
}

/**
 * Drain a `delivery.request` outbox event by:
 *   1. Loading sale_order, branch (pickup), customer (dropoff + phone)
 *   2. Calling provider.requestDelivery
 *   3. Inserting a delivery_order row with externalRef + trackingUrl
 *
 * Returns true if dispatched, false if data is missing (skip event).
 */
export async function dispatchDeliveryFromEvent(
  db: DbClient,
  provider: DeliveryProviderShape,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const saleOrderId = String(payload["sale_order_id"] ?? "");
  if (!saleOrderId) return false;

  const [order] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleOrderId));
  if (!order) {
    logger.warn({ saleOrderId }, "delivery.request: sale_order not found");
    return false;
  }
  // Skip if a delivery has already been dispatched for this order.
  const existing = await db
    .select({ id: deliveryOrder.id })
    .from(deliveryOrder)
    .where(eq(deliveryOrder.saleOrderId, order.id))
    .limit(1);
  if (existing.length > 0) {
    logger.info({ saleOrderId }, "delivery already exists for order — skipping");
    return false;
  }

  const [b] = await db
    .select()
    .from(branch)
    .where(and(eq(branch.id, order.branchId), isNull(branch.deletedAt)));
  if (!b || b.lat == null || b.lng == null || !b.address) {
    logger.warn(
      { saleOrderId, branchId: order.branchId },
      "delivery.request: branch missing coords or address",
    );
    return false;
  }
  if (!order.customerId) {
    logger.warn({ saleOrderId }, "delivery.request: order has no customer");
    return false;
  }
  const [cust] = await db.select().from(customer).where(eq(customer.id, order.customerId));
  if (!cust || !cust.defaultAddress || !cust.phone) {
    logger.warn(
      { saleOrderId, customerId: order.customerId },
      "delivery.request: customer missing address or phone",
    );
    return false;
  }

  let result;
  try {
    result = await provider.requestDelivery({
      saleOrderId: order.id,
      orderNumber: order.orderNumber,
      pickupAddress: b.address,
      pickupLat: Number(b.lat),
      pickupLng: Number(b.lng),
      dropoffAddress: cust.defaultAddress,
      customerName: cust.name ?? "Customer",
      customerPhone: cust.phone,
      // Honor the courier the customer chose at checkout.
      ...(order.deliveryQuoteRef ? { providerQuoteId: order.deliveryQuoteRef } : {}),
      // Route to the exact address validated + confirmed at checkout.
      ...(order.deliveryAddressCode
        ? { receiverAddressCode: Number(order.deliveryAddressCode) }
        : {}),
    });
  } catch (err) {
    logger.error(
      { saleOrderId, err: err instanceof Error ? err.message : String(err) },
      "delivery.request: provider call failed",
    );
    throw err; // let outbox mark as failed + retry
  }

  await db.insert(deliveryOrder).values({
    saleOrderId: order.id,
    provider: provider.name,
    externalRef: result.externalRef,
    pickupBranchId: b.id,
    pickupAddress: b.address,
    pickupLat: b.lat,
    pickupLng: b.lng,
    dropoffAddress: cust.defaultAddress,
    quotedFeeNgn: order.deliveryFeeNgn,
    etaMinutes: result.initialEtaMinutes,
    trackingUrl: result.trackingUrl,
    status: "searching_rider",
  });

  await db
    .update(saleOrder)
    .set({ deliveryProviderRef: result.externalRef, updatedAt: new Date() })
    .where(eq(saleOrder.id, order.id));

  logger.info(
    { saleOrderId, externalRef: result.externalRef },
    "delivery dispatched",
  );
  return true;
}

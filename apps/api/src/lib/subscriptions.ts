import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  customerSubscription,
  subscriptionCharge,
  saleOrder,
  payment,
  outboxEvent,
  type DbExecutor,
} from "@ms/db";
import { nextChargeAfter } from "@ms/shared";

type Subscription = typeof customerSubscription.$inferSelect;

/**
 * Create the per-cycle fulfilment order for a subscription. Modelled as a
 * prepaid preorder (is_preorder=true) so it lands in the existing staff-fulfil
 * queue — staff pick the cycle's bottles and stock is deducted at fulfilment,
 * exactly like a normal preorder. Returns the new sale_order id.
 */
export async function createSubscriptionCycleOrder(
  tx: DbExecutor,
  sub: Subscription,
  now: Date,
): Promise<string> {
  const orderNumber = `SUB-${now.getTime().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
  const [order] = await tx
    .insert(saleOrder)
    .values({
      orderNumber,
      branchId: sub.branchId,
      customerId: sub.customerId,
      channel: "online",
      status: "paid",
      subtotalNgn: sub.priceNgn,
      totalNgn: sub.priceNgn,
      paymentMethod: "card",
      paymentStatus: "paid",
      createdAtLocal: now,
      idempotencyKey: randomUUID(),
      isPreorder: true,
    })
    .returning();
  if (!order) throw new Error("subscription cycle order insert failed");

  await tx.insert(payment).values({
    saleOrderId: order.id,
    method: "card",
    amountNgn: sub.priceNgn,
    status: "paid",
    processor: "payaza",
    paidAt: now,
  });
  return order.id;
}

/**
 * Activate a pending subscription off its first successful Payaza payment:
 * capture the reusable token, record the first charge, create the first cycle's
 * fulfilment order, and schedule the next charge. Idempotent — only acts on a
 * `pending` subscription.
 */
export async function activateSubscriptionFromPayment(
  tx: DbExecutor,
  subscriptionId: string,
  confirmed: { processorReference: string | null; authorization: { token: string } | null },
): Promise<boolean> {
  const [sub] = await tx
    .select()
    .from(customerSubscription)
    .where(eq(customerSubscription.id, subscriptionId));
  if (!sub) return false;
  if (sub.status !== "pending") return false; // already processed

  const now = new Date();
  const periodEnd = nextChargeAfter(sub.period, now);
  const orderId = await createSubscriptionCycleOrder(tx, sub, now);

  await tx.insert(subscriptionCharge).values({
    subscriptionId: sub.id,
    periodStart: now,
    periodEnd,
    amountNgn: sub.priceNgn,
    status: "success",
    processorReference: confirmed.processorReference,
    saleOrderId: orderId,
  });

  await tx
    .update(customerSubscription)
    .set({
      status: "active",
      payazaToken: confirmed.authorization?.token ?? null,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      nextChargeAt: periodEnd,
      lastChargeAt: now,
      activatedAt: now,
      updatedAt: now,
    })
    .where(eq(customerSubscription.id, sub.id));

  await tx.insert(outboxEvent).values({
    eventType: "subscription.activated",
    payload: {
      subscription_id: sub.id,
      customer_id: sub.customerId,
      branch_id: sub.branchId,
      sale_order_id: orderId,
      amount_ngn: sub.priceNgn,
      next_charge_at: periodEnd.toISOString(),
    },
  });
  return true;
}

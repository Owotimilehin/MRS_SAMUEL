import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import {
  customerSubscription,
  subscriptionCharge,
  saleOrder,
  payment,
  customer,
  outboxEvent,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import { nextChargeAfter, PAST_DUE_GRACE_DAYS } from "@ms/shared";
import pino from "pino";
import { chargePayazaToken } from "../payments/payaza-charge.js";

const logger = pino({ base: { service: "ms-worker", part: "subscription-billing" } });

type Subscription = typeof customerSubscription.$inferSelect;

/** Create the per-cycle fulfilment order (prepaid preorder → staff queue). */
async function createCycleOrder(tx: DbExecutor, sub: Subscription, now: Date): Promise<string> {
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
 * Charge every subscription whose next charge is due. Each subscription is
 * processed in its own transaction with a row lock (FOR UPDATE) so concurrent
 * workers can't double-charge. Success → ledger + cycle order + advance period;
 * failure → past_due + dunning event.
 */
export async function sweepSubscriptionBilling(db: DbClient, now: Date = new Date()): Promise<number> {
  const due = await db
    .select({ id: customerSubscription.id })
    .from(customerSubscription)
    .where(and(eq(customerSubscription.status, "active"), lte(customerSubscription.nextChargeAt, now)));

  let charged = 0;
  for (const { id } of due) {
    try {
      const did = await db.transaction(async (tx) => {
        // Lock the row; skip if another worker grabbed it or it's no longer due.
        const [sub] = await tx
          .select()
          .from(customerSubscription)
          .where(eq(customerSubscription.id, id))
          .for("update");
        if (!sub || sub.status !== "active" || !sub.nextChargeAt || sub.nextChargeAt > now) {
          return false;
        }

        const [cust] = await tx.select().from(customer).where(eq(customer.id, sub.customerId));
        const reference = `SUB_${sub.id}_${now.getTime()}`;
        const result = await chargePayazaToken({
          token: sub.payazaToken,
          amountNgn: sub.priceNgn,
          reference,
          email: cust?.email ?? "no-email@example.com",
        });

        const periodEnd = nextChargeAfter(sub.period, now);
        if (result.success) {
          const orderId = await createCycleOrder(tx, sub, now);
          await tx.insert(subscriptionCharge).values({
            subscriptionId: sub.id,
            periodStart: sub.currentPeriodEnd ?? now,
            periodEnd,
            amountNgn: sub.priceNgn,
            status: "success",
            processorReference: result.processorReference,
            saleOrderId: orderId,
          });
          await tx
            .update(customerSubscription)
            .set({
              currentPeriodStart: sub.currentPeriodEnd ?? now,
              currentPeriodEnd: periodEnd,
              nextChargeAt: periodEnd,
              lastChargeAt: now,
              failedAttempts: 0,
              status: "active",
              pastDueSince: null,
              updatedAt: now,
            })
            .where(eq(customerSubscription.id, sub.id));
          await tx.insert(outboxEvent).values({
            eventType: "subscription.charged",
            payload: {
              subscription_id: sub.id,
              customer_id: sub.customerId,
              branch_id: sub.branchId,
              sale_order_id: orderId,
              amount_ngn: sub.priceNgn,
            },
          });
          return true;
        }

        // Failure → past_due + retry tomorrow + dunning ping.
        await tx.insert(subscriptionCharge).values({
          subscriptionId: sub.id,
          periodStart: sub.currentPeriodEnd ?? now,
          periodEnd,
          amountNgn: sub.priceNgn,
          status: "failed",
          processorReference: result.processorReference,
          failureReason: result.failureReason,
        });
        await tx
          .update(customerSubscription)
          .set({
            status: "past_due",
            failedAttempts: sub.failedAttempts + 1,
            pastDueSince: sub.pastDueSince ?? now,
            nextChargeAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            updatedAt: now,
          })
          .where(eq(customerSubscription.id, sub.id));
        await tx.insert(outboxEvent).values({
          eventType: "subscription.payment_failed",
          payload: {
            subscription_id: sub.id,
            customer_id: sub.customerId,
            amount_ngn: sub.priceNgn,
            attempt: sub.failedAttempts + 1,
            reason: result.failureReason,
          },
        });
        return false;
      });
      if (did) charged += 1;
    } catch (err) {
      logger.error(
        { subscriptionId: id, err: err instanceof Error ? err.message : String(err) },
        "subscription charge failed",
      );
    }
  }
  if (due.length > 0) logger.info({ due: due.length, charged }, "subscription billing sweep done");
  return charged;
}

/**
 * Cancel subscriptions stuck in past_due beyond the grace window. Returns the
 * number cancelled.
 */
export async function sweepPastDueCancellations(
  db: DbClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const cancelled = await db
    .update(customerSubscription)
    .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
    .where(
      and(
        eq(customerSubscription.status, "past_due"),
        lte(customerSubscription.pastDueSince, cutoff),
      ),
    )
    .returning({ id: customerSubscription.id });
  for (const { id } of cancelled) {
    await db.insert(outboxEvent).values({
      eventType: "subscription.cancelled",
      payload: { subscription_id: id, reason: "past_due_grace_expired" },
    });
  }
  if (cancelled.length > 0) logger.info({ cancelled: cancelled.length }, "past-due subscriptions cancelled");
  return cancelled.length;
}

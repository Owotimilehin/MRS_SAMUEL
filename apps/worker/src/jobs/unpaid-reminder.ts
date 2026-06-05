import { eq, and, lt, gt, sql, isNull } from "drizzle-orm";
import {
  saleOrder,
  customer,
  outboxEvent,
  stockReservation,
  type DbClient,
} from "@ms/db";

/**
 * Find online orders that have been sitting in `confirmed` status for >=15min
 * (the user opened OPay but never paid) and whose stock reservation is still
 * live (we haven't given up on them). Emit a one-time `sale.payment_reminder`
 * outbox event per order so the outbox worker can email/SMS the customer.
 *
 * Idempotency: we only emit the event if there isn't already a payment_reminder
 * row for this sale_order_id in outbox_event. Once emitted, future calls skip
 * the order.
 *
 * Returns the number of reminders queued in this run.
 */
const REMINDER_AFTER_MIN = 15;

export async function queuePaymentReminders(db: DbClient): Promise<number> {
  const cutoff = new Date(Date.now() - REMINDER_AFTER_MIN * 60_000);
  const now = new Date();

  // Candidate orders: confirmed, online, older than cutoff, with a live reservation.
  const candidates = await db
    .select({
      id: saleOrder.id,
      orderNumber: saleOrder.orderNumber,
      customerId: saleOrder.customerId,
      totalNgn: saleOrder.totalNgn,
    })
    .from(saleOrder)
    .where(
      and(
        eq(saleOrder.status, "confirmed"),
        eq(saleOrder.channel, "online"),
        lt(saleOrder.createdAt, cutoff),
      ),
    )
    .limit(100);

  if (candidates.length === 0) return 0;

  let queued = 0;
  for (const o of candidates) {
    // Live reservation check.
    const liveResv = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(stockReservation)
      .where(and(eq(stockReservation.saleOrderId, o.id), gt(stockReservation.expiresAt, now)));
    if (Number(liveResv[0]?.n ?? 0) === 0) continue;

    // Already-reminded check — outbox event with this id + type already present?
    const already = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM outbox_event
      WHERE event_type = 'sale.payment_reminder'
        AND payload->>'sale_order_id' = ${o.id}
    `);
    if (Number(already[0]?.n ?? 0) > 0) continue;

    // Fetch customer email (if any) so the outbox worker has it without re-querying.
    let email: string | null = null;
    let name: string | null = null;
    if (o.customerId) {
      const [cust] = await db
        .select({ email: customer.email, name: customer.name })
        .from(customer)
        .where(and(eq(customer.id, o.customerId), isNull(customer.deletedAt)));
      email = cust?.email ?? null;
      name = cust?.name ?? null;
    }
    if (!email) continue; // no inbox to notify — skip rather than spam

    await db.insert(outboxEvent).values({
      eventType: "sale.payment_reminder",
      payload: {
        sale_order_id: o.id,
        order_number: o.orderNumber,
        customer_email: email,
        customer_name: name,
        total_ngn: o.totalNgn,
      },
    });
    queued++;
  }
  return queued;
}

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  saleOrder,
  saleOrderItem,
  payment,
  stockLedger,
  stockReservation,
  outboxEvent,
  type DbClient,
} from "@ms/db";
import { queryOpayOrder } from "../payments/opay.js";
import { isOutsideLagos } from "@ms/shared";

/**
 * OPay webhook receiver. The callback is treated as a wake-up only — we don't
 * trust its body for the money decision. On every callback we re-read the
 * order from OPay (queryOpayOrder) and only flip the order to paid when OPay
 * itself reports SUCCESS. Idempotent: replaying a callback for an already-paid
 * order is a no-op.
 *
 * Dev mode: when OPay creds are unset, queryOpayOrder returns a mock SUCCESS
 * so the mock checkout URL can simulate completion.
 */
export function opayWebhookRoutes(db: DbClient) {
  const r = new Hono();

  r.post("/", async (c) => {
    const raw = await c.req.raw.clone().text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ ok: true });
    }
    // OPay nests the order under `payload`; accept a couple of shapes
    // defensively since the exact envelope varies by product.
    const p = parsed as {
      payload?: { reference?: string };
      data?: { reference?: string };
      reference?: string;
    };
    const reference = p.payload?.reference ?? p.data?.reference ?? p.reference;
    if (!reference || typeof reference !== "string") return c.json({ ok: true });

    // Authoritative confirmation — never trust the callback body for money.
    const confirmed = await queryOpayOrder(reference);
    if (confirmed.status !== "SUCCESS") return c.json({ ok: true });

    await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.orderNumber, reference));
      if (!o) return;
      if (o.status !== "confirmed") return; // already processed or invalid

      // Reject a confirmation whose amount disagrees with our recorded total —
      // partial capture, currency drift, or a replayed test event. Leave the
      // order in 'confirmed' (reservation sweep handles it) and flag for manual
      // review rather than ledger out stock for less than paid.
      if (confirmed.amountNgn != null && confirmed.amountNgn !== o.totalNgn) {
        await tx
          .update(saleOrder)
          .set({ status: "reconcile_needed", updatedAt: new Date() })
          .where(eq(saleOrder.id, o.id));
        await tx.insert(outboxEvent).values({
          eventType: "sale.amount_mismatch",
          payload: {
            sale_order_id: o.id,
            order_number: o.orderNumber,
            expected_ngn: o.totalNgn,
            reported_ngn: confirmed.amountNgn,
            opay_reference: confirmed.orderNo ?? null,
          },
        });
        return;
      }

      const items = await tx
        .select()
        .from(saleOrderItem)
        .where(eq(saleOrderItem.saleOrderId, o.id));
      for (const it of items) {
        await tx.insert(stockLedger).values({
          locationType: "branch",
          locationId: o.branchId,
          productId: it.productId,
          variantId: it.variantId ?? null,
          delta: -it.quantity,
          sourceType: "sale",
          sourceId: o.id,
          note: `Online sale ${o.orderNumber}`,
        });
      }
      await tx.delete(stockReservation).where(eq(stockReservation.saleOrderId, o.id));
      await tx.insert(payment).values({
        saleOrderId: o.id,
        method: "card",
        amountNgn: o.totalNgn,
        status: "paid",
        processor: "opay",
        processorReference: confirmed.orderNo ?? null,
        paidAt: new Date(),
      });
      await tx
        .update(saleOrder)
        .set({ status: "paid", paymentStatus: "paid", updatedAt: new Date() })
        .where(eq(saleOrder.id, o.id));
      await tx.insert(outboxEvent).values({
        eventType: "sale.paid_online",
        payload: {
          sale_order_id: o.id,
          order_number: o.orderNumber,
          branch_id: o.branchId,
          customer_id: o.customerId,
          total_ngn: o.totalNgn,
          scheduled_delivery_at: o.scheduledDeliveryAt
            ? o.scheduledDeliveryAt.toISOString()
            : null,
          delivery_state: o.deliveryState ?? null,
        },
      });
      // Bypass: scheduled (future) OR outside-Lagos orders skip automated Bolt
      // dispatch entirely; the owner fulfils them out-of-band. Only immediate,
      // in-Lagos orders request a ride.
      const outsideLagos = isOutsideLagos(o.deliveryState);
      const bypass = o.scheduledDeliveryAt != null || outsideLagos;
      if (!bypass) {
        await tx.insert(outboxEvent).values({
          eventType: "delivery.request",
          payload: {
            sale_order_id: o.id,
            order_number: o.orderNumber,
            branch_id: o.branchId,
          },
        });
      }
    });

    return c.json({ ok: true });
  });

  return r;
}

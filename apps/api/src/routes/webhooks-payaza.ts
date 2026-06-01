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
import { verifyWebhookSignature } from "../payments/payaza.js";
import { BusinessError } from "../lib/errors.js";
import { isOutsideLagos } from "@ms/shared";

/**
 * Payaza webhook receiver. We don't trust the redirect URL — only signed
 * webhooks flip an order to paid. The handler is idempotent: replaying the
 * same payload is a no-op once the order is already paid.
 *
 * Dev mode: when PAYAZA_WEBHOOK_SECRET is unset, the signature check
 * accepts any payload so the mock checkout URL can simulate completion.
 */
export function payazaWebhookRoutes(db: DbClient) {
  const r = new Hono();

  r.post("/", async (c) => {
    const raw = await c.req.raw.clone().text();
    const sig = c.req.header("x-payaza-signature") ?? "";
    if (!verifyWebhookSignature(raw, sig)) {
      throw new BusinessError("unauthorized", "bad signature", 401);
    }
    const body = JSON.parse(raw) as {
      event?: string;
      data?: {
        transaction_reference?: string;
        status?: string;
        amount?: number;
        payaza_reference?: string;
      };
    };
    if (body.event !== "transaction.success") return c.json({ ok: true });
    const reference = body.data?.transaction_reference;
    if (!reference) return c.json({ ok: true });

    await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.orderNumber, reference));
      if (!o) return;
      if (o.status !== "confirmed") return; // already processed or invalid

      // Reject a webhook whose amount disagrees with our recorded total —
      // could be a partial capture, currency drift, or a replayed test event.
      // Better to leave the order in 'confirmed' (reservation will sweep) and
      // surface for manual review than to ledger out stock for less than paid.
      const reported = body.data?.amount;
      if (typeof reported === "number" && reported !== o.totalNgn) {
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
            reported_ngn: reported,
            payaza_reference: body.data?.payaza_reference ?? null,
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
        processor: "payaza",
        processorReference: body.data?.payaza_reference ?? null,
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
        // Kick off the delivery request via the worker outbox. The worker
        // calls Bolt, persists a delivery_order row, and surfaces the result.
        // Doing it from the worker (rather than inline) lets us retry without
        // re-running the payment-completion code path.
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

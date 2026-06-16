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
import { verifyPayazaTransaction, verifyPayazaSignature, isPayazaSuccess } from "../payments/payaza.js";
import { isOutsideLagos } from "@ms/shared";

/**
 * Payaza webhook receiver. The callback is signature-verified (HMAC-SHA512,
 * x-payaza-signature) and then treated as a wake-up only — we don't trust its
 * body for the money decision. On every callback we re-read the transaction
 * from Payaza (verifyPayazaTransaction) and only flip the order to paid when
 * Payaza itself reports success. Idempotent: replaying a callback for an
 * already-paid order is a no-op.
 *
 * Dev mode: when Payaza creds are unset, the signature check is skipped and
 * verifyPayazaTransaction returns a mock success so the mock checkout URL can
 * simulate completion.
 */
export function payazaWebhookRoutes(db: DbClient) {
  const r = new Hono();

  r.post("/", async (c) => {
    const raw = await c.req.raw.clone().text();
    const signature = c.req.header("x-payaza-signature") ?? null;
    if (!verifyPayazaSignature(raw, signature)) {
      // Bad signature — ack quietly so Payaza stops retrying, but do nothing.
      return c.json({ ok: true });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ ok: true });
    }
    // Payaza nests the transaction under a couple of shapes depending on the
    // event envelope; accept the common ones defensively.
    const p = parsed as {
      data?: { transaction_reference?: string; reference?: string };
      transaction_reference?: string;
      reference?: string;
    };
    const reference =
      p.data?.transaction_reference ?? p.data?.reference ?? p.transaction_reference ?? p.reference;
    if (!reference || typeof reference !== "string") return c.json({ ok: true });

    // Authoritative confirmation — never trust the callback body for money.
    const confirmed = await verifyPayazaTransaction(reference);
    if (!isPayazaSuccess(confirmed.status)) return c.json({ ok: true });

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
            payaza_reference: confirmed.processorReference ?? null,
          },
        });
        return;
      }

      // A preorder is prepaid but not yet made — capture payment WITHOUT moving
      // stock. The deduction happens later when staff fulfil it (preorders.ts).
      if (!o.isPreorder) {
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
      }
      await tx.insert(payment).values({
        saleOrderId: o.id,
        method: "card",
        amountNgn: o.totalNgn,
        status: "paid",
        processor: "payaza",
        processorReference: confirmed.processorReference ?? null,
        paidAt: new Date(),
      });
      await tx
        .update(saleOrder)
        .set({ status: "paid", paymentStatus: "paid", updatedAt: new Date() })
        .where(eq(saleOrder.id, o.id));
      await tx.insert(outboxEvent).values({
        // A paid preorder awaits fulfilment (not delivery yet) — distinct event
        // so the owner is alerted it has joined the Preorders queue.
        eventType: o.isPreorder ? "sale.preorder_paid" : "sale.paid_online",
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
      // Bypass: preorders (not made yet), scheduled (future), OR outside-Lagos
      // orders skip automated delivery dispatch entirely; they're fulfilled out
      // of band. Only immediate, in-Lagos, in-stock orders request a ride now.
      const outsideLagos = isOutsideLagos(o.deliveryState);
      const bypass = o.isPreorder || o.scheduledDeliveryAt != null || outsideLagos;
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

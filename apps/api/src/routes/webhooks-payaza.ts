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
import { verifyPayazaTransaction, isPayazaSuccess } from "../payments/payaza.js";
import { activateSubscriptionFromPayment } from "../lib/subscriptions.js";
import { autoDispatchEnabled } from "../lib/delivery-flags.js";
import { isOutsideLagos } from "@ms/shared";
import { logger } from "../logger.js";

/**
 * Payaza webhook receiver. Payaza does NOT sign its callbacks — there is no
 * HMAC/x-payaza-signature scheme (its WooCommerce plugin confirms payments by
 * re-querying the transaction, not by verifying a signature). So we treat the
 * callback purely as a wake-up and NEVER trust its body for the money decision:
 * on every callback we re-read the transaction from Payaza
 * (verifyPayazaTransaction, authed server-to-server) and only flip the order to
 * paid when Payaza itself reports success. The merchant_reference is our own
 * order number, so a forged callback can at most trigger a status re-read of a
 * real order — it cannot fabricate a payment. Idempotent: replaying a callback
 * for an already-paid order is a no-op.
 *
 * Dev mode: when Payaza creds are unset, verifyPayazaTransaction returns a mock
 * success so the mock checkout URL can simulate completion.
 */
export function payazaWebhookRoutes(db: DbClient) {
  const r = new Hono();

  r.post("/", async (c) => {
    const requestId = c.get("requestId") as string | undefined;
    const raw = await c.req.raw.clone().text();
    // Entry log — proves Payaza actually reached us, even if the body is junk.
    // This is the line to watch when verifying the dashboard callback fires.
    logger.info({ requestId, rawLen: raw.length }, "payaza webhook: inbound");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn({ requestId }, "payaza webhook: non-JSON body — ignored");
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
    if (!reference || typeof reference !== "string") {
      logger.warn({ requestId }, "payaza webhook: no transaction reference in body — ignored");
      return c.json({ ok: true });
    }

    // Authoritative confirmation — never trust the callback body for money. A
    // verify failure (auth/outage) throws → 500 so Payaza retries; log it loudly
    // first so a misconfigured key surfaces instead of dropping silently.
    let confirmed;
    try {
      confirmed = await verifyPayazaTransaction(reference);
    } catch (err) {
      logger.error(
        { requestId, reference, err },
        "payaza webhook: verify call FAILED — returning 500 so Payaza retries",
      );
      throw err;
    }
    if (!isPayazaSuccess(confirmed.status)) {
      logger.info(
        { requestId, reference, payazaStatus: confirmed.status },
        "payaza webhook: not a completed payment — no-op",
      );
      return c.json({ ok: true });
    }

    // Subscription first-payment references are SUB_<subscriptionId>; route them
    // to activation (capture token, first cycle order, schedule next charge).
    if (reference.startsWith("SUB_")) {
      const subscriptionId = reference.slice("SUB_".length);
      await db.transaction(async (tx) => {
        await activateSubscriptionFromPayment(tx, subscriptionId, confirmed);
      });
      logger.info({ requestId, reference, subscriptionId }, "payaza webhook: subscription activated");
      return c.json({ ok: true });
    }

    const outcome = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.orderNumber, reference));
      if (!o) return { kind: "order_not_found" as const };
      if (o.status !== "confirmed") return { kind: "already_processed" as const, status: o.status };

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
        return {
          kind: "amount_mismatch" as const,
          expected: o.totalNgn,
          reported: confirmed.amountNgn,
        };
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
      // Auto-dispatch is OFF by default — rides are booked manually from the
      // admin order page. When AUTO_DISPATCH_DELIVERY=true, fall back to the
      // legacy behavior: immediate, in-Lagos, in-stock orders request a ride now
      // (preorders / scheduled / outside-Lagos are always fulfilled out of band).
      const outsideLagos = isOutsideLagos(o.deliveryState);
      const bypass = o.isPreorder || o.scheduledDeliveryAt != null || outsideLagos;
      if (autoDispatchEnabled() && !bypass) {
        await tx.insert(outboxEvent).values({
          eventType: "delivery.request",
          payload: {
            sale_order_id: o.id,
            order_number: o.orderNumber,
            branch_id: o.branchId,
          },
        });
      }
      return {
        kind: "paid" as const,
        orderNumber: o.orderNumber,
        amountNgn: o.totalNgn,
        isPreorder: o.isPreorder,
      };
    });

    // One conclusive line per webhook so the outcome is always traceable.
    switch (outcome.kind) {
      case "order_not_found":
        logger.warn({ requestId, reference }, "payaza webhook: no matching order — no-op");
        break;
      case "already_processed":
        logger.info(
          { requestId, reference, status: outcome.status },
          "payaza webhook: order already processed — no-op (idempotent)",
        );
        break;
      case "amount_mismatch":
        logger.warn(
          { requestId, reference, expectedNgn: outcome.expected, reportedNgn: outcome.reported },
          "payaza webhook: AMOUNT MISMATCH — parked for reconcile",
        );
        break;
      case "paid":
        logger.info(
          {
            requestId,
            reference,
            orderNumber: outcome.orderNumber,
            amountNgn: outcome.amountNgn,
            isPreorder: outcome.isPreorder,
          },
          "payaza webhook: order marked PAID",
        );
        break;
    }

    return c.json({ ok: true });
  });

  return r;
}

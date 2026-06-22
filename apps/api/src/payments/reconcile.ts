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
import { isOutsideLagos } from "@ms/shared";
import { verifyPayazaTransaction, isPayazaSuccess, type PayazaTransactionStatus } from "./payaza.js";
import { autoDispatchEnabled } from "../lib/delivery-flags.js";

export type ReconcileOutcome =
  | { kind: "order_not_found" }
  | { kind: "already_processed"; status: string }
  | { kind: "not_completed"; payazaStatus: string }
  | { kind: "amount_mismatch"; expectedNgn: number; reportedNgn: number }
  | { kind: "paid"; orderNumber: string; amountNgn: number; isPreorder: boolean };

/**
 * Shared "mark order paid" money-logic, extracted verbatim from the Payaza
 * webhook so the webhook, cron sweeper, on-view re-verify, and admin actions
 * all go through one tested path. Idempotent: replaying against an
 * already-paid order is a no-op (`already_processed`).
 *
 * `opts.acceptReportedAmount` lets a deliberate reconciliation action (cron /
 * admin) accept whatever Payaza reports as the truth instead of rejecting on
 * mismatch — the webhook never sets this.
 */
export async function applyPayazaConfirmation(
  tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
  order: typeof saleOrder.$inferSelect,
  confirmed: PayazaTransactionStatus,
  opts?: { acceptReportedAmount?: boolean },
): Promise<ReconcileOutcome> {
  const o = order;
  if (o.status !== "confirmed") return { kind: "already_processed", status: o.status };

  // Reject a confirmation whose amount disagrees with our recorded total —
  // partial capture, currency drift, or a replayed test event. Leave the
  // order in 'confirmed' (reservation sweep handles it) and flag for manual
  // review rather than ledger out stock for less than paid.
  if (
    !opts?.acceptReportedAmount &&
    confirmed.amountNgn != null &&
    confirmed.amountNgn !== o.totalNgn
  ) {
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
      kind: "amount_mismatch",
      expectedNgn: o.totalNgn,
      reportedNgn: confirmed.amountNgn,
    };
  }

  // A preorder is prepaid but not yet made — capture payment WITHOUT moving
  // stock. The deduction happens later when staff fulfil it (preorders.ts).
  if (!o.isPreorder) {
    const items = await tx.select().from(saleOrderItem).where(eq(saleOrderItem.saleOrderId, o.id));
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
  const amountNgn = opts?.acceptReportedAmount ? confirmed.amountNgn ?? o.totalNgn : o.totalNgn;
  await tx.insert(payment).values({
    saleOrderId: o.id,
    method: "card",
    amountNgn,
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
      scheduled_delivery_at: o.scheduledDeliveryAt ? o.scheduledDeliveryAt.toISOString() : null,
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
    kind: "paid",
    orderNumber: o.orderNumber,
    amountNgn,
    isPreorder: o.isPreorder,
  };
}

/**
 * Re-verify a single order against Payaza and reconcile if it reports
 * success. Used by the cron sweeper and on-view re-verify — not the webhook
 * (which already has its own `confirmed` from the callback wake-up).
 */
export async function verifyAndReconcile(
  db: DbClient,
  orderNumber: string,
): Promise<ReconcileOutcome> {
  const confirmed = await verifyPayazaTransaction(orderNumber);
  if (!isPayazaSuccess(confirmed.status)) {
    return { kind: "not_completed", payazaStatus: confirmed.status };
  }
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.orderNumber, orderNumber));
    if (!o) return { kind: "order_not_found" };
    return applyPayazaConfirmation(tx, o, confirmed);
  });
}

import { and, eq, inArray } from "drizzle-orm";
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
  | { kind: "underpaid"; totalNgn: number; netNgn: number; shortfallNgn: number }
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

  // What actually settles to the business = net (customer-paid minus Payaza's
  // fee). Payaza always deducts its fee, so the order is "paid in full" only
  // when net >= product total. Fall back to gross when Payaza reports no fee
  // field (still kills false positives; loses exact underpayment detection).
  const TOLERANCE = 1; // naira, absorbs Payaza's kobo rounding
  const effectiveNet = confirmed.netNgn ?? confirmed.amountNgn ?? o.totalNgn;
  if (!opts?.acceptReportedAmount && effectiveNet < o.totalNgn - TOLERANCE) {
    const shortfallNgn = o.totalNgn - effectiveNet;
    const won = await tx
      .update(saleOrder)
      .set({ status: "reconcile_needed", feeShortfallNgn: shortfallNgn, updatedAt: new Date() })
      .where(and(eq(saleOrder.id, o.id), eq(saleOrder.status, "confirmed")))
      .returning({ id: saleOrder.id });
    if (won.length === 0) return { kind: "already_processed", status: o.status };
    await tx.insert(outboxEvent).values({
      eventType: "sale.fee_shortfall",
      payload: {
        sale_order_id: o.id,
        order_number: o.orderNumber,
        total_ngn: o.totalNgn,
        gross_ngn: confirmed.amountNgn,
        fee_ngn: confirmed.feeNgn,
        net_ngn: effectiveNet,
        shortfall_ngn: shortfallNgn,
        payaza_reference: confirmed.processorReference ?? null,
      },
    });
    return { kind: "underpaid", totalNgn: o.totalNgn, netNgn: effectiveNet, shortfallNgn };
  }

  // CAS: flip confirmed→paid FIRST, guarded by the current status. Two
  // concurrent callers (webhook + cron sweep + on-view re-verify + admin
  // recheck can all race the same stuck order) may both pass the cheap
  // early-return above under READ COMMITTED, but only one UPDATE can match
  // `status = 'confirmed'` and return a row — the loser must do nothing
  // further (no second payment row, no second stock deduction).
  const won = await tx
    .update(saleOrder)
    .set({ status: "paid", paymentStatus: "paid", feeShortfallNgn: null, updatedAt: new Date() })
    .where(and(eq(saleOrder.id, o.id), eq(saleOrder.status, "confirmed")))
    .returning({ id: saleOrder.id });
  if (won.length === 0) return { kind: "already_processed", status: o.status };

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
  // amount_ngn stays the product total (the business's money) so revenue
  // reports that SUM(payment.amount_ngn) never include Payaza's fee.
  await tx.insert(payment).values({
    saleOrderId: o.id,
    method: "card",
    amountNgn: o.totalNgn,
    grossNgn: confirmed.amountNgn ?? null,
    feeNgn: confirmed.feeNgn ?? null,
    netNgn: confirmed.netNgn ?? (confirmed.amountNgn != null && confirmed.feeNgn != null ? confirmed.amountNgn - confirmed.feeNgn : null),
    rawBreakdown: confirmed.raw ?? null,
    status: "paid",
    processor: "payaza",
    processorReference: confirmed.processorReference ?? null,
    paidAt: new Date(),
  });
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
    amountNgn: o.totalNgn,
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

    // A previously-stuck order (flagged reconcile_needed by the old exact-equality
    // reconciliation, or a genuine earlier shortfall since topped up) must be
    // re-openable: nudge it back to 'confirmed' — CAS-guarded — so
    // applyPayazaConfirmation's own guard/CAS acts on it. Only reached when
    // Payaza already reports success (checked above), so we never reopen an order
    // with no money behind it.
    let orderForConfirmation = o;
    if (o.status === "reconcile_needed") {
      const won = await tx
        .update(saleOrder)
        .set({ status: "confirmed", updatedAt: new Date() })
        .where(and(eq(saleOrder.id, o.id), eq(saleOrder.status, "reconcile_needed")))
        .returning({ id: saleOrder.id });
      if (won.length === 0) {
        // A concurrent caller already moved it — re-read and let
        // applyPayazaConfirmation decide from the fresh state.
        const [fresh] = await tx.select().from(saleOrder).where(eq(saleOrder.id, o.id));
        orderForConfirmation = fresh ?? o;
      } else {
        orderForConfirmation = { ...o, status: "confirmed" };
      }
    }

    return applyPayazaConfirmation(tx, orderForConfirmation, confirmed);
  });
}

export interface OfflinePaymentInput {
  method: "transfer" | "cash";
  amountNgn: number;
  collectedByUserId: string | null;
}

/**
 * Record a payment received OUTSIDE Payaza (bank transfer / cash) and mark the
 * order paid. Used when the customer paid the whole amount, or topped up a
 * shortfall, by a non-Payaza means. Mirrors applyPayazaConfirmation's paid
 * branch: CAS flip, one payment row (processor 'manual'), stock for a non-
 * preorder, preorder-paid/paid-online outbox event. Idempotent.
 */
export async function applyOfflinePayment(
  tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
  order: typeof saleOrder.$inferSelect,
  input: OfflinePaymentInput,
): Promise<ReconcileOutcome> {
  const o = order;
  if (o.status !== "confirmed" && o.status !== "reconcile_needed") {
    return { kind: "already_processed", status: o.status };
  }

  const won = await tx
    .update(saleOrder)
    .set({ status: "paid", paymentStatus: "paid", feeShortfallNgn: null, updatedAt: new Date() })
    .where(
      and(
        eq(saleOrder.id, o.id),
        inArray(saleOrder.status, ["confirmed", "reconcile_needed"]),
      ),
    )
    .returning({ id: saleOrder.id });
  if (won.length === 0) return { kind: "already_processed", status: o.status };

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
        note: `Offline (${input.method}) sale ${o.orderNumber}`,
      });
    }
    await tx.delete(stockReservation).where(eq(stockReservation.saleOrderId, o.id));
  }

  await tx.insert(payment).values({
    saleOrderId: o.id,
    method: input.method,
    amountNgn: input.amountNgn,
    status: "paid",
    processor: "manual",
    collectedByUserId: input.collectedByUserId,
    paidAt: new Date(),
  });

  await tx.insert(outboxEvent).values({
    eventType: o.isPreorder ? "sale.preorder_paid" : "sale.paid_online",
    payload: {
      sale_order_id: o.id,
      order_number: o.orderNumber,
      branch_id: o.branchId,
      customer_id: o.customerId,
      total_ngn: o.totalNgn,
      payment_method: input.method,
      offline: true,
      scheduled_delivery_at: o.scheduledDeliveryAt ? o.scheduledDeliveryAt.toISOString() : null,
      delivery_state: o.deliveryState ?? null,
    },
  });

  return { kind: "paid", orderNumber: o.orderNumber, amountNgn: o.totalNgn, isPreorder: o.isPreorder };
}

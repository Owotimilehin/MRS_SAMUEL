import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  saleOrder,
  saleOrderItem,
  stockReservation,
  stockLedger,
  outboxEvent,
  type DbClient,
} from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { applyPayazaConfirmation, verifyAndReconcile } from "../payments/reconcile.js";
import { verifyPayazaTransaction } from "../payments/payaza.js";

const TERMINAL_STATUSES = [
  "handed_over",
  "delivered",
  "cancelled",
  "failed",
  "refunded",
] as const;

const CancelRefundBody = z.object({
  reason: z.string().min(1, "reason is required"),
});

/**
 * Admin-facing payment reconciliation endpoints for online orders.
 * Mounted under /v1/online-orders.
 *
 * All routes require authentication. Per-route capability gates:
 * - orders.manage  → recheck, cancel-refund
 * - orders.accept_payment (owner-only by default) → accept, mark-refunded
 */
export function paymentsAdminRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  /** Load an order by id, asserting it exists and is an online order. */
  async function loadOnlineOrder(id: string) {
    const [o] = await db.select().from(saleOrder).where(eq(saleOrder.id, id));
    if (!o) throw new BusinessError("not_found", "order not found", 404);
    if (o.channel !== "online") {
      throw new BusinessError("conflict", "this action is only for online orders", 409);
    }
    return o;
  }

  /**
   * POST /:id/recheck
   * Re-verify the order's Payaza transaction and reconcile if Payaza reports
   * success. Idempotent: replaying against an already-paid order returns
   * already_processed without side effects.
   */
  r.post("/:id/recheck", requireCapability("orders.manage"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);

    const o = await loadOnlineOrder(id);
    const outcome = await verifyAndReconcile(db, o.orderNumber);

    // Reload to get the current (potentially updated) status
    const [current] = await db.select().from(saleOrder).where(eq(saleOrder.id, id));
    const status = current?.status ?? o.status;

    return c.json({ data: { status, outcome } });
  });

  /**
   * POST /:id/accept
   * Owner-only: accept whatever Payaza reports as the authoritative amount and
   * mark the order paid, even if there was an amount mismatch. Idempotent path:
   * if status was `reconcile_needed`, reset it to `confirmed` first so
   * applyPayazaConfirmation's guard acts on it.
   */
  r.post("/:id/accept", requireCapability("orders.accept_payment"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);

    const o = await loadOnlineOrder(id);

    const allowedStatuses = ["confirmed", "reconcile_needed"] as const;
    if (!(allowedStatuses as readonly string[]).includes(o.status)) {
      throw new BusinessError(
        "conflict",
        `cannot accept payment from status '${o.status}'`,
        409,
      );
    }

    // Fetch Payaza status before entering the transaction (avoids holding tx open
    // during an HTTP call).
    const confirmed = await verifyPayazaTransaction(o.orderNumber);

    const outcome = await db.transaction(async (tx) => {
      // Re-read inside transaction to guard against concurrent modification.
      const [fresh] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
      if (!fresh) throw new BusinessError("not_found", "order not found", 404);

      // If the order slipped to reconcile_needed, nudge it back to confirmed
      // so applyPayazaConfirmation's idempotent core will act on it.
      const orderForConfirmation =
        fresh.status === "reconcile_needed"
          ? (await tx
              .update(saleOrder)
              .set({ status: "confirmed", updatedAt: new Date() })
              .where(eq(saleOrder.id, id))
              .returning())[0] ?? fresh
          : fresh;

      return applyPayazaConfirmation(tx, orderForConfirmation, confirmed, {
        acceptReportedAmount: true,
      });
    });

    if (outcome.kind !== "paid" && outcome.kind !== "already_processed") {
      // applyPayazaConfirmation shouldn't reach underpaid with acceptReportedAmount,
      // but guard defensively.
      throw new BusinessError("conflict", `reconcile returned: ${outcome.kind}`, 409);
    }

    await writeAudit(db, c, {
      action: "sale_order.accept_payment",
      entityType: "sale_order",
      entityId: id,
      after: { orderNumber: o.orderNumber, outcome: outcome.kind },
    });

    return c.json({ data: { status: "paid" } });
  });

  /**
   * POST /:id/cancel-refund
   * Cancel an unfulfilled online order and mark a refund as owed. Restores
   * stock if the order was already paid. Terminal/fulfilled orders (delivered,
   * handed_over, etc.) are rejected — those go through the returns system.
   */
  r.post("/:id/cancel-refund", requireCapability("orders.manage"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);

    const auth = c.get("auth");

    let body: z.infer<typeof CancelRefundBody>;
    try {
      body = CancelRefundBody.parse(await c.req.json());
    } catch {
      throw new BusinessError("validation_failed", "reason is required", 400);
    }
    const { reason } = body;

    const o = await loadOnlineOrder(id);

    if ((TERMINAL_STATUSES as readonly string[]).includes(o.status)) {
      throw new BusinessError(
        "conflict",
        `cannot cancel-refund from terminal status '${o.status}'`,
        409,
      );
    }

    const updated = await db.transaction(async (tx) => {
      // Re-read inside tx for concurrency safety.
      const [fresh] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
      if (!fresh) throw new BusinessError("not_found", "order not found", 404);

      // Compensating ledger entries if stock was already deducted (status=paid).
      if (fresh.status === "paid") {
        const items = await tx
          .select()
          .from(saleOrderItem)
          .where(eq(saleOrderItem.saleOrderId, id));
        for (const it of items) {
          await tx.insert(stockLedger).values({
            locationType: "branch",
            locationId: fresh.branchId,
            productId: it.productId,
            variantId: it.variantId ?? null,
            delta: it.quantity,
            sourceType: "sale_cancelled",
            sourceId: id,
            recordedByUserId: auth.userId,
            note: `Cancel+refund ${fresh.orderNumber}: ${reason}`,
          });
        }
      }

      // Delete the stock reservation (idempotent if already cleared by payment).
      await tx.delete(stockReservation).where(eq(stockReservation.saleOrderId, id));

      const [u] = await tx
        .update(saleOrder)
        .set({
          status: "cancelled",
          cancelReason: reason,
          cancelledByUserId: auth.userId,
          cancelledAt: new Date(),
          refundOwedNgn: fresh.totalNgn,
          updatedAt: new Date(),
        })
        .where(eq(saleOrder.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);

      // Emit outbox event so the worker can notify the owner about the refund.
      await tx.insert(outboxEvent).values({
        eventType: "sale.refund_owed",
        payload: {
          sale_order_id: id,
          order_number: fresh.orderNumber,
          refund_owed_ngn: fresh.totalNgn,
          cancel_reason: reason,
        },
      });

      return u;
    });

    await writeAudit(db, c, {
      action: "sale_order.cancel_refund",
      entityType: "sale_order",
      entityId: id,
      after: { orderNumber: o.orderNumber, reason, refundOwedNgn: updated.refundOwedNgn },
    });

    return c.json({
      data: { status: "cancelled", refund_owed_ngn: updated.refundOwedNgn },
    });
  });

  /**
   * POST /:id/mark-refunded
   * Owner-only: clear the refundOwedNgn flag once the business has physically
   * returned the money to the customer.
   */
  r.post("/:id/mark-refunded", requireCapability("orders.accept_payment"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);

    const o = await loadOnlineOrder(id);

    await db
      .update(saleOrder)
      .set({ refundOwedNgn: null, updatedAt: new Date() })
      .where(eq(saleOrder.id, id));

    await writeAudit(db, c, {
      action: "sale_order.mark_refunded",
      entityType: "sale_order",
      entityId: id,
      after: { orderNumber: o.orderNumber },
    });

    return c.json({ data: { ok: true } });
  });

  return r;
}

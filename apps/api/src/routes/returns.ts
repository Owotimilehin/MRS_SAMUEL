import { Hono } from "hono";
import { eq, and, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  saleReturn,
  saleReturnItem,
  saleOrder,
  saleOrderItem,
  payment,
  stockLedger,
  product,
  outboxEvent,
  customerCredit,
  type DbClient,
  type DbExecutor,
} from "@ms/db";
import {
  isWithinReturnWindow,
  shouldFlagForApproval,
  nextReturnNumber,
  nextOrderNumber,
  type ReturnReasonCategory,
} from "@ms/domain";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { enqueueOutbox } from "../lib/notify.js";

const ReasonEnum = z.enum([
  "changed_mind",
  "wrong_flavor",
  "wrong_item",
  "quality_issue",
  "damaged_on_arrival",
  "delivery_failed",
  "other_with_note",
]);

const RefundMethodEnum = z.enum([
  "cash",
  "card_reversal",
  "transfer",
  "store_credit",
  "replacement",
  "chowdeck_external",
  "none",
]);

const DispositionEnum = z.enum(["restocked", "wasted", "replaced"]);

const CreateReturn = z.object({
  original_sale_order_id: z.string().uuid(),
  reason_category: ReasonEnum,
  reason_note: z.string().optional(),
  refund_method: RefundMethodEnum,
  items: z
    .array(
      z.object({
        sale_order_item_id: z.string().uuid(),
        quantity_returned: z.number().int().positive(),
        disposition: DispositionEnum,
      }),
    )
    .min(1),
  owner_override_window: z.boolean().optional(),
  photo_urls: z.array(z.string().url()).default([]),
  notes: z.string().optional(),
});

export function returnRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireBranchScope());

  // ============ Create return ============
  r.post("/", requireCapability("returns.create"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const body = CreateReturn.parse(await c.req.json());
    const auth = c.get("auth");
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) {
      throw new BusinessError("validation_failed", "idempotency-key header required", 400);
    }

    const created = await db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(saleOrder)
        .where(eq(saleOrder.id, body.original_sale_order_id));
      if (!order) throw new BusinessError("not_found", "original sale not found", 404);
      if (order.branchId !== branchId) {
        throw new BusinessError("forbidden", "order belongs to another branch", 403);
      }
      if (!["paid", "handed_over", "delivered"].includes(order.status)) {
        throw new BusinessError("conflict", `cannot return from order status ${order.status}`, 409);
      }

      // Load referenced line items and products
      const items = await tx
        .select()
        .from(saleOrderItem)
        .where(eq(saleOrderItem.saleOrderId, order.id));
      const itemMap = new Map(items.map((i) => [i.id, i]));

      // Validate every referenced line belongs to this order
      for (const inp of body.items) {
        if (!itemMap.has(inp.sale_order_item_id)) {
          throw new BusinessError(
            "validation_failed",
            `unknown item ${inp.sale_order_item_id}`,
            422,
          );
        }
      }

      // Window check uses the min shelf life across the products being returned
      const productIds = body.items.map((i) => itemMap.get(i.sale_order_item_id)!.productId);
      const products = await tx
        .select()
        .from(product)
        .where(inArray(product.id, productIds));
      const minShelfLife = Math.min(...products.map((p) => p.shelfLifeHours));
      const windowCheck = isWithinReturnWindow({
        reasonCategory: body.reason_category as ReturnReasonCategory,
        saleCreatedAt: order.createdAtLocal,
        shelfLifeHours: minShelfLife,
        ownerOverride: !!body.owner_override_window,
      });
      if (!windowCheck.ok && auth.role !== "owner") {
        throw new BusinessError("forbidden", `return window expired: ${windowCheck.reason}`, 403);
      }

      // Per-line constraint: SUM(quantity_returned) so far + new <= quantity sold
      for (const inp of body.items) {
        const orig = itemMap.get(inp.sale_order_item_id)!;
        const rows = await tx.execute<{ already: number }>(sql`
          SELECT COALESCE(SUM(quantity_returned), 0)::int AS already
          FROM sale_return_item
          WHERE sale_order_item_id = ${inp.sale_order_item_id}
        `);
        const already = Number(rows[0]?.already ?? 0);
        if (orig.quantity - already < inp.quantity_returned) {
          throw new BusinessError("conflict", `over-returning item ${orig.id}`, 409, {
            remaining: orig.quantity - already,
            requested: inp.quantity_returned,
          });
        }
      }

      // Total refund
      const refundAmount = body.items.reduce((sum, i) => {
        const orig = itemMap.get(i.sale_order_item_id)!;
        return sum + orig.unitPriceNgn * i.quantity_returned;
      }, 0);

      // Auto-approval decision
      const hasWasted = body.items.some((i) => i.disposition === "wasted");
      const flagged = shouldFlagForApproval({
        reasonCategory: body.reason_category as ReturnReasonCategory,
        refundAmountNgn: refundAmount,
        hasWastedDisposition: hasWasted,
      });
      const status = flagged ? "pending_approval" : "completed";

      const returnNumber = await nextReturnNumber(tx);
      const [ret] = await tx
        .insert(saleReturn)
        .values({
          returnNumber,
          originalSaleOrderId: order.id,
          branchId,
          channel: order.channel,
          status,
          reasonCategory: body.reason_category,
          reasonNote: body.reason_note ?? null,
          refundMethod: body.refund_method,
          refundAmountNgn: refundAmount,
          createdByUserId: auth.userId,
          approvedByUserId: status === "completed" ? auth.userId : null,
          approvedAt: status === "completed" ? new Date() : null,
          idempotencyKey,
          notes: body.notes ?? null,
        })
        .returning();
      if (!ret) throw new BusinessError("internal_error", "return insert failed", 500);

      for (const inp of body.items) {
        const orig = itemMap.get(inp.sale_order_item_id)!;
        await tx.insert(saleReturnItem).values({
          saleReturnId: ret.id,
          saleOrderItemId: inp.sale_order_item_id,
          productId: orig.productId,
          quantityReturned: inp.quantity_returned,
          unitRefundNgn: orig.unitPriceNgn,
          disposition: inp.disposition,
          photoUrls: body.photo_urls,
        });
      }

      // If completed inline, apply effects now. Otherwise emit a review event;
      // owner's approve will apply effects later.
      if (status === "completed") {
        await applyReturnEffects(tx, ret.id, auth.userId);
      } else {
        await enqueueOutbox(tx, c, "sale_return.pending_approval", {
          sale_return_id: ret.id,
          return_number: ret.returnNumber,
          branch_id: branchId,
          refund_amount_ngn: refundAmount,
          reason: body.reason_category,
        });
      }

      return ret;
    });

    await writeAudit(db, c, {
      action: "sale_return.create",
      entityType: "sale_return",
      entityId: created.id,
      after: created,
    });
    return c.json({ data: created }, 201);
  });

  // ============ Approve (owner) ============
  r.patch("/:id/approve", requireCapability("returns.approve"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const auth = c.get("auth");

    const updated = await db.transaction(async (tx) => {
      const [ret] = await tx.select().from(saleReturn).where(eq(saleReturn.id, id));
      if (!ret) throw new BusinessError("not_found", "return not found", 404);
      if (ret.status !== "pending_approval") {
        throw new BusinessError("conflict", `cannot approve from ${ret.status}`, 409);
      }
      const [u] = await tx
        .update(saleReturn)
        .set({
          status: "completed",
          approvedByUserId: auth.userId,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(saleReturn.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update failed", 500);
      await applyReturnEffects(tx, id, auth.userId);
      return u;
    });

    await writeAudit(db, c, {
      action: "sale_return.approve",
      entityType: "sale_return",
      entityId: id,
      after: updated,
    });
    return c.json({ data: updated });
  });

  // ============ Cancel (draft/pending only) ============
  r.patch("/:id/cancel", requireCapability("returns.create"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);

    const updated = await db.transaction(async (tx) => {
      const [ret] = await tx.select().from(saleReturn).where(eq(saleReturn.id, id));
      if (!ret) throw new BusinessError("not_found", "return not found", 404);
      if (ret.status !== "draft" && ret.status !== "pending_approval") {
        throw new BusinessError("conflict", `cannot cancel from ${ret.status}`, 409);
      }
      const [u] = await tx
        .update(saleReturn)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(saleReturn.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update failed", 500);
      return u;
    });
    return c.json({ data: updated });
  });

  // ============ List / detail ============
  r.get("/", requireCapability("sales.view"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const rows = await db
      .select({ ret: saleReturn, originalSaleOrderNumber: saleOrder.orderNumber })
      .from(saleReturn)
      .leftJoin(saleOrder, eq(saleOrder.id, saleReturn.originalSaleOrderId))
      .where(eq(saleReturn.branchId, branchId));
    return c.json({
      data: rows.map((r) => ({
        ...r.ret,
        originalSaleOrderNumber: r.originalSaleOrderNumber,
      })),
    });
  });

  r.get("/:id", requireCapability("sales.view"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const [row] = await db
      .select({ ret: saleReturn, originalSaleOrderNumber: saleOrder.orderNumber })
      .from(saleReturn)
      .leftJoin(saleOrder, eq(saleOrder.id, saleReturn.originalSaleOrderId))
      .where(eq(saleReturn.id, id));
    if (!row) throw new BusinessError("not_found", "return not found", 404);
    const items = await db
      .select()
      .from(saleReturnItem)
      .where(eq(saleReturnItem.saleReturnId, id));
    return c.json({
      data: { ...row.ret, originalSaleOrderNumber: row.originalSaleOrderNumber, items },
    });
  });

  return r;
}

/**
 * Apply the ledger + refund + replacement effects of a completed return.
 * Called either inline when auto-completed, or from the owner-approve path.
 * Caller must already hold a transaction.
 */
async function applyReturnEffects(
  tx: DbExecutor,
  returnId: string,
  userId: string,
): Promise<void> {
  const [ret] = await tx.select().from(saleReturn).where(eq(saleReturn.id, returnId));
  if (!ret) return;
  const items = await tx
    .select()
    .from(saleReturnItem)
    .where(eq(saleReturnItem.saleReturnId, returnId));

  // The sale deducted stock from a specific size (variant) bucket, but
  // sale_return_item only stores the product. Resolve each line's variant from
  // its original sale_order_item so the restock/waste rows land in the SAME
  // bucket — otherwise the credit falls into the legacy no-size (NULL) bucket
  // and the per-size grid stays skewed even though the flavour total nets out.
  const origItemIds = items.map((i) => i.saleOrderItemId);
  const origItems =
    origItemIds.length > 0
      ? await tx.select().from(saleOrderItem).where(inArray(saleOrderItem.id, origItemIds))
      : [];
  const variantByOrderItemId = new Map(origItems.map((oi) => [oi.id, oi.variantId ?? null]));

  // Ledger effects per disposition
  for (const it of items) {
    const variantId = variantByOrderItemId.get(it.saleOrderItemId) ?? null;
    if (it.disposition === "restocked" || it.disposition === "replaced") {
      await tx.insert(stockLedger).values({
        locationType: "branch",
        locationId: ret.branchId,
        productId: it.productId,
        variantId,
        delta: it.quantityReturned,
        sourceType: "return_restock",
        sourceId: returnId,
        recordedByUserId: userId,
        note: `Return ${ret.returnNumber}`,
      });
    }
    if (it.disposition === "wasted") {
      // Two-row honest ledger: bottle came back AND was poured out.
      await tx.insert(stockLedger).values({
        locationType: "branch",
        locationId: ret.branchId,
        productId: it.productId,
        variantId,
        delta: it.quantityReturned,
        sourceType: "return_restock",
        sourceId: returnId,
        recordedByUserId: userId,
        note: `Return ${ret.returnNumber} (wasted in)`,
      });
      await tx.insert(stockLedger).values({
        locationType: "branch",
        locationId: ret.branchId,
        productId: it.productId,
        variantId,
        delta: -it.quantityReturned,
        sourceType: "waste",
        sourceId: returnId,
        recordedByUserId: userId,
        note: `Waste ${ret.returnNumber}`,
      });
    }
  }

  // Refund execution by method
  if (ret.refundMethod === "card_reversal") {
    const [origOrder] = await tx
      .select()
      .from(saleOrder)
      .where(eq(saleOrder.id, ret.originalSaleOrderId));
    if (origOrder) {
      const [pay] = await tx
        .select()
        .from(payment)
        .where(and(eq(payment.saleOrderId, origOrder.id), eq(payment.method, "card")));
      if (pay) {
        await tx.insert(outboxEvent).values({
          eventType: "payment.refund_request",
          payload: {
            sale_return_id: returnId,
            payment_id: pay.id,
            processor: pay.processor,
            processor_reference: pay.processorReference,
            amount_ngn: ret.refundAmountNgn,
          },
        });
      }
    }
  } else if (ret.refundMethod === "store_credit") {
    const [origOrder] = await tx
      .select()
      .from(saleOrder)
      .where(eq(saleOrder.id, ret.originalSaleOrderId));
    if (origOrder?.customerId) {
      await tx.insert(customerCredit).values({
        customerId: origOrder.customerId,
        amountNgn: ret.refundAmountNgn,
        source: `return:${returnId}`,
      });
    }
  } else if (ret.refundMethod === "replacement") {
    const replacedLines = items.filter((i) => i.disposition === "replaced");
    if (replacedLines.length > 0) {
      const [origOrder] = await tx
        .select()
        .from(saleOrder)
        .where(eq(saleOrder.id, ret.originalSaleOrderId));
      if (origOrder) {
        const orderNumber = await nextOrderNumber(tx);
        const [free] = await tx
          .insert(saleOrder)
          .values({
            orderNumber,
            branchId: ret.branchId,
            channel: origOrder.channel,
            customerId: origOrder.customerId,
            status: "paid",
            subtotalNgn: 0,
            deliveryFeeNgn: 0,
            totalNgn: 0,
            paymentMethod: "replacement",
            paymentStatus: "paid",
            createdAtLocal: new Date(),
            idempotencyKey: crypto.randomUUID(),
            notes: `Replacement for return ${ret.returnNumber}`,
          })
          .returning();
        if (free) {
          for (const it of replacedLines) {
            const [origItem] = await tx
              .select()
              .from(saleOrderItem)
              .where(eq(saleOrderItem.id, it.saleOrderItemId));
            if (!origItem) continue;
            await tx.insert(saleOrderItem).values({
              saleOrderId: free.id,
              productId: it.productId,
              productPriceId: origItem.productPriceId,
              quantity: it.quantityReturned,
              unitPriceNgn: 0,
              lineTotalNgn: 0,
            });
            // Outbound ledger so the replacement bottles leave inventory too —
            // from the same size bucket as the original line.
            await tx.insert(stockLedger).values({
              locationType: "branch",
              locationId: ret.branchId,
              productId: it.productId,
              variantId: origItem.variantId ?? null,
              delta: -it.quantityReturned,
              sourceType: "sale",
              sourceId: free.id,
              recordedByUserId: userId,
              note: `Replacement ${free.orderNumber}`,
            });
          }
        }
      }
    }
  }
  // cash, transfer, none, chowdeck_external: no extra ledger writes
}

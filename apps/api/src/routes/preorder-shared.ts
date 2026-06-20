import type { Context } from "hono";
import { eq, and, desc, isNull } from "drizzle-orm";
import {
  saleOrder,
  saleOrderItem,
  stockLedger,
  outboxEvent,
  customer,
  product,
  productVariant,
  type DbClient,
} from "@ms/db";
import { availableAtBranch } from "@ms/domain";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { autoDispatchEnabled } from "../lib/delivery-flags.js";

const COUNTER_CHANNELS = new Set(["walkup", "whatsapp", "chowdeck_pickup"]);

/** Open (paid, unfulfilled) preorders with line items, optionally branch-locked. */
export async function listOpenPreorders(
  db: DbClient,
  opts: { branchId?: string } = {},
): Promise<unknown[]> {
  const conds = [
    eq(saleOrder.isPreorder, true),
    eq(saleOrder.status, "paid"),
    isNull(saleOrder.fulfilledAt),
  ];
  if (opts.branchId) conds.push(eq(saleOrder.branchId, opts.branchId));

  const orders = await db
    .select({
      id: saleOrder.id,
      order_number: saleOrder.orderNumber,
      branch_id: saleOrder.branchId,
      channel: saleOrder.channel,
      status: saleOrder.status,
      total_ngn: saleOrder.totalNgn,
      scheduled_delivery_at: saleOrder.scheduledDeliveryAt,
      created_at_local: saleOrder.createdAtLocal,
      customer_name: customer.name,
      customer_phone: customer.phone,
    })
    .from(saleOrder)
    .leftJoin(customer, eq(customer.id, saleOrder.customerId))
    .where(and(...conds))
    .orderBy(desc(saleOrder.createdAtLocal))
    .limit(200);

  const out: unknown[] = [];
  for (const o of orders) {
    const items = await db
      .select({
        product_id: saleOrderItem.productId,
        variant_id: saleOrderItem.variantId,
        name: product.name,
        size_ml: productVariant.sizeMl,
        quantity: saleOrderItem.quantity,
        unit_price_ngn: saleOrderItem.unitPriceNgn,
      })
      .from(saleOrderItem)
      .leftJoin(product, eq(product.id, saleOrderItem.productId))
      .leftJoin(productVariant, eq(productVariant.id, saleOrderItem.variantId))
      .where(eq(saleOrderItem.saleOrderId, o.id));
    out.push({ ...o, items });
  }
  return out;
}

/**
 * Fulfil a preorder: deduct stock now, hand the order onward. When `branchId`
 * is given, the order must belong to that branch (else 404) — this is how the
 * till is locked to its own queue.
 */
export async function fulfilPreorderTx(
  db: DbClient,
  c: Context,
  opts: { id: string; branchId?: string },
): Promise<Record<string, unknown>> {
  const { id } = opts;
  const auth = c.get("auth");

  const result = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
    if (!o) throw new BusinessError("not_found", "preorder not found", 404);
    if (opts.branchId && o.branchId !== opts.branchId) {
      throw new BusinessError("not_found", "preorder not found", 404);
    }
    if (!o.isPreorder) throw new BusinessError("conflict", "order is not a preorder", 409);
    if (o.fulfilledAt) throw new BusinessError("conflict", "preorder already fulfilled", 409);
    if (o.status !== "paid") throw new BusinessError("conflict", `cannot fulfil from ${o.status}`, 409);

    const items = await tx.select().from(saleOrderItem).where(eq(saleOrderItem.saleOrderId, id));

    const wantByProduct = new Map<string, number>();
    for (const it of items) {
      wantByProduct.set(it.productId, (wantByProduct.get(it.productId) ?? 0) + it.quantity);
    }
    const shortfalls: Array<{ product_id: string; needed: number; available: number }> = [];
    for (const [productId, needed] of wantByProduct) {
      const available = await availableAtBranch(tx, { branchId: o.branchId, productId });
      if (available < needed) shortfalls.push({ product_id: productId, needed, available });
    }
    if (shortfalls.length > 0) {
      throw new BusinessError("conflict", "not enough stock to fulfil this preorder", 422, {
        code: "preorder_unfulfillable",
        shortfalls,
      });
    }

    for (const it of items) {
      await tx.insert(stockLedger).values({
        locationType: "branch",
        locationId: o.branchId,
        productId: it.productId,
        variantId: it.variantId ?? null,
        delta: -it.quantity,
        sourceType: "sale",
        sourceId: id,
        recordedByUserId: auth.userId,
        note: `Preorder fulfil ${o.orderNumber}`,
      });
    }

    const toCounter = COUNTER_CHANNELS.has(o.channel);
    const [u] = await tx
      .update(saleOrder)
      .set({
        status: toCounter ? "handed_over" : o.status,
        fulfilledAt: new Date(),
        fulfilledByUserId: auth.userId,
        updatedAt: new Date(),
      })
      .where(eq(saleOrder.id, id))
      .returning();
    if (!u) throw new BusinessError("internal_error", "fulfil update returned no rows", 500);

    if (!toCounter && autoDispatchEnabled()) {
      await tx.insert(outboxEvent).values({
        eventType: "delivery.request",
        payload: { sale_order_id: id, order_number: o.orderNumber, branch_id: o.branchId },
      });
    }
    // Gather flavour + size names for the notification line items.
    const notifItemRows = await tx
      .select({
        qty: saleOrderItem.quantity,
        lineTotal: saleOrderItem.lineTotalNgn,
        name: product.name,
        sizeMl: productVariant.sizeMl,
      })
      .from(saleOrderItem)
      .leftJoin(product, eq(product.id, saleOrderItem.productId))
      .leftJoin(productVariant, eq(productVariant.id, saleOrderItem.variantId))
      .where(eq(saleOrderItem.saleOrderId, id));
    const notifItems = notifItemRows.map((r) => ({
      name: r.name ?? "Item",
      size: r.sizeMl ? `${r.sizeMl}ml` : "",
      qty: r.qty,
      line_total_ngn: r.lineTotal,
    }));
    await tx.insert(outboxEvent).values({
      eventType: "sale.preorder_fulfilled",
      payload: {
        sale_order_id: id,
        order_number: o.orderNumber,
        branch_id: o.branchId,
        channel: o.channel,
        items: notifItems,
      },
    });
    return u;
  });

  await writeAudit(db, c, {
    action: "preorder.fulfil",
    entityType: "sale_order",
    entityId: id,
    after: result,
  });
  return result;
}

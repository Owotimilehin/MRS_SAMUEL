import { Hono } from "hono";
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
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

// Channels handed straight to the customer at the counter on fulfilment vs.
// channels that still go through the delivery pipeline afterwards.
const COUNTER_CHANNELS = new Set(["walkup", "whatsapp", "chowdeck_pickup"]);

export function preorderRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  // ============ Queue: paid preorders awaiting fulfilment ============
  r.get("/", requireCapability("orders.manage"), async (c) => {
    const branchId = c.req.query("branch_id");
    const conds = [
      eq(saleOrder.isPreorder, true),
      eq(saleOrder.status, "paid"),
      isNull(saleOrder.fulfilledAt),
    ];
    if (branchId) conds.push(eq(saleOrder.branchId, branchId));

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

    // Attach line items (with flavour name + size) per order.
    const out = [];
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
    return c.json({ data: out });
  });

  // ============ Fulfil: deduct stock NOW, move the order onward ============
  r.patch("/:id/fulfil", requireCapability("orders.manage"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const auth = c.get("auth");

    const result = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
      if (!o) throw new BusinessError("not_found", "preorder not found", 404);
      if (!o.isPreorder) throw new BusinessError("conflict", "order is not a preorder", 409);
      if (o.fulfilledAt) throw new BusinessError("conflict", "preorder already fulfilled", 409);
      if (o.status !== "paid") {
        throw new BusinessError("conflict", `cannot fulfil from ${o.status}`, 409);
      }

      const items = await tx
        .select()
        .from(saleOrderItem)
        .where(eq(saleOrderItem.saleOrderId, id));

      // Aggregate demand per flavour (stock is per-flavour) and check the branch
      // can actually cover it now. Gather every shortfall so the cashier sees
      // the full picture rather than one-at-a-time.
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
        throw new BusinessError(
          "conflict",
          "not enough stock to fulfil this preorder",
          422,
          { code: "preorder_unfulfillable", shortfalls },
        );
      }

      // Post the deferred stock deduction now (this is the sale finally moving
      // physical stock — the payment captured it earlier without touching stock).
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

      // Counter channels are handed over on the spot; delivery channels rejoin
      // the dispatch pipeline so the existing Bolt/Shipbubble flow takes over.
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

      if (!toCounter) {
        await tx.insert(outboxEvent).values({
          eventType: "delivery.request",
          payload: { sale_order_id: id, order_number: o.orderNumber, branch_id: o.branchId },
        });
      }
      await tx.insert(outboxEvent).values({
        eventType: "sale.preorder_fulfilled",
        payload: {
          sale_order_id: id,
          order_number: o.orderNumber,
          branch_id: o.branchId,
          channel: o.channel,
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
    return c.json({ data: result });
  });

  return r;
}

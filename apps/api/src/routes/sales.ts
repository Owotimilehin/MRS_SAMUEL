import { Hono } from "hono";
import { eq, and, desc, asc, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  saleOrder,
  saleOrderItem,
  saleOrderPackaging,
  packagingStockLedger,
  packagingMaterial,
  payment,
  stockReservation,
  stockLedger,
  productPrice,
  productVariant,
  outboxEvent,
  type DbClient,
} from "@ms/db";
import { availableAtBranch, nextOrderNumber } from "@ms/domain";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { resolveCustomer } from "../lib/customers.js";

const ConfirmSale = z.object({
  // Optional client-supplied UUID. The branch PWA generates this offline so the
  // local reference and the eventual server row stay linked across sync retries.
  id: z.string().uuid().optional(),
  channel: z.enum(["walkup", "online", "phone", "whatsapp", "chowdeck_pickup"]),
  items: z
    .array(
      z
        .object({
          // Preferred: pin the exact can size being purchased.
          variant_id: z.string().uuid().optional(),
          // Legacy: product-level reference. Resolves to the smallest variant.
          product_id: z.string().uuid().optional(),
          quantity: z.number().int().positive(),
        })
        .refine((v) => v.variant_id != null || v.product_id != null, {
          message: "each item needs variant_id or product_id",
        }),
    )
    .min(1),
  payment_method: z.enum([
    "cash",
    "card",
    "transfer",
    "chowdeck_external",
  ]),
  customer: z
    .object({
      name: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      default_address: z.string().optional(),
    })
    .nullable()
    .optional(),
  external_reference: z.string().optional(),
  notes: z.string().optional(),
  delivery_fee_ngn: z.number().int().nonnegative().default(0),
  created_at_local: z.string().datetime(),
  // Target fulfilment day for a preorder taken at the till — the day staff will
  // make it, fulfil it from the queue, and deduct stock.
  scheduled_delivery_at: z.string().datetime().optional(),
  // Explicit "take this as a preorder" from the till — forces the whole order
  // to a prepaid preorder regardless of size/stock/channel (the cashier chose
  // it in the cashout section). Stock is NOT consumed now; it waits in the
  // Preorders queue. Requires scheduled_delivery_at. This is IN ADDITION to the
  // automatic triggers (a preorder_only size like 330ml, or a remote-channel
  // short line), which still apply when this is absent/false.
  is_preorder: z.boolean().optional(),
  // Optional bags handed to the customer. Tracked-only: recorded against the
  // sale and decremented from branch bag stock at pay, but never blocks a sale.
  packaging: z
    .array(
      z.object({
        packaging_material_id: z.string().uuid(),
        quantity: z.number().int().positive(),
      }),
    )
    .optional(),
});

const CancelBody = z.object({
  reason: z.enum([
    "customer_changed_mind",
    "out_of_stock_realized_late",
    "payment_failed_persistently",
    "rider_unavailable",
    "duplicate_order",
    "other_with_note",
  ]),
});

const RESERVATION_TIMEOUT_MS: Record<string, number> = {
  walkup: 5 * 60_000,
  whatsapp: 30 * 60_000,
  chowdeck_pickup: 30 * 60_000,
  phone: 30 * 60_000,
  online: 30 * 60_000,
};

export function saleRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireBranchScope());

  // ============ Bag stock for the POS (pos.sell — branch staff have no packaging.view) ============
  // Lists active bag materials with this branch's on-hand count so the till can
  // show "Bags on hand" without granting the cashier the packaging admin views.
  r.get("/bags", requireCapability("pos.sell"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const balances = await db.execute<{ packaging_material_id: string; balance: number }>(sql`
      SELECT packaging_material_id, COALESCE(SUM(delta), 0)::int AS balance
      FROM packaging_stock_ledger
      WHERE location_type = 'branch' AND location_id = ${branchId}::uuid
      GROUP BY packaging_material_id
    `);
    const byId = new Map(balances.map((b) => [b.packaging_material_id, Number(b.balance)]));
    const bags = await db
      .select()
      .from(packagingMaterial)
      .where(and(eq(packagingMaterial.kind, "bag"), eq(packagingMaterial.isActive, true)));
    return c.json({
      data: bags.map((m) => ({ material_id: m.id, name: m.name, balance: byId.get(m.id) ?? 0 })),
    });
  });

  // ============ Confirm (creates DRAFT→CONFIRMED with stock reservation) ============
  r.post("/", requireCapability("pos.sell"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const body = ConfirmSale.parse(await c.req.json());
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) {
      throw new BusinessError("validation_failed", "idempotency-key header required", 400);
    }
    const auth = c.get("auth");

    const created = await db.transaction(async (tx) => {
      // Resolve or create the customer by phone (shared identity rule). Returns
      // null for a fully anonymous walk-up (no name and no phone).
      const customerId = await resolveCustomer(tx, {
        name: body.customer?.name ?? null,
        phone: body.customer?.phone ?? null,
        email: body.customer?.email ?? null,
        defaultAddress: body.customer?.default_address ?? null,
        source:
          body.channel === "walkup"
            ? "walkup_anonymous"
            : body.channel === "online"
              ? "online"
              : body.channel === "phone"
                ? "phone"
                : body.channel === "whatsapp"
                  ? "whatsapp"
                  : "chowdeck",
      });

      // Snapshot current price + check stock per line
      let subtotal = 0;
      // The cashier can deliberately take ANY order as a preorder from the till
      // (forcePreorder) — this needs a fulfilment day and skips the walk-up
      // out-of-stock guard below. On top of that, any preorder_only or
      // out-of-stock line still auto-flips the order to a preorder: skip
      // reservations now, defer the stock deduction to fulfilment.
      const forcePreorder = body.is_preorder === true;
      if (forcePreorder && !body.scheduled_delivery_at) {
        throw new BusinessError(
          "validation_failed",
          "scheduled_delivery_at is required for a preorder",
          422,
        );
      }
      let orderIsPreorder = forcePreorder;
      const lines: {
        productId: string;
        variantId: string;
        priceId: string;
        quantity: number;
        unitPriceNgn: number;
      }[] = [];

      for (const it of body.items) {
        // Resolve to a concrete variant (explicit variant_id wins; legacy
        // callers can still send product_id which maps to the smallest can).
        let variantId: string | undefined = it.variant_id;
        let productId: string;
        let preorderOnly = false;
        if (variantId) {
          const [v] = await tx
            .select()
            .from(productVariant)
            .where(and(eq(productVariant.id, variantId), isNull(productVariant.deletedAt)));
          if (!v) {
            throw new BusinessError("not_found", `variant ${variantId} not found`, 404);
          }
          productId = v.productId;
          preorderOnly = v.preorderOnly;
          if (it.product_id && it.product_id !== v.productId) {
            throw new BusinessError(
              "validation_failed",
              "variant_id does not belong to product_id",
              422,
            );
          }
        } else {
          productId = it.product_id!;
          const [v] = await tx
            .select()
            .from(productVariant)
            .where(
              and(eq(productVariant.productId, productId), isNull(productVariant.deletedAt)),
            )
            .orderBy(asc(productVariant.sizeMl))
            .limit(1);
          if (!v) {
            throw new BusinessError("not_found", `no variant for product ${productId}`, 404);
          }
          variantId = v.id;
          preorderOnly = v.preorderOnly;
        }

        const [price] = await tx
          .select()
          .from(productPrice)
          .where(and(eq(productPrice.variantId, variantId), isNull(productPrice.validTo)))
          .orderBy(desc(productPrice.validFrom))
          .limit(1);
        if (!price) {
          throw new BusinessError("not_found", `no price for variant ${variantId}`, 404);
        }
        const available = await availableAtBranch(tx, {
          branchId,
          productId,
        });
        // A preorder_only item is always made-to-order (any channel). For a
        // normal item that's short, only REMOTE channels (phone/whatsapp/online,
        // fulfilled later) become a preorder — immediate-handover channels
        // (walk-up, chowdeck pickup) can't hand over absent stock, so they're
        // still rejected to protect inventory integrity at the counter.
        const immediateHandover =
          body.channel === "walkup" || body.channel === "chowdeck_pickup";
        if (preorderOnly) {
          orderIsPreorder = true;
        } else if (available < it.quantity) {
          // A deliberate till preorder (forcePreorder) is allowed to be short —
          // it's made to order. Otherwise an immediate-handover channel can't
          // give away absent stock, so it's still rejected.
          if (immediateHandover && !forcePreorder) {
            throw new BusinessError("conflict", "insufficient stock", 422, {
              product_id: productId,
              variant_id: variantId,
              available,
              requested: it.quantity,
            });
          }
          orderIsPreorder = true;
        }
        lines.push({
          productId,
          variantId,
          priceId: price.id,
          quantity: it.quantity,
          unitPriceNgn: price.priceNgn,
        });
        subtotal += price.priceNgn * it.quantity;
      }

      const total = subtotal + body.delivery_fee_ngn;
      const orderNumber = await nextOrderNumber(tx);

      const insertValues = {
        ...(body.id ? { id: body.id } : {}),
        orderNumber,
        branchId,
        channel: body.channel,
        customerId,
        status: "confirmed" as const,
        isPreorder: orderIsPreorder,
        // The fulfilment day only makes sense for a preorder; ignore it otherwise.
        scheduledDeliveryAt:
          orderIsPreorder && body.scheduled_delivery_at
            ? new Date(body.scheduled_delivery_at)
            : null,
        subtotalNgn: subtotal,
        deliveryFeeNgn: body.delivery_fee_ngn,
        totalNgn: total,
        paymentMethod: body.payment_method,
        createdAtLocal: new Date(body.created_at_local),
        createdByUserId: auth.userId,
        idempotencyKey,
        externalReference: body.external_reference ?? null,
        notes: body.notes ?? null,
      };
      const [order] = await tx.insert(saleOrder).values(insertValues).returning();
      if (!order) throw new BusinessError("internal_error", "insert returned no rows", 500);

      const expiresAt = new Date(
        Date.now() + (RESERVATION_TIMEOUT_MS[body.channel] ?? 5 * 60_000),
      );
      for (const l of lines) {
        await tx.insert(saleOrderItem).values({
          saleOrderId: order.id,
          productId: l.productId,
          variantId: l.variantId,
          productPriceId: l.priceId,
          quantity: l.quantity,
          unitPriceNgn: l.unitPriceNgn,
          lineTotalNgn: l.unitPriceNgn * l.quantity,
        });
        // Preorders deduct at fulfilment, so there's nothing to reserve now.
        if (!orderIsPreorder) {
          await tx.insert(stockReservation).values({
            saleOrderId: order.id,
            branchId,
            productId: l.productId,
            variantId: l.variantId,
            quantity: l.quantity,
            expiresAt,
          });
        }
      }

      // Record any bags handed out (tracked-only). The branch bag stock is
      // decremented later at /pay, alongside the juice deduction.
      for (const pkg of body.packaging ?? []) {
        await tx.insert(saleOrderPackaging).values({
          saleOrderId: order.id,
          packagingMaterialId: pkg.packaging_material_id,
          quantity: pkg.quantity,
        });
      }
      return order;
    });

    await writeAudit(db, c, {
      action: "sale.confirm",
      entityType: "sale_order",
      entityId: created.id,
      after: created,
    });
    return c.json({ data: created }, 201);
  });

  // ============ Pay (CONFIRMED→PAID, converts reservation to ledger) ============
  r.patch("/:id/pay", requireCapability("pos.sell"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const auth = c.get("auth");

    const updated = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
      if (!o) throw new BusinessError("not_found", "sale not found", 404);
      if (o.status !== "confirmed") {
        throw new BusinessError("conflict", `cannot pay from ${o.status}`, 409);
      }
      if (o.channel === "online") {
        throw new BusinessError("forbidden", "online sales pay via webhook", 403);
      }

      // A preorder is prepaid but NOT yet made — payment must not move stock.
      // The deduction is deferred to the Preorders queue fulfilment step. A
      // normal sale deducts stock and clears its reservation right here.
      if (!o.isPreorder) {
        const items = await tx
          .select()
          .from(saleOrderItem)
          .where(eq(saleOrderItem.saleOrderId, id));
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
            note: `Sale ${o.orderNumber}`,
          });
        }
        await tx.delete(stockReservation).where(eq(stockReservation.saleOrderId, id));

        // Decrement branch bag stock for any bags on this sale (tracked-only,
        // warn-but-allow — the branch packaging ledger may go negative).
        const bags = await tx
          .select()
          .from(saleOrderPackaging)
          .where(eq(saleOrderPackaging.saleOrderId, id));
        for (const b of bags) {
          await tx.insert(packagingStockLedger).values({
            locationType: "branch",
            locationId: o.branchId,
            packagingMaterialId: b.packagingMaterialId,
            delta: -b.quantity,
            sourceType: "consumption",
            sourceId: id,
            recordedByUserId: auth.userId,
            note: `Bag on sale ${o.orderNumber}`,
          });
        }
      }
      await tx.insert(payment).values({
        saleOrderId: id,
        method: o.paymentMethod,
        amountNgn: o.totalNgn,
        status: "paid",
        paidAt: new Date(),
        collectedByUserId: auth.userId,
      });

      const [u] = await tx
        .update(saleOrder)
        .set({ status: "paid", paymentStatus: "paid", updatedAt: new Date() })
        .where(eq(saleOrder.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);
      // Branch sale completed — owner wants to see this.
      await tx.insert(outboxEvent).values({
        eventType: "sale.branch_sold",
        payload: {
          sale_order_id: u.id,
          order_number: u.orderNumber,
          total_ngn: u.totalNgn,
          channel: u.channel,
        },
      });
      return u;
    });

    await writeAudit(db, c, {
      action: "sale.pay",
      entityType: "sale_order",
      entityId: id,
      after: updated,
    });
    return c.json({ data: updated });
  });

  // ============ Hand over (PAID→HANDED_OVER for walkup/whatsapp/chowdeck) ============
  r.patch("/:id/hand-over", requireCapability("pos.sell"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const updated = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
      if (!o) throw new BusinessError("not_found", "sale not found", 404);
      if (o.status !== "paid") {
        throw new BusinessError("conflict", `cannot hand over from ${o.status}`, 409);
      }
      if (!["walkup", "whatsapp", "chowdeck_pickup"].includes(o.channel)) {
        throw new BusinessError("conflict", `wrong channel: ${o.channel}`, 409);
      }
      const [u] = await tx
        .update(saleOrder)
        .set({ status: "handed_over", updatedAt: new Date() })
        .where(eq(saleOrder.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);
      return u;
    });
    await writeAudit(db, c, {
      action: "sale.hand_over",
      entityType: "sale_order",
      entityId: id,
      after: updated,
    });
    return c.json({ data: updated });
  });

  // ============ Mark delivered (PAID→DELIVERED for online/phone) ============
  r.patch("/:id/mark-delivered", requireCapability("pos.sell"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const updated = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
      if (!o) throw new BusinessError("not_found", "sale not found", 404);
      if (o.status !== "paid") {
        throw new BusinessError("conflict", `cannot deliver from ${o.status}`, 409);
      }
      if (!["online", "phone"].includes(o.channel)) {
        throw new BusinessError("conflict", `wrong channel: ${o.channel}`, 409);
      }
      const [u] = await tx
        .update(saleOrder)
        .set({ status: "delivered", updatedAt: new Date() })
        .where(eq(saleOrder.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);
      return u;
    });
    await writeAudit(db, c, {
      action: "sale.mark_delivered",
      entityType: "sale_order",
      entityId: id,
      after: updated,
    });
    return c.json({ data: updated });
  });

  // ============ Cancel (any non-terminal→CANCELLED) ============
  r.patch("/:id/cancel", requireCapability("pos.sell"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const auth = c.get("auth");
    const { reason } = CancelBody.parse(await c.req.json());

    const updated = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
      if (!o) throw new BusinessError("not_found", "sale not found", 404);
      if (["handed_over", "delivered", "cancelled", "failed"].includes(o.status)) {
        throw new BusinessError("conflict", `cannot cancel from ${o.status}`, 409);
      }

      // Compensating ledger if already paid
      if (o.status === "paid") {
        const items = await tx
          .select()
          .from(saleOrderItem)
          .where(eq(saleOrderItem.saleOrderId, id));
        for (const it of items) {
          await tx.insert(stockLedger).values({
            locationType: "branch",
            locationId: o.branchId,
            productId: it.productId,
            delta: it.quantity,
            sourceType: "sale_cancelled",
            sourceId: id,
            recordedByUserId: auth.userId,
            note: `Cancel ${o.orderNumber}: ${reason}`,
          });
        }
      }
      await tx.delete(stockReservation).where(eq(stockReservation.saleOrderId, id));

      const [u] = await tx
        .update(saleOrder)
        .set({
          status: "cancelled",
          cancelReason: reason,
          cancelledByUserId: auth.userId,
          cancelledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(saleOrder.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);
      return u;
    });
    await writeAudit(db, c, {
      action: "sale.cancel",
      entityType: "sale_order",
      entityId: id,
      after: updated,
    });
    return c.json({ data: updated });
  });

  // ============ List / Get (read-only) ============
  r.get("/", requireCapability("sales.view"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const rows = await db
      .select()
      .from(saleOrder)
      .where(eq(saleOrder.branchId, branchId))
      .orderBy(desc(saleOrder.createdAtLocal))
      .limit(200);
    return c.json({ data: rows });
  });

  r.get("/:id", requireCapability("sales.view"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const [o] = await db.select().from(saleOrder).where(eq(saleOrder.id, id));
    if (!o) throw new BusinessError("not_found", "sale not found", 404);
    const items = await db
      .select()
      .from(saleOrderItem)
      .where(eq(saleOrderItem.saleOrderId, id));
    // Latest delivery_order if any (single source of truth for rider info).
    const { deliveryOrder } = await import("@ms/db");
    const { desc: descFn } = await import("drizzle-orm");
    const [delivery] = await db
      .select()
      .from(deliveryOrder)
      .where(eq(deliveryOrder.saleOrderId, id))
      .orderBy(descFn(deliveryOrder.requestedAt))
      .limit(1);
    return c.json({ data: { ...o, items, delivery: delivery ?? null } });
  });

  return r;
}

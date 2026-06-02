import { Hono } from "hono";
import { eq, and, desc, asc, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  saleOrder,
  saleOrderItem,
  payment,
  stockReservation,
  stockLedger,
  productPrice,
  productVariant,
  customer,
  outboxEvent,
  type DbClient,
} from "@ms/db";
import { availableAtBranch, nextOrderNumber } from "@ms/domain";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";

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
      // Resolve or create customer if we have any details
      let customerId: string | null = null;
      if (body.customer && (body.customer.name || body.customer.phone)) {
        const [cust] = await tx
          .insert(customer)
          .values({
            name: body.customer.name ?? null,
            phone: body.customer.phone ?? null,
            email: body.customer.email ?? null,
            defaultAddress: body.customer.default_address ?? null,
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
          })
          .returning();
        customerId = cust?.id ?? null;
      }

      // Snapshot current price + check stock per line
      let subtotal = 0;
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
        if (variantId) {
          const [v] = await tx
            .select()
            .from(productVariant)
            .where(and(eq(productVariant.id, variantId), isNull(productVariant.deletedAt)));
          if (!v) {
            throw new BusinessError("not_found", `variant ${variantId} not found`, 404);
          }
          productId = v.productId;
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
        if (available < it.quantity) {
          throw new BusinessError("conflict", "insufficient stock", 422, {
            product_id: productId,
            variant_id: variantId,
            available,
            requested: it.quantity,
          });
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
        await tx.insert(stockReservation).values({
          saleOrderId: order.id,
          branchId,
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
          expiresAt,
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

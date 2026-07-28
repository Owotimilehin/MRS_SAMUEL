import { Hono } from "hono";
import { eq, and, desc, asc, isNull, inArray, notInArray, sql } from "drizzle-orm";
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
  product,
  shiftOpen,
  customer,
  deliveryOrder,
  type DbClient,
} from "@ms/db";
import { availableAtBranch, nextOrderNumber } from "@ms/domain";
import { requireAuth, requireCapability, requireAnyCapability } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { writeAudit } from "../middleware/audit.js";
import { BusinessError } from "../lib/errors.js";
import { resolveCustomer } from "../lib/customers.js";
import { enqueueOutbox } from "../lib/notify.js";

const ConfirmSale = z.object({
  // Optional client-supplied UUID. The branch PWA generates this offline so the
  // local reference and the eventual server row stay linked across sync retries.
  id: z.string().uuid().optional(),
  channel: z.enum(["walkup", "online", "phone", "whatsapp"]),
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

const EditDeliveryAddressBody = z.object({
  // Free-text delivery line the owner can clean up before booking a rider.
  // Shipbubble's validator consumes this as-is (we don't geocode here).
  address: z.string().trim().min(1).max(500),
  // Optional Lagos-style state label; null leaves the existing state untouched
  // only when omitted — an explicit null clears it.
  state: z.string().trim().max(100).nullable().optional(),
});

// Fulfiller-set packaging (straw + bag) on an online order. quantity 0 means
// "remove this material". Replace semantics: the whole set is the desired state.
const SetPackaging = z.object({
  packaging: z
    .array(
      z.object({
        packaging_material_id: z.string().uuid(),
        quantity: z.number().int().min(0),
      }),
    )
    .max(50),
});

// Edit an order's full line set after confirmation. `items` is the DESIRED
// state (not a delta): each line is repriced from the variant's CURRENT price.
// A paid order whose recomputed total no longer matches what was paid needs an
// explicit reconciled:true (the UI prompts a human) — we never auto-charge or
// auto-refund.
const EditItemsBody = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        variantId: z.string().uuid(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
  reconciled: z.boolean().optional(),
  reconcileNote: z.string().trim().max(500).optional(),
});

// Change the scheduled delivery day on a confirmed order. Validated against the
// same future / ≤ 3-month window the storefront checkout enforces.
const EditDeliveryDateBody = z.object({
  scheduledDeliveryAt: z.string(),
});

const RESERVATION_TIMEOUT_MS: Record<string, number> = {
  walkup: 5 * 60_000,
  whatsapp: 30 * 60_000,

  phone: 30 * 60_000,
  online: 30 * 60_000,
};

const LAGOS_OFFSET_MS = 3_600_000; // UTC+1, no DST

/** Lagos (UTC+1) calendar date (YYYY-MM-DD) for an epoch-ms instant. */
function lagosDateStr(ms: number): string {
  const l = new Date(ms + LAGOS_OFFSET_MS);
  return [
    l.getUTCFullYear(),
    String(l.getUTCMonth() + 1).padStart(2, "0"),
    String(l.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Lagos calendar date three months from `ms` — the furthest anyone may schedule. */
function maxScheduleDateStr(ms: number): string {
  const l = new Date(ms + LAGOS_OFFSET_MS);
  const capped = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth() + 3, l.getUTCDate()));
  return [
    capped.getUTCFullYear(),
    String(capped.getUTCMonth() + 1).padStart(2, "0"),
    String(capped.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

// Statuses past the point where an order's line set / delivery day may change:
// the goods are gone (handed over / delivered / out for delivery) or the order
// is dead (failed / cancelled).
const UNEDITABLE_ITEM_STATUSES = new Set<string>([
  "handed_over",
  "out_for_delivery",
  "delivered",
  "failed",
  "cancelled",
]);

export function saleRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireBranchScope());

  // ============ Bag stock for the POS (pos.sell — branch staff have no packaging.view) ============
  // Lists active bag materials with this branch's on-hand count so the till can
  // show "Bags on hand" without granting the cashier the packaging admin views.
  r.get("/bags", requireAnyCapability("pos.sell", "pos.preorder"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const balances = await db.execute<{ packaging_material_id: string; balance: number }>(sql`
      SELECT packaging_material_id, COALESCE(SUM(delta), 0)::int AS balance
      FROM packaging_stock_ledger
      WHERE location_type = 'branch' AND location_id = ${branchId}::uuid
      GROUP BY packaging_material_id
    `);
    const byId = new Map(balances.map((b) => [b.packaging_material_id, Number(b.balance)]));
    const consumables = await db
      .select()
      .from(packagingMaterial)
      .where(and(inArray(packagingMaterial.kind, ["bag", "straw"]), eq(packagingMaterial.isActive, true)));
    return c.json({
      data: consumables.map((m) => ({
        material_id: m.id,
        name: m.name,
        kind: m.kind,
        balance: byId.get(m.id) ?? 0,
      })),
    });
  });

  // ============ Confirm (creates DRAFT→CONFIRMED with stock reservation) ============
  r.post("/", requireAnyCapability("pos.sell", "pos.preorder"), async (c) => {
    const branchId = c.req.param("branchId");
    if (!branchId) throw new BusinessError("validation_failed", "branchId required", 400);
    const body = ConfirmSale.parse(await c.req.json());
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) {
      throw new BusinessError("validation_failed", "idempotency-key header required", 400);
    }
    const auth = c.get("auth");

    // Preorder-only roles (manager/admin: pos.preorder without pos.sell) may pass
    // the gate to take preorders, but must never ring a stock-consuming sale. The
    // gate is open to either capability, so enforce the restriction here.
    if (!auth.capabilities.includes("pos.sell") && body.is_preorder !== true) {
      throw new BusinessError("forbidden", "this role may only create preorders", 403);
    }

    // Open-shift gate: the branch must have an open shift before any sale
    // (walk-up or preorder) can be created. The OWNER is exempt — they may ring
    // a sale on the till without first opening a shift; every other role
    // (branch_staff, and preorder-taking manager/admin) is still gated.
    if (auth.role !== "owner") {
      const [openShift] = await db
        .select({ id: shiftOpen.id })
        .from(shiftOpen)
        .where(and(eq(shiftOpen.branchId, branchId), eq(shiftOpen.status, "open")))
        .limit(1);
      if (!openShift) {
        throw new BusinessError("conflict", "Open a shift before selling", 409);
      }
    }

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
        // The till treats every size the same: a line only becomes a preorder
        // when it can't be covered from stock (or the cashier explicitly took
        // the order as a preorder via is_preorder). preorder_only is a STOREFRONT
        // rule (see public-orders.ts) and is intentionally ignored here so an
        // in-stock 330ml sells instantly at the counter.
        const immediateHandover =
          body.channel === "walkup";
        if (available < it.quantity) {
          // An immediate-handover channel (walk-up) can't give
          // away absent stock unless the cashier deliberately took it as a
          // made-to-order preorder.
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
  r.patch("/:id/pay", requireAnyCapability("pos.sell", "pos.preorder"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const auth = c.get("auth");

    const updated = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
      if (!o) throw new BusinessError("not_found", "sale not found", 404);
      // Preorder-only roles may only pay preorders, never stock-consuming sales.
      if (!auth.capabilities.includes("pos.sell") && !o.isPreorder) {
        throw new BusinessError("forbidden", "this role may only pay preorders", 403);
      }
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

      // Counter channels (walk-up, whatsapp) hand over goods on the spot —
      // there is no separate hand-over step. Advance straight to terminal.
      // Preorders are prepaid but NOT yet fulfilled — they must stay at `paid`
      // until the Preorders queue fulfilment step moves them to `handed_over`.
      const counterChannels = new Set(["walkup", "whatsapp"]);
      const finalStatus = (counterChannels.has(o.channel) && !o.isPreorder) ? ("handed_over" as const) : ("paid" as const);
      const [u] = await tx
        .update(saleOrder)
        .set({ status: finalStatus, paymentStatus: "paid", updatedAt: new Date() })
        .where(eq(saleOrder.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);
      // Gather flavour + size names for the notification line items.
      const itemRows = await tx
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
      const items = itemRows.map((r) => ({
        name: r.name ?? "Item",
        size: r.sizeMl ? `${r.sizeMl}ml` : "",
        qty: r.qty,
        line_total_ngn: r.lineTotal,
      }));
      // Branch sale completed — owner wants to see this.
      await enqueueOutbox(tx, c, "sale.branch_sold", {
        sale_order_id: u.id,
        order_number: u.orderNumber,
        total_ngn: u.totalNgn,
        channel: u.channel,
        items,
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

  // ============ Hand over (PAID→HANDED_OVER for walkup/whatsapp) ============
  r.patch("/:id/hand-over", requireCapability("pos.sell"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const updated = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
      if (!o) throw new BusinessError("not_found", "sale not found", 404);
      if (o.status !== "paid") {
        throw new BusinessError("conflict", `cannot hand over from ${o.status}`, 409);
      }
      if (!["walkup", "whatsapp"].includes(o.channel)) {
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

  // ============ Advance (channel-aware online-order fulfilment transition) ============
  // delivery:  paid → out_for_delivery → delivered
  // pickup:    paid → handed_over → delivered
  // Accepts pos.sell (branch staff) or orders.manage (owner/admin/manager) so
  // both the branch page and the owner order-detail page agree with the server gate.
  r.patch("/:id/advance", requireBranchScope(), requireAnyCapability("orders.manage", "pos.sell"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const updated = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
      if (!o) throw new BusinessError("not_found", "sale not found", 404);
      if (!["online", "phone"].includes(o.channel)) {
        throw new BusinessError("conflict", `not an online order: ${o.channel}`, 409);
      }
      if (o.isPreorder && o.producedAt == null) {
        throw new BusinessError("conflict", "Produce this preorder before handing it over.", 409);
      }
      // Determine fulfilment type.
      const [del] = await tx
        .select({ id: deliveryOrder.id })
        .from(deliveryOrder)
        .where(eq(deliveryOrder.saleOrderId, id))
        .limit(1);
      const isDelivery =
        !!o.deliveryAddressFormatted ||
        !!o.deliveryState ||
        o.deliveryFeeNgn > 0 ||
        !!del;
      const path = isDelivery
        ? { paid: "out_for_delivery", out_for_delivery: "delivered" }
        : { paid: "handed_over", handed_over: "delivered" };
      const next = (path as Record<string, string>)[o.status];
      if (!next) throw new BusinessError("conflict", `cannot advance from ${o.status}`, 409);
      const now = new Date();
      const patch: Record<string, unknown> = { status: next, updatedAt: now };
      if (next === "out_for_delivery") patch["outForDeliveryAt"] = now;
      if (next === "delivered") patch["fulfilledAt"] = now;
      const [u] = await tx
        .update(saleOrder)
        .set(patch)
        .where(eq(saleOrder.id, id))
        .returning();
      if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);
      if (next === "delivered") {
        // If a live ride exists (force-delivered fallback), mark it delivered too so a
        // later Shipbubble 'delivered' webhook is a terminal no-op (no duplicate
        // delivery.completed event).
        await tx.update(deliveryOrder)
          .set({ status: "delivered", deliveredAt: now, updatedAt: now })
          .where(and(eq(deliveryOrder.saleOrderId, id),
                     notInArray(deliveryOrder.status, ["delivered", "failed", "cancelled"])));
      }
      return u;
    });
    await writeAudit(db, c, {
      action: "sale.advance",
      entityType: "sale_order",
      entityId: id,
      after: updated,
    });
    return c.json({ data: updated });
  });

  // ============ Set packaging on an online order (fulfiller-added straw/bag) ============
  // Records the straws + bags used to pack an online/phone order and decrements the
  // branch packaging ledger by the DIFFERENCE vs what was previously recorded, so the
  // fulfiller can edit/correct until the order is delivered. Warn-but-allow: the branch
  // ledger may go negative; packaging never blocks fulfilment. Never touches juice stock.
  r.put(
    "/:id/packaging",
    requireBranchScope(),
    requireAnyCapability("pos.sell", "orders.manage"),
    async (c) => {
      const branchId = c.req.param("branchId");
      const id = c.req.param("id");
      if (!branchId || !id) throw new BusinessError("validation_failed", "branchId and id required", 400);
      const body = SetPackaging.parse(await c.req.json());
      const auth = c.get("auth");

      await db.transaction(async (tx) => {
        const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
        if (!o || o.branchId !== branchId) throw new BusinessError("not_found", "sale not found", 404);
        if (!["online", "phone"].includes(o.channel)) {
          throw new BusinessError("conflict", `not an online order: ${o.channel}`, 409);
        }
        if (o.status === "delivered" || o.status === "cancelled") {
          throw new BusinessError("conflict", `cannot change packaging on a ${o.status} order`, 409);
        }

        // Every requested material must be an active bag/straw consumable.
        const wantIds = body.packaging.map((p) => p.packaging_material_id);
        if (wantIds.length > 0) {
          const mats = await tx
            .select({ id: packagingMaterial.id })
            .from(packagingMaterial)
            .where(
              and(
                inArray(packagingMaterial.id, wantIds),
                inArray(packagingMaterial.kind, ["bag", "straw"]),
                eq(packagingMaterial.isActive, true),
              ),
            );
          const okIds = new Set(mats.map((m) => m.id));
          for (const wid of wantIds) {
            if (!okIds.has(wid)) {
              throw new BusinessError("validation_failed", "not an active bag/straw material", 422);
            }
          }
        }

        // Desired quantities (merge dupes).
        const wantQty = new Map<string, number>();
        for (const p of body.packaging) {
          wantQty.set(p.packaging_material_id, (wantQty.get(p.packaging_material_id) ?? 0) + p.quantity);
        }
        // Previously-recorded quantities.
        const prevRows = await tx
          .select()
          .from(saleOrderPackaging)
          .where(eq(saleOrderPackaging.saleOrderId, id));
        const prevQty = new Map<string, number>();
        for (const r of prevRows) prevQty.set(r.packagingMaterialId, r.quantity);

        // Diff → one compensating ledger row per changed material + reconcile rows.
        const allIds = new Set<string>([...prevQty.keys(), ...wantQty.keys()]);
        for (const mid of allIds) {
          const prev = prevQty.get(mid) ?? 0;
          const next = wantQty.get(mid) ?? 0;
          const delta = next - prev;
          if (delta !== 0) {
            await tx.insert(packagingStockLedger).values({
              locationType: "branch",
              locationId: o.branchId,
              packagingMaterialId: mid,
              delta: -delta, // consuming more decrements; reducing count returns stock
              sourceType: "consumption",
              sourceId: id,
              recordedByUserId: auth.userId,
              note: `Online packaging ${o.orderNumber}`,
            });
          }
          if (next <= 0 && prev > 0) {
            await tx
              .delete(saleOrderPackaging)
              .where(and(eq(saleOrderPackaging.saleOrderId, id), eq(saleOrderPackaging.packagingMaterialId, mid)));
          } else if (next > 0 && prev === 0) {
            await tx.insert(saleOrderPackaging).values({ saleOrderId: id, packagingMaterialId: mid, quantity: next });
          } else if (next > 0 && prev > 0 && next !== prev) {
            await tx
              .update(saleOrderPackaging)
              .set({ quantity: next })
              .where(and(eq(saleOrderPackaging.saleOrderId, id), eq(saleOrderPackaging.packagingMaterialId, mid)));
          }
        }
      });

      await writeAudit(db, c, {
        action: "sale.packaging_set",
        entityType: "sale_order",
        entityId: id,
        after: { packaging: body.packaging },
      });
      return c.json({ data: { ok: true } });
    },
  );

  // ============ Edit delivery address ============
  // Lets the owner/branch clean up the drop-off address (and state) before
  // booking a rider. The delivery-options/book flow already reads
  // deliveryAddressFormatted + deliveryState first, so an edit here flows
  // straight into Shipbubble. Same gate as /advance: orders.manage OR pos.sell.
  r.patch(
    "/:id/delivery-address",
    requireBranchScope(),
    requireAnyCapability("orders.manage", "pos.sell"),
    async (c) => {
      const id = c.req.param("id");
      if (!id) throw new BusinessError("validation_failed", "id required", 400);
      const body = EditDeliveryAddressBody.parse(await c.req.json());

      const { before, after } = await db.transaction(async (tx) => {
        const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
        if (!o) throw new BusinessError("not_found", "sale not found", 404);
        if (o.channel === "walkup") {
          throw new BusinessError("conflict", "walk-up orders have no delivery address", 409);
        }
        if (["delivered", "cancelled"].includes(o.status)) {
          throw new BusinessError("conflict", `cannot edit a ${o.status} order`, 409);
        }
        const beforeRow = {
          deliveryAddressFormatted: o.deliveryAddressFormatted,
          deliveryState: o.deliveryState,
        };
        const patch: Record<string, unknown> = {
          deliveryAddressFormatted: body.address,
          updatedAt: new Date(),
        };
        // Only touch state when the caller sent the key (null clears, string sets).
        if (body.state !== undefined) patch["deliveryState"] = body.state;
        const [u] = await tx
          .update(saleOrder)
          .set(patch)
          .where(eq(saleOrder.id, id))
          .returning();
        if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);
        return {
          before: beforeRow,
          after: { deliveryAddressFormatted: u.deliveryAddressFormatted, deliveryState: u.deliveryState },
        };
      });

      await writeAudit(db, c, {
        action: "sale.edit_delivery_address",
        entityType: "sale_order",
        entityId: id,
        before,
        after,
      });
      return c.json({ data: after });
    },
  );

  // ============ Edit items (recompute totals from current prices) ============
  // Lets a manager/admin correct an order's line set (add/remove/change qty)
  // after confirmation. Every line is REPRICED from the variant's current
  // price — the caller never supplies a price. Stock follows the change:
  // reservations move for an unpaid order; a paid order (stock already
  // deducted) gets a compensating ledger row per changed variant. Money is
  // NEVER moved automatically: if the recomputed total no longer matches what
  // the customer paid, the caller must pass reconciled:true (the UI prompts a
  // human to settle the difference via Returns / a follow-up charge).
  r.patch(
    "/:id/items",
    requireBranchScope(),
    requireAnyCapability("orders.manage", "pos.sell"),
    async (c) => {
      const branchId = c.req.param("branchId");
      const id = c.req.param("id");
      if (!branchId || !id) throw new BusinessError("validation_failed", "branchId and id required", 400);
      const body = EditItemsBody.parse(await c.req.json());
      const auth = c.get("auth");

      const result = await db.transaction(async (tx) => {
        const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
        if (!o || o.branchId !== branchId) throw new BusinessError("not_found", "sale not found", 404);
        if (!["online", "phone"].includes(o.channel)) {
          throw new BusinessError("conflict", `not an online order: ${o.channel}`, 409);
        }
        if (UNEDITABLE_ITEM_STATUSES.has(o.status)) {
          throw new BusinessError("conflict", `cannot edit items on a ${o.status} order`, 409);
        }

        // Desired lines, merged by variant (the request is the full set).
        const desired = new Map<string, { productId: string; quantity: number }>();
        for (const it of body.items) {
          const cur = desired.get(it.variantId);
          if (cur) {
            if (cur.productId !== it.productId) {
              throw new BusinessError("validation_failed", "variant_id sent with two product_ids", 422);
            }
            cur.quantity += it.quantity;
          } else {
            desired.set(it.variantId, { productId: it.productId, quantity: it.quantity });
          }
        }

        // Resolve + reprice every desired line from the CURRENT variant price.
        const priced = new Map<
          string,
          { productId: string; priceId: string; unitPriceNgn: number; quantity: number; lineTotalNgn: number }
        >();
        let newSubtotal = 0;
        for (const [variantId, { productId, quantity }] of desired) {
          const [v] = await tx
            .select()
            .from(productVariant)
            .where(and(eq(productVariant.id, variantId), isNull(productVariant.deletedAt)));
          if (!v || !v.isActive) {
            throw new BusinessError("validation_failed", `variant ${variantId} is not sellable`, 422);
          }
          if (v.productId !== productId) {
            throw new BusinessError("validation_failed", "variant_id does not belong to product_id", 422);
          }
          const [price] = await tx
            .select()
            .from(productPrice)
            .where(and(eq(productPrice.variantId, variantId), isNull(productPrice.validTo)))
            .orderBy(desc(productPrice.validFrom))
            .limit(1);
          if (!price) {
            throw new BusinessError("validation_failed", `no price for variant ${variantId}`, 422);
          }
          const lineTotalNgn = price.priceNgn * quantity;
          priced.set(variantId, {
            productId,
            priceId: price.id,
            unitPriceNgn: price.priceNgn,
            quantity,
            lineTotalNgn,
          });
          newSubtotal += lineTotalNgn;
        }
        const newTotal = newSubtotal + o.deliveryFeeNgn;

        // Manual-reconcile gate. A paid order's "amount paid" is its current
        // totalNgn; if the recompute changes that, a human must acknowledge the
        // difference before we touch the order. We NEVER move money here.
        const wasPaid = o.status === "paid";
        const delta = newTotal - o.totalNgn;
        if (wasPaid && delta !== 0 && body.reconciled !== true) {
          const dir = delta > 0 ? "owes ₦" : "is owed ₦";
          throw new BusinessError(
            "reconcile_required",
            `Total changes from ₦${o.totalNgn} to ₦${newTotal}; customer ${dir}${Math.abs(delta)}. Re-submit with reconciled:true to proceed (no automatic charge or refund).`,
            409,
            { previous_total_ngn: o.totalNgn, new_total_ngn: newTotal, delta_ngn: delta },
          );
        }

        // Snapshot the existing line set (for the audit + stock diff), keyed by
        // variant. Any legacy duplicate rows for the same variant are collapsed.
        const existingRows = await tx
          .select()
          .from(saleOrderItem)
          .where(eq(saleOrderItem.saleOrderId, id));
        const beforeLines = existingRows.map((r) => ({
          productId: r.productId,
          variantId: r.variantId,
          quantity: r.quantity,
          unitPriceNgn: r.unitPriceNgn,
          lineTotalNgn: r.lineTotalNgn,
        }));
        const existingByVariant = new Map<string, number>();
        for (const r of existingRows) {
          if (!r.variantId) continue;
          existingByVariant.set(r.variantId, (existingByVariant.get(r.variantId) ?? 0) + r.quantity);
        }

        // Replace the line set cleanly (delete then insert the desired set) so
        // totals are always exact even if legacy duplicate rows existed.
        await tx.delete(saleOrderItem).where(eq(saleOrderItem.saleOrderId, id));
        for (const [variantId, p] of priced) {
          await tx.insert(saleOrderItem).values({
            saleOrderId: id,
            productId: p.productId,
            variantId,
            productPriceId: p.priceId,
            quantity: p.quantity,
            unitPriceNgn: p.unitPriceNgn,
            lineTotalNgn: p.lineTotalNgn,
          });
        }

        // Stock: apply the per-variant quantity delta.
        //  - `confirmed` non-preorder → soft holds exist; move the reservations.
        //  - Stock already deducted → post a compensating ledger row per changed
        //    variant into the SAME variant bucket (positive when reducing qty =
        //    restore; negative when increasing = further deduct), mirroring the
        //    cancel handler's restore.
        // A preorder only deducts at production, so a paid-but-unproduced
        // preorder has NO stock to move — its edit just re-bases what the
        // production step will later deduct from the (new) line rows.
        const reservationsApply = o.status === "confirmed" && !o.isPreorder;
        const stockDeducted = o.status === "paid" && (!o.isPreorder || o.producedAt != null);
        const expiresAt = new Date(Date.now() + (RESERVATION_TIMEOUT_MS[o.channel] ?? 30 * 60_000));
        const allVariants = new Set<string>([...existingByVariant.keys(), ...priced.keys()]);
        for (const variantId of allVariants) {
          const prev = existingByVariant.get(variantId) ?? 0;
          const next = priced.get(variantId)?.quantity ?? 0;
          if (prev === next) continue;
          const productId = priced.get(variantId)?.productId
            ?? existingRows.find((r) => r.variantId === variantId)!.productId;

          if (reservationsApply) {
            // Recompute the reservation for this variant to `next`.
            await tx
              .delete(stockReservation)
              .where(and(eq(stockReservation.saleOrderId, id), eq(stockReservation.variantId, variantId)));
            if (next > 0) {
              await tx.insert(stockReservation).values({
                saleOrderId: id,
                branchId: o.branchId,
                productId,
                variantId,
                quantity: next,
                expiresAt,
              });
            }
          } else if (stockDeducted) {
            // ledgerDelta = prev - next: positive restores (reduced qty),
            // negative deducts more (increased qty).
            const ledgerDelta = prev - next;
            await tx.insert(stockLedger).values({
              locationType: "branch",
              locationId: o.branchId,
              productId,
              variantId,
              delta: ledgerDelta,
              sourceType: ledgerDelta > 0 ? "sale_cancelled" : "sale",
              sourceId: id,
              recordedByUserId: auth.userId,
              note: `Edit ${o.orderNumber}: qty ${prev}→${next}`,
            });
          }
        }

        const [u] = await tx
          .update(saleOrder)
          .set({ subtotalNgn: newSubtotal, totalNgn: newTotal, updatedAt: new Date() })
          .where(eq(saleOrder.id, id))
          .returning();
        if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);

        const items = await tx.select().from(saleOrderItem).where(eq(saleOrderItem.saleOrderId, id));
        return { order: u, items, beforeLines, delta };
      });

      await writeAudit(db, c, {
        action: "sale.items_edit",
        entityType: "sale_order",
        entityId: id,
        before: { orderNumber: result.order.orderNumber, lines: result.beforeLines },
        after: {
          orderNumber: result.order.orderNumber,
          lines: result.items.map((i) => ({
            productId: i.productId,
            variantId: i.variantId,
            quantity: i.quantity,
            unitPriceNgn: i.unitPriceNgn,
            lineTotalNgn: i.lineTotalNgn,
          })),
          subtotalNgn: result.order.subtotalNgn,
          totalNgn: result.order.totalNgn,
          deltaNgn: result.delta,
          ...(body.reconciled ? { reconciled: true, reconcileNote: body.reconcileNote ?? null } : {}),
        },
      });
      return c.json({ data: { ...result.order, items: result.items } });
    },
  );

  // ============ Edit delivery date ============
  // Change the scheduled delivery day on a confirmed online/phone order. The
  // date is validated against the same window as the storefront checkout: it
  // must be a valid ISO datetime, in the future, and no more than three months
  // out. Terminal orders (delivered/cancelled) are frozen.
  r.patch(
    "/:id/delivery-date",
    requireBranchScope(),
    requireAnyCapability("orders.manage", "pos.sell"),
    async (c) => {
      const id = c.req.param("id");
      if (!id) throw new BusinessError("validation_failed", "id required", 400);
      const body = EditDeliveryDateBody.parse(await c.req.json());

      const scheduledMs = Date.parse(body.scheduledDeliveryAt);
      if (isNaN(scheduledMs)) {
        throw new BusinessError("validation_failed", "scheduledDeliveryAt must be a valid ISO datetime", 422);
      }
      if (scheduledMs <= Date.now()) {
        throw new BusinessError("validation_failed", "scheduledDeliveryAt must be in the future", 422);
      }
      if (lagosDateStr(scheduledMs) > maxScheduleDateStr(Date.now())) {
        throw new BusinessError("validation_failed", "scheduledDeliveryAt is too far in the future", 422);
      }

      const { before, after } = await db.transaction(async (tx) => {
        const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
        if (!o) throw new BusinessError("not_found", "sale not found", 404);
        if (["delivered", "cancelled"].includes(o.status)) {
          throw new BusinessError("conflict", `cannot edit a ${o.status} order`, 409);
        }
        const [u] = await tx
          .update(saleOrder)
          .set({ scheduledDeliveryAt: new Date(scheduledMs), updatedAt: new Date() })
          .where(eq(saleOrder.id, id))
          .returning();
        if (!u) throw new BusinessError("internal_error", "update returned no rows", 500);
        return {
          before: { scheduledDeliveryAt: o.scheduledDeliveryAt },
          after: { scheduledDeliveryAt: u.scheduledDeliveryAt },
        };
      });

      await writeAudit(db, c, {
        action: "sale.delivery_date_edit",
        entityType: "sale_order",
        entityId: id,
        before,
        after,
      });
      return c.json({ data: after });
    },
  );

  // ============ Cancel (any non-terminal→CANCELLED) ============
  // Gated on orders.manage OR pos.sell so branch managers (orders.manage,
  // no pos.sell) can cancel order-ops issues without needing till access,
  // while branch_staff/owner keep their existing access via pos.sell.
  r.patch("/:id/cancel", requireAnyCapability("orders.manage", "pos.sell"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const auth = c.get("auth");
    const { reason } = CancelBody.parse(await c.req.json());

    const { row: updated, wasPaid } = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(saleOrder).where(eq(saleOrder.id, id));
      if (!o) throw new BusinessError("not_found", "sale not found", 404);
      if (["handed_over", "delivered", "cancelled", "failed"].includes(o.status)) {
        throw new BusinessError("conflict", `cannot cancel from ${o.status}`, 409);
      }
      const wasPaid = o.status === "paid";

      // Compensating ledger if already paid
      if (wasPaid) {
        const items = await tx
          .select()
          .from(saleOrderItem)
          .where(eq(saleOrderItem.saleOrderId, id));
        for (const it of items) {
          await tx.insert(stockLedger).values({
            locationType: "branch",
            locationId: o.branchId,
            productId: it.productId,
            // Restore to the SAME size bucket the sale deducted from. Omitting
            // this drops the credit into the legacy no-size (NULL) bucket, which
            // leaves the per-size grid skewed (a negative sized row + a phantom
            // no-size row) even though the per-flavour total still nets out.
            variantId: it.variantId ?? null,
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
      return { row: u, wasPaid };
    });
    await writeAudit(db, c, {
      action: "sale.cancel",
      entityType: "sale_order",
      entityId: id,
      after: updated,
    });
    // The order was already paid — stock is restored and the order marked
    // cancelled above, but NO refund is issued automatically. Flag it in the
    // response so the UI can prompt a human to action a manual refund (via
    // Returns) rather than silently leaving money owed with no signal.
    return c.json({
      data: updated,
      ...(wasPaid ? { refundOwed: true, paidAmountNgn: updated.totalNgn } : {}),
    });
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
    // Attach customer name + phone so the Orders / Sales lists can show who
    // placed each order (esp. online orders) without opening every row. Batch
    // one lookup over the page's distinct customers rather than per-row.
    const custIds = [
      ...new Set(rows.map((r) => r.customerId).filter((x): x is string => x != null)),
    ];
    const custById = new Map<string, { name: string | null; phone: string | null }>();
    if (custIds.length > 0) {
      const custs = await db
        .select({ id: customer.id, name: customer.name, phone: customer.phone })
        .from(customer)
        .where(inArray(customer.id, custIds));
      for (const cu of custs) custById.set(cu.id, { name: cu.name, phone: cu.phone });
    }
    return c.json({
      data: rows.map((r) => ({
        ...r,
        customerName: r.customerId ? (custById.get(r.customerId)?.name ?? null) : null,
        customerPhone: r.customerId ? (custById.get(r.customerId)?.phone ?? null) : null,
      })),
    });
  });

  r.get("/:id", requireCapability("sales.view"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const [o] = await db.select().from(saleOrder).where(eq(saleOrder.id, id));
    if (!o) throw new BusinessError("not_found", "sale not found", 404);
    // Join the variant so each item carries its bottle size (sizeMl). Staff
    // packing an online order need the size, and the printed receipt uses it.
    const itemRows = await db
      .select({ item: saleOrderItem, sizeMl: productVariant.sizeMl })
      .from(saleOrderItem)
      .leftJoin(productVariant, eq(productVariant.id, saleOrderItem.variantId))
      .where(eq(saleOrderItem.saleOrderId, id));
    const items = itemRows.map((r) => ({ ...r.item, sizeMl: r.sizeMl ?? null }));
    // Customer contact for the order page (WhatsApp link + rider relay + the
    // Customer card). Email and the on-file address let staff reach and locate
    // an online customer even when no live courier address was captured.
    let customerName: string | null = null;
    let customerPhone: string | null = null;
    let customerEmail: string | null = null;
    let customerAddress: string | null = null;
    if (o.customerId) {
      const [cust] = await db
        .select({
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
          defaultAddress: customer.defaultAddress,
        })
        .from(customer)
        .where(eq(customer.id, o.customerId));
      customerName = cust?.name ?? null;
      customerPhone = cust?.phone ?? null;
      customerEmail = cust?.email ?? null;
      customerAddress = cust?.defaultAddress ?? null;
    }
    // Latest delivery_order if any (single source of truth for rider info).
    const { deliveryOrder } = await import("@ms/db");
    const { desc: descFn } = await import("drizzle-orm");
    const [delivery] = await db
      .select()
      .from(deliveryOrder)
      .where(eq(deliveryOrder.saleOrderId, id))
      .orderBy(descFn(deliveryOrder.requestedAt))
      .limit(1);
    // Latest payment row's amount as `reportedNgn` — the amount Payaza
    // actually reported, which may differ from totalNgn on a mismatch. Same
    // pattern as review.ts's payment_attention inbox. Null if no payment yet.
    const [latestPayment] = await db
      .select({
        amountNgn: payment.amountNgn,
        feeNgn: payment.feeNgn,
        grossNgn: payment.grossNgn,
        netNgn: payment.netNgn,
      })
      .from(payment)
      .where(eq(payment.saleOrderId, id))
      .orderBy(descFn(payment.createdAt))
      .limit(1);
    // Straws + bags the fulfiller recorded on this order (tracked-only), so the
    // detail page can show + edit what was packed.
    const packagingRows = await db
      .select({
        packaging_material_id: saleOrderPackaging.packagingMaterialId,
        quantity: saleOrderPackaging.quantity,
      })
      .from(saleOrderPackaging)
      .where(eq(saleOrderPackaging.saleOrderId, id));
    return c.json({
      data: {
        ...o,
        items,
        packaging: packagingRows,
        customerName,
        customerPhone,
        customerEmail,
        customerAddress,
        delivery: delivery ?? null,
        reportedNgn: latestPayment?.amountNgn ?? null,
        grossNgn: latestPayment?.grossNgn ?? null,
        feeNgn: latestPayment?.feeNgn ?? null,
        netNgn: latestPayment?.netNgn ?? null,
      },
    });
  });

  return r;
}

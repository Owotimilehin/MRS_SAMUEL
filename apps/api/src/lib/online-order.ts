/**
 * The one place an online order is created: the storefront's checkout and an
 * order a staff member places from a WhatsApp cart both call this (suite spec
 * 08, section 5.4).
 *
 * This is the transaction body that used to sit inline in POST
 * /v1/public/orders, moved here unchanged: it resolves the customer, prices
 * every line from product_price, checks stock per size with
 * availableVariantAtBranch, works out the delivery schedule, inserts the
 * order, its lines and stock reservations, and queues the owner's
 * "sale.online_placed" alert. Everything before the transaction (idempotent
 * replay, bot check, date checks, delivery-quote verification, reading the
 * cart) and after it (emptying the cart, OPay) stays with the caller.
 *
 * The order is always channel "online", status "confirmed", payment method
 * "card", payment status "pending": the unpaid-order expiry, the payment sweep,
 * the reminder and the online-orders queue all key on channel = 'online'.
 */
import { eq, and, desc, asc, isNull } from "drizzle-orm";
import {
  saleOrder,
  saleOrderItem,
  outboxEvent,
  productPrice,
  productVariant,
  product,
  stockReservation,
  type DbClient,
} from "@ms/db";
import { availableVariantAtBranch, nextOrderNumber } from "@ms/domain";
import { normalizeNigerianPhone, orderSchedule, scheduledIso, type DeliveryWindow } from "@ms/shared";
import { BusinessError } from "./errors.js";
import { resolveCustomer } from "./customers.js";
import type { PaymentProvider } from "../payments/provider.js";

export const LAGOS_OFFSET_MS = 3_600_000; // UTC+1, no DST

/** Lagos (UTC+1) calendar date (YYYY-MM-DD) for an epoch-ms instant. */
export function lagosDateStr(ms: number): string {
  const l = new Date(ms + LAGOS_OFFSET_MS);
  return [
    l.getUTCFullYear(),
    String(l.getUTCMonth() + 1).padStart(2, "0"),
    String(l.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface PlaceOnlineOrderInput {
  branchId: string;
  /** uuid; becomes sale_order.idempotency_key (unique). */
  idempotencyKey: string;
  /** Give customerId (chat) OR let the function resolve by phone (storefront). */
  customerId?: string;
  customer: { name: string; phone: string; email: string | null; address: string | null; altPhone: string | null };
  items: ReadonlyArray<{ variant_id?: string | undefined; product_id?: string | undefined; quantity: number }>;
  /** Already decided and verified by the caller. */
  deliveryFeeNgn: number;
  deliveryQuoteRef: string | null;
  deliveryAddressCode: string | null;
  deliveryAddressFormatted: string | null;
  deliveryState: string | null;
  /** ISO datetime, already validated by the caller. */
  scheduledDeliveryAt: string | null;
  deliveryWindow: DeliveryWindow | null;
  notes: string | null;
  paymentProvider: PaymentProvider;
}

export async function placeOnlineOrder(
  tx: Tx,
  input: PlaceOnlineOrderInput,
): Promise<{ order: typeof saleOrder.$inferSelect; customerEmail: string | null }> {
  let normalizedPhone: string | null;
  let customerId: string | null;
  if (input.customerId !== undefined) {
    // An order placed for a customer we already know (a WhatsApp chat order):
    // the caller has resolved who it is and gives a usable phone number.
    normalizedPhone = input.customer.phone;
    customerId = input.customerId;
  } else {
    normalizedPhone = normalizeNigerianPhone(input.customer.phone);
    if (!normalizedPhone) {
      throw new BusinessError(
        "validation_failed",
        "phone must be a valid Nigerian number",
        422,
      );
    }
    // Same identity rule as the POS: a returning customer (matched on the
    // normalized phone) reuses their existing row so online + counter orders
    // roll up together.
    customerId = await resolveCustomer(tx, {
      name: input.customer.name,
      phone: normalizedPhone,
      email: input.customer.email,
      defaultAddress: input.customer.address,
      source: "online",
    });
    if (!customerId) throw new BusinessError("internal_error", "customer resolve failed", 500);
  }

  let subtotal = 0;
  // A line is a preorder line when the branch is currently out of stock for
  // that specific variant (per-size). Any preorder line makes the whole order
  // a preorder: it skips reservations now and defers the stock deduction to
  // fulfilment (see preorders.ts), but still requires payment.
  let orderIsPreorder = false;
  const lines: {
    productId: string;
    variantId: string;
    priceId: string;
    quantity: number;
    unit: number;
    sizeMl: number;
    inStock: boolean;
  }[] = [];

  for (const it of input.items) {
    // Resolve to a concrete variant: prefer the explicit variant_id, else
    // the smallest can for the given product_id (legacy callers).
    // The cart-derived path always carries variant_id, so product_id may
    // be undefined.
    const itAny = it as { variant_id?: string; product_id?: string; quantity: number };
    let variantId: string | undefined = itAny.variant_id;
    let productId: string;
    let sizeMl: number;
    if (variantId) {
      const [v] = await tx
        .select()
        .from(productVariant)
        .where(and(eq(productVariant.id, variantId), isNull(productVariant.deletedAt)));
      if (!v) {
        throw new BusinessError("not_found", `variant ${variantId} not found`, 404);
      }
      productId = v.productId;
      sizeMl = v.sizeMl;
      // If a caller sends both, the supplied product_id must match the variant's parent.
      if (itAny.product_id && itAny.product_id !== v.productId) {
        throw new BusinessError(
          "validation_failed",
          "variant_id does not belong to product_id",
          422,
        );
      }
    } else {
      productId = itAny.product_id!;
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
      sizeMl = v.sizeMl;
    }

    const [p] = await tx
      .select()
      .from(productPrice)
      .where(and(eq(productPrice.variantId, variantId), isNull(productPrice.validTo)))
      .orderBy(desc(productPrice.validFrom))
      .limit(1);
    if (!p) {
      throw new BusinessError("not_found", `no price for variant ${variantId}`, 404);
    }
    // Per-variant (per-size) stock check: a line is a preorder when its
    // specific size is out of stock at the branch.
    const available = await availableVariantAtBranch(tx, {
      branchId: input.branchId,
      variantId,
    });
    const inStock = it.quantity <= available;
    if (!inStock) {
      orderIsPreorder = true;
    }
    lines.push({
      productId,
      variantId,
      priceId: p.id,
      quantity: it.quantity,
      unit: p.priceNgn,
      sizeMl,
      inStock,
    });
    subtotal += p.priceNgn * it.quantity;
  }

  // Compute server-authoritative delivery schedule from line kinds.
  // `schedResult.date` is the earliest FEASIBLE (floor) date — a preorder
  // cannot be delivered sooner than this.
  const lineKinds = lines.map((l) => ({ sizeMl: l.sizeMl, inStock: l.inStock }));
  const scheduleNow = new Date();
  const schedResult = orderSchedule(scheduleNow, lineKinds);

  // Honour a customer-chosen delivery date. When they scheduled a day later
  // than the floor, deliver on that day (clamped to >= floor, already capped
  // to <= 3 months above) and allow any of the three windows for it. When no
  // date is sent, or it falls on/before the floor, we keep the floor date.
  let effectiveDate = schedResult.date;
  let scheduledLaterDay = false;
  if (input.scheduledDeliveryAt != null) {
    const requestedDate = lagosDateStr(Date.parse(input.scheduledDeliveryAt));
    if (requestedDate > schedResult.date) {
      effectiveDate = requestedDate;
      scheduledLaterDay = true;
    }
  }

  // Choose the delivery window. On an explicitly-scheduled later day any of
  // the three windows is valid. Otherwise the window must fit the computed
  // schedule: it must equal fixedWindow (fixed schedules) or be present in
  // selectableWindows. Any other value — including undefined — falls back to
  // the server default.
  const requested = input.deliveryWindow;
  let chosenWindow: DeliveryWindow;
  if (scheduledLaterDay) {
    chosenWindow = requested ?? "morning";
  } else {
    const isValidWindow =
      requested != null &&
      (schedResult.fixedWindow
        ? requested === schedResult.fixedWindow
        : schedResult.selectableWindows.includes(requested));
    chosenWindow = isValidWindow
      ? requested!
      : (schedResult.fixedWindow ?? schedResult.selectableWindows[0] ?? "morning");
  }
  const scheduledDeliveryAt = new Date(scheduledIso(effectiveDate, chosenWindow));

  const total = subtotal + input.deliveryFeeNgn;
  const orderNumber = await nextOrderNumber(tx);
  const [o] = await tx
    .insert(saleOrder)
    .values({
      orderNumber,
      branchId: input.branchId,
      channel: "online",
      customerId,
      status: "confirmed",
      isPreorder: orderIsPreorder,
      subtotalNgn: subtotal,
      deliveryFeeNgn: input.deliveryFeeNgn,
      totalNgn: total,
      paymentMethod: "card",
      paymentStatus: "pending",
      paymentProvider: input.paymentProvider,
      createdAtLocal: new Date(),
      idempotencyKey: input.idempotencyKey,
      scheduledDeliveryAt,
      deliveryState: input.deliveryState,
      deliveryQuoteRef: input.deliveryQuoteRef,
      deliveryAddressCode: input.deliveryAddressCode,
      deliveryAddressFormatted: input.deliveryAddressFormatted,
      notes: input.notes,
      altPhone: input.customer.altPhone,
    })
    .returning();
  if (!o) throw new BusinessError("internal_error", "order insert failed", 500);

  const expiresAt = new Date(Date.now() + 30 * 60_000); // 30-min hold for online
  for (const l of lines) {
    await tx.insert(saleOrderItem).values({
      saleOrderId: o.id,
      productId: l.productId,
      variantId: l.variantId,
      productPriceId: l.priceId,
      quantity: l.quantity,
      unitPriceNgn: l.unit,
      lineTotalNgn: l.unit * l.quantity,
    });
    // Preorders deduct stock at fulfilment, not now — so nothing to reserve.
    if (!orderIsPreorder) {
      await tx.insert(stockReservation).values({
        saleOrderId: o.id,
        branchId: input.branchId,
        productId: l.productId,
        variantId: l.variantId,
        quantity: l.quantity,
        expiresAt,
      });
    }
  }
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
    .where(eq(saleOrderItem.saleOrderId, o.id));
  const items = itemRows.map((r) => ({
    name: r.name ?? "Item",
    size: r.sizeMl ? `${r.sizeMl}ml` : "",
    qty: r.qty,
    line_total_ngn: r.lineTotal,
  }));
  // Tell the owner (and anyone else subscribed) that a new online order
  // just landed and is waiting on payment.
  await tx.insert(outboxEvent).values({
    eventType: "sale.online_placed",
    payload: {
      sale_order_id: o.id,
      order_number: o.orderNumber,
      total_ngn: total,
      customer_name: input.customer.name,
      customer_phone: normalizedPhone,
      scheduled_delivery_at: o.scheduledDeliveryAt
        ? o.scheduledDeliveryAt.toISOString()
        : null,
      delivery_state: o.deliveryState ?? null,
      items,
    },
  });
  return { order: o, customerEmail: input.customer.email };
}

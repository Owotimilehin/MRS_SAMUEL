import { Hono } from "hono";
import { z } from "zod";
import { eq, and, desc, asc, isNull } from "drizzle-orm";
import {
  saleOrder,
  saleOrderItem,
  outboxEvent,
  productPrice,
  productVariant,
  product,
  customer,
  stockReservation,
  payment,
  branch,
  type DbClient,
} from "@ms/db";
import { availableVariantAtBranch, nextOrderNumber } from "@ms/domain";
import {
  normalizeNigerianPhone,
  phonesMatch,
  isOutsideLagos,
  orderSchedule,
  scheduledIso,
  type DeliveryWindow,
} from "@ms/shared";
import { rateLimit } from "../middleware/rate-limit.js";
import { BusinessError } from "../lib/errors.js";
import { buildPayazaCheckoutConfig } from "../payments/payaza.js";
import { resolveCustomer } from "../lib/customers.js";
import { getDeliveryProvider } from "../delivery/index.js";
import { storeOptionSet, loadOptionSet } from "../delivery/quote-store.js";
import { takeCartAsOrderItems, clearCartForCookie } from "./public-cart.js";
import { verifyTurnstileToken } from "../lib/turnstile.js";
import { env } from "../env.js";
import { verifyAndReconcile } from "../payments/reconcile.js";
import { logger } from "../logger.js";

const CreateOnlineOrder = z.object({
  branch_id: z.string().uuid(),
  zone_name: z.string().min(1).optional(),
  delivery_fee_ngn: z.number().int().nonnegative(),
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().min(7),
    email: z.string().email().optional(),
    address: z.string().min(3),
    lat: z.number().optional(),
    lng: z.number().optional(),
    alt_phone: z.string().optional(),
  }),
  /**
   * Items are optional in the request body. When omitted, the server reads
   * the current customer's cart (cookie-keyed) and uses those lines. This is
   * the path the customer site takes since we moved to server-side carts.
   *
   * The explicit shape is still accepted so older callers and integration
   * tests keep working unchanged.
   */
  items: z
    .array(
      z
        .object({
          variant_id: z.string().uuid().optional(),
          product_id: z.string().uuid().optional(),
          quantity: z.number().int().positive(),
        })
        .refine((v) => v.variant_id != null || v.product_id != null, {
          message: "each item needs variant_id or product_id",
        }),
    )
    .min(1)
    .optional(),
  notes: z.string().optional(),
  /** Optional: the quote id returned by /orders/quote — locks the fee. */
  delivery_quote_id: z.string().optional(),
  /**
   * ISO-8601 datetime string. When supplied the order is scheduled for later
   * and Bolt dispatch is bypassed — the owner fulfils manually.
   */
  scheduled_delivery_at: z.string().optional(),
  /**
   * Customer-selected delivery window. When supplied and valid for the computed
   * schedule (i.e. it matches fixedWindow or is in selectableWindows), it is
   * used instead of the server default. Invalid or missing windows fall back to
   * fixedWindow ?? selectableWindows[0] ?? "morning".
   */
  delivery_window: z.enum(["morning", "afternoon", "evening"]).optional(),
  /**
   * Nigerian state name for outside-Lagos deliveries. When supplied (and not
   * "Lagos") the delivery fee is forced to ₦0 and Bolt dispatch is bypassed.
   */
  delivery_state: z.string().min(1).optional(),
  /** Cloudflare Turnstile token from the checkout widget (bot protection). */
  turnstile_token: z.string().optional(),
});

const QuoteRequest = z.object({
  branch_id: z.string().uuid(),
  dropoff_address: z.string().min(3),
  dropoff_lat: z.number().optional(),
  dropoff_lng: z.number().optional(),
  delivery_state: z.string().min(1).optional(),
});

/**
 * Shipbubble's address validator needs a complete address (street, area,
 * state, country). Append the delivery state + "Nigeria" when the customer's
 * text omits them, so more addresses validate (and thus return couriers)
 * instead of silently dropping to ₦0.
 */
function normalizeDropoff(addr: string, state?: string): string {
  const a = addr.trim().replace(/,\s*$/, "");
  if (/nigeria/i.test(a)) return a;
  const st = state && state.trim() ? state.trim() : "Lagos";
  return new RegExp(st, "i").test(a) ? `${a}, Nigeria` : `${a}, ${st}, Nigeria`;
}

const TrackQuery = z.object({
  phone: z.string().min(7),
});

export function publicOrderRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", rateLimit({ points: 30, durationSeconds: 60, keyPrefix: "public-orders" }));

  /**
   * Live delivery options. The customer's checkout calls this as the address
   * settles (immediate, in-Lagos only) and shows the returned couriers for the
   * customer to choose from. Returns an empty list when no live price is
   * available — delivery is then ignored (₦0); we never use a manual zone fee.
   */
  r.post("/quote", async (c) => {
    const body = QuoteRequest.parse(await c.req.json());
    const [b] = await db.select().from(branch).where(eq(branch.id, body.branch_id));
    if (!b || !b.isActive || b.deletedAt) {
      throw new BusinessError("not_found", "branch not found", 404);
    }
    const pickupLat = b.lat != null ? Number(b.lat) : null;
    const pickupLng = b.lng != null ? Number(b.lng) : null;

    const empty = (notice: string, addressValid = false) =>
      c.json({
        data: {
          provider: "fallback" as const,
          quote_token: null,
          options: [],
          validated_address: null,
          address_valid: addressValid,
          notice,
        },
      });

    if (!b.address) {
      // No pickup address on file — cannot get live options. Delivery ₦0.
      // Coordinates are optional: the active provider (Shipbubble) geocodes the
      // address and uses an env-configured sender, so a branch with only an
      // address still gets live courier rates. (Older Bolt code required coords;
      // that gate wrongly suppressed all quotes for coord-less branches.)
      return empty("Live delivery pricing is unavailable — no delivery charge applied.");
    }

    const provider = getDeliveryProvider();
    const dropoff = normalizeDropoff(body.dropoff_address, body.delivery_state);
    try {
      const input: Parameters<typeof provider.quoteOptions>[0] = {
        pickupAddress: b.address,
        pickupLat,
        pickupLng,
        dropoffAddress: dropoff,
      };
      if (body.dropoff_lat !== undefined) input.dropoffLat = body.dropoff_lat;
      if (body.dropoff_lng !== undefined) input.dropoffLng = body.dropoff_lng;
      const q = await provider.quoteOptions(input);
      if (q.options.length === 0) {
        return empty("No couriers cover this address right now — no delivery charge applied.", true);
      }
      // Stash the option set + validated address so create-order can verify the
      // chosen option and persist the address_code for dispatch. Fails open if
      // Redis is unavailable.
      await storeOptionSet(
        q.quoteToken,
        {
          provider: provider.name,
          branch_id: body.branch_id,
          dropoff_address: dropoff,
          options: q.options.map((o) => ({ id: o.id, fee_ngn: o.feeNgn })),
          ...(q.validatedAddress
            ? {
                address_code: q.validatedAddress.addressCode,
                address_formatted: q.validatedAddress.formatted,
              }
            : {}),
          expires_at: Date.now() + q.expiresInSeconds * 1000,
        },
        q.expiresInSeconds,
      );
      return c.json({
        data: {
          provider: provider.name,
          quote_token: q.quoteToken,
          expires_in_seconds: q.expiresInSeconds,
          address_valid: true,
          validated_address: q.validatedAddress
            ? { formatted: q.validatedAddress.formatted, lat: q.validatedAddress.lat, lng: q.validatedAddress.lng }
            : null,
          options: q.options.map((o) => ({
            id: o.id,
            courier_name: o.courierName,
            fee_ngn: o.feeNgn,
            eta_minutes: o.etaMinutes,
            on_demand: o.onDemand,
          })),
        },
      });
    } catch (err) {
      // Address couldn't be validated, or provider down — no couriers.
      const msg = err instanceof Error ? err.message : String(err);
      const notice = /address\/validate|couldn't validate|provide a clear/i.test(msg)
        ? "We couldn't confirm this address for delivery. Pick a suggestion, or add your area, city and state."
        : "Live delivery is unavailable right now — please try again.";
      return empty(notice);
    }
  });

  /**
   * Create an online order — anonymous (no session). Reserves stock, returns
   * the new order id + a Payaza checkout URL. If the device drops out before
   * paying, the reservation expires and the bottles return to inventory.
   */
  r.post("/", async (c) => {
    const body = CreateOnlineOrder.parse(await c.req.json());
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) {
      throw new BusinessError("validation_failed", "idempotency-key header required", 400);
    }

    // Bot check (Cloudflare Turnstile). No-op unless TURNSTILE_SECRET is set, and
    // fails open on a Cloudflare outage — see verifyTurnstileToken.
    const human = await verifyTurnstileToken(
      env.TURNSTILE_SECRET,
      body.turnstile_token,
      c.req.header("cf-connecting-ip") ?? undefined,
    );
    if (!human) {
      throw new BusinessError("validation_failed", "Bot check failed — please retry.", 400);
    }

    // Validate scheduled_delivery_at: must be a valid ISO datetime and must be
    // in the future. We parse as a plain string in Zod (so a ZodError → 400
    // path is avoided) and do an explicit check here to return 422.
    if (body.scheduled_delivery_at !== undefined) {
      const scheduledMs = Date.parse(body.scheduled_delivery_at);
      if (isNaN(scheduledMs)) {
        throw new BusinessError(
          "validation_failed",
          "scheduled_delivery_at must be a valid ISO datetime",
          422,
        );
      }
      if (scheduledMs <= Date.now()) {
        throw new BusinessError(
          "validation_failed",
          "scheduled_delivery_at must be in the future",
          422,
        );
      }
    }

    const [b] = await db.select().from(branch).where(eq(branch.id, body.branch_id));
    if (!b) {
      throw new BusinessError("validation_failed", "invalid branch", 422);
    }
    const outsideLagos = isOutsideLagos(body.delivery_state);
    const scheduled = body.scheduled_delivery_at != null;
    // Delivery is only charged for an immediate, in-Lagos order — the only case
    // we dispatch a rider now (mirrors the Bolt-dispatch bypass below). Even
    // then it must come from a live, server-locked quote; we never fall back to
    // a manual zone fee. Scheduled / outside-Lagos orders are ₦0.
    let deliveryFeeFinal = 0;
    let deliveryQuoteRef: string | null = null;
    let deliveryAddressCode: string | null = null;
    let deliveryAddressFormatted: string | null = null;
    if (outsideLagos || scheduled) {
      deliveryFeeFinal = 0;
    } else if (body.delivery_quote_id) {
      // The customer picked a courier option. Verify it's one we offered, at
      // the fee we offered, then lock it + capture the validated address so
      // dispatch routes to exactly that point. The option id's first segment is
      // the quote token the option set is stored under.
      const quoteToken = body.delivery_quote_id.split("::")[0] ?? "";
      const set = await loadOptionSet(quoteToken);
      if (!set) {
        // Can't verify (Redis down or set expired) → don't charge rather than
        // reject a paying customer or trust an unverified fee.
        deliveryFeeFinal = 0;
      } else {
        const opt = set.options.find((o) => o.id === body.delivery_quote_id);
        if (opt && opt.fee_ngn === body.delivery_fee_ngn) {
          deliveryFeeFinal = opt.fee_ngn;
          deliveryQuoteRef = opt.id;
          deliveryAddressCode = set.address_code != null ? String(set.address_code) : null;
          deliveryAddressFormatted = set.address_formatted ?? null;
        } else {
          // An option/fee we never offered → tampering.
          throw new BusinessError("validation_failed", "delivery option not recognised", 422);
        }
      }
    } else {
      // No option chosen → delivery is not charged.
      deliveryFeeFinal = 0;
    }

    // Decide where the line items come from. Explicit items[] wins (tests,
    // legacy callers). Otherwise read the cookie-keyed cart.
    const lineSource =
      body.items && body.items.length > 0
        ? body.items
        : await takeCartAsOrderItems(db, c);
    if (!lineSource || lineSource.length === 0) {
      throw new BusinessError("validation_failed", "cart is empty", 422);
    }

    const created = await db.transaction(async (tx) => {
      const normalizedPhone = normalizeNigerianPhone(body.customer.phone);
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
      const customerId = await resolveCustomer(tx, {
        name: body.customer.name,
        phone: normalizedPhone,
        email: body.customer.email ?? null,
        defaultAddress: body.customer.address,
        source: "online",
      });
      if (!customerId) throw new BusinessError("internal_error", "customer resolve failed", 500);

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

      for (const it of lineSource) {
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
          branchId: body.branch_id,
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
      const lineKinds = lines.map((l) => ({ sizeMl: l.sizeMl, inStock: l.inStock }));
      const scheduleNow = new Date();
      const schedResult = orderSchedule(scheduleNow, lineKinds);
      // Honor the customer's preferred window ONLY when it is valid for the
      // computed schedule: it must equal fixedWindow (for fixed schedules) or
      // be present in selectableWindows (for selectable schedules). Any other
      // value — including undefined — falls back to the server default.
      const requested = body.delivery_window;
      const isValidWindow =
        requested != null &&
        (schedResult.fixedWindow
          ? requested === schedResult.fixedWindow
          : schedResult.selectableWindows.includes(requested));
      const chosenWindow: DeliveryWindow = isValidWindow
        ? requested!
        : (schedResult.fixedWindow ?? schedResult.selectableWindows[0] ?? "morning");
      const scheduledDeliveryAt = new Date(scheduledIso(schedResult.date, chosenWindow));

      const total = subtotal + deliveryFeeFinal;
      const orderNumber = await nextOrderNumber(tx);
      const [o] = await tx
        .insert(saleOrder)
        .values({
          orderNumber,
          branchId: body.branch_id,
          channel: "online",
          customerId,
          status: "confirmed",
          isPreorder: orderIsPreorder,
          subtotalNgn: subtotal,
          deliveryFeeNgn: deliveryFeeFinal,
          totalNgn: total,
          paymentMethod: "card",
          paymentStatus: "pending",
          createdAtLocal: new Date(),
          idempotencyKey,
          scheduledDeliveryAt,
          deliveryState: body.delivery_state ?? null,
          deliveryQuoteRef,
          deliveryAddressCode,
          deliveryAddressFormatted,
          notes: body.notes ?? null,
          altPhone: body.customer.alt_phone ?? null,
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
            branchId: body.branch_id,
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
          customer_name: body.customer.name,
          customer_phone: normalizedPhone,
          scheduled_delivery_at: o.scheduledDeliveryAt
            ? o.scheduledDeliveryAt.toISOString()
            : null,
          delivery_state: o.deliveryState ?? null,
          items,
        },
      });
      return { order: o, customerEmail: body.customer.email ?? null };
    });

    // The order owns the cart contents now — empty the cart so a refresh
    // doesn't replay the same items into a second order.
    await clearCartForCookie(db, c);

    // Payaza checkout is a frontend SDK (no server redirect) — hand the customer
    // page the SDK init config. Payment is confirmed server-side by the
    // /v1/webhooks/payaza handler re-querying Payaza after the popup completes.
    const payaza = buildPayazaCheckoutConfig({
      amountNgn: created.order.totalNgn,
      email: created.customerEmail ?? "no-email@example.com",
      reference: created.order.orderNumber,
      customerName: body.customer.name,
      customerPhone: body.customer.phone,
    });

    return c.json(
      {
        data: {
          id: created.order.id,
          order_number: created.order.orderNumber,
          total_ngn: created.order.totalNgn,
          // True when any line is out of stock at the branch or is a
          // preorder-only size. The customer checkout uses this to show a
          // gracious "made to order — we'll WhatsApp you" confirmation before
          // payment. Authoritative: same flag the order was created with.
          is_preorder: created.order.isPreorder,
          payment: {
            provider: "payaza" as const,
            reference: payaza.reference,
            payaza,
          },
        },
      },
      201,
    );
  });

  /**
   * Public order tracking. Caller must supply the order number AND the phone
   * number on file — keeps drive-by lookups out of the picture.
   */
  r.get("/:orderNumber", async (c) => {
    const orderNumber = c.req.param("orderNumber");
    if (!orderNumber) throw new BusinessError("validation_failed", "orderNumber required", 400);
    const url = new URL(c.req.url);
    const q = TrackQuery.parse(Object.fromEntries(url.searchParams));

    let [o] = await db.select().from(saleOrder).where(eq(saleOrder.orderNumber, orderNumber));
    if (!o) throw new BusinessError("not_found", "order not found", 404);
    const [cust] = o.customerId
      ? await db.select().from(customer).where(eq(customer.id, o.customerId))
      : [null];
    if (!cust?.phone || !phonesMatch(cust.phone, q.phone)) {
      // Same response as not-found so an attacker can't enumerate orders by id.
      throw new BusinessError("not_found", "order not found", 404);
    }

    // On-view re-verify: a returning customer looking at an unpaid order is a
    // free chance to catch a webhook that never fired. Only worth asking
    // Payaza while the order is still unpaid (`confirmed`) AND its stock hold
    // is still live — once the reservation has expired the sweep/cron path
    // owns reconciliation, and paid/terminal/walk-up orders never reach here
    // with `confirmed`+a reservation anyway. Best-effort: a Payaza outage here
    // must not break the tracking page.
    if (o.channel === "online" && o.status === "confirmed" && !o.isPreorder) {
      const [liveResv] = await db
        .select({ expiresAt: stockReservation.expiresAt })
        .from(stockReservation)
        .where(eq(stockReservation.saleOrderId, o.id))
        .orderBy(asc(stockReservation.expiresAt))
        .limit(1);
      const reservationLive = liveResv?.expiresAt != null && liveResv.expiresAt.getTime() > Date.now();
      if (reservationLive) {
        try {
          await verifyAndReconcile(db, o.orderNumber);
        } catch (err) {
          logger.warn({ err, orderNumber: o.orderNumber }, "tracking on-view re-verify failed (non-fatal)");
        }
        // Re-read so the response reflects any flip the reconcile just made.
        // The row can't have disappeared between the two reads (no delete
        // path for sale orders) — re-assert non-null for TS.
        [o] = await db.select().from(saleOrder).where(eq(saleOrder.orderNumber, orderNumber));
        if (!o) throw new BusinessError("not_found", "order not found", 404);
      }
    }

    const { deliveryOrder } = await import("@ms/db");
    const { desc: descFn } = await import("drizzle-orm");
    const [delivery] = await db
      .select({
        status: deliveryOrder.status,
        riderName: deliveryOrder.riderName,
        riderPhone: deliveryOrder.riderPhone,
        riderVehicle: deliveryOrder.riderVehicle,
        trackingUrl: deliveryOrder.trackingUrl,
        etaMinutes: deliveryOrder.etaMinutes,
        deliveredAt: deliveryOrder.deliveredAt,
      })
      .from(deliveryOrder)
      .where(eq(deliveryOrder.saleOrderId, o.id))
      .orderBy(descFn(deliveryOrder.requestedAt))
      .limit(1);

    // Line items — flavour + size for the tracking screen's order summary.
    const itemRows = await db
      .select({
        name: product.name,
        sizeMl: productVariant.sizeMl,
        quantity: saleOrderItem.quantity,
        unitPriceNgn: saleOrderItem.unitPriceNgn,
        lineTotalNgn: saleOrderItem.lineTotalNgn,
      })
      .from(saleOrderItem)
      .leftJoin(product, eq(product.id, saleOrderItem.productId))
      .leftJoin(productVariant, eq(productVariant.id, saleOrderItem.variantId))
      .where(eq(saleOrderItem.saleOrderId, o.id));
    const items = itemRows.map((row) => ({
      name: row.name ?? "Item",
      size_ml: row.sizeMl ?? null,
      quantity: row.quantity,
      unit_price_ngn: row.unitPriceNgn,
      line_total_ngn: row.lineTotalNgn,
    }));

    // Latest paid-payment timestamp (if any).
    const [pay] = await db
      .select({ paidAt: payment.paidAt })
      .from(payment)
      .where(eq(payment.saleOrderId, o.id))
      .orderBy(descFn(payment.paidAt))
      .limit(1);

    // Earliest live reservation expiry — only meaningful while unpaid and not
    // a preorder (preorders never reserve stock up front).
    let reservationExpiresAt: string | null = null;
    if (o.status === "confirmed" && !o.isPreorder) {
      const [resv] = await db
        .select({ expiresAt: stockReservation.expiresAt })
        .from(stockReservation)
        .where(eq(stockReservation.saleOrderId, o.id))
        .orderBy(asc(stockReservation.expiresAt))
        .limit(1);
      reservationExpiresAt = resv?.expiresAt ? resv.expiresAt.toISOString() : null;
    }

    // Resume-payment config for an unpaid order — lets the customer relaunch
    // the Payaza popup without re-entering their details. Phone is already
    // verified above, so this is safe to hand back.
    let resumePayment: { reference: string; payaza: ReturnType<typeof buildPayazaCheckoutConfig> } | null =
      null;
    if (o.status === "confirmed") {
      const payaza = buildPayazaCheckoutConfig({
        amountNgn: o.totalNgn,
        email: cust.email ?? "no-email@example.com",
        reference: o.orderNumber,
        ...(cust.name ? { customerName: cust.name } : {}),
        ...(cust.phone ? { customerPhone: cust.phone } : {}),
      });
      resumePayment = { reference: payaza.reference, payaza };
    }

    // Support WhatsApp deep link (configured per deployment).
    const waNumber = env.SUPPORT_WHATSAPP;
    const supportWhatsapp = waNumber
      ? {
          number: waNumber,
          url: `https://wa.me/${waNumber.replace(/[^\d]/g, "")}?text=${encodeURIComponent(
            `Hi Mrs. Samuel, I'm checking on my order ${o.orderNumber}.`,
          )}`,
        }
      : null;

    return c.json({
      data: {
        order_number: o.orderNumber,
        status: o.status,
        payment_status: o.paymentStatus,
        total_ngn: o.totalNgn,
        subtotal_ngn: o.subtotalNgn,
        delivery_fee_ngn: o.deliveryFeeNgn,
        channel: o.channel,
        created_at: o.createdAt,
        scheduled_delivery_at: o.scheduledDeliveryAt
          ? o.scheduledDeliveryAt.toISOString()
          : null,
        delivery_state: o.deliveryState ?? null,
        delivery: delivery
          ? {
              status: delivery.status,
              rider_name: delivery.riderName,
              rider_phone: delivery.riderPhone,
              rider_vehicle: delivery.riderVehicle,
              tracking_url: delivery.trackingUrl,
              eta_minutes: delivery.etaMinutes,
              provider: "bolt" as const,
            }
          : null,
        items,
        is_preorder: o.isPreorder,
        fulfilled_at: o.fulfilledAt ? o.fulfilledAt.toISOString() : null,
        paid_at: pay?.paidAt ? pay.paidAt.toISOString() : null,
        out_for_delivery_at: o.outForDeliveryAt ? o.outForDeliveryAt.toISOString() : null,
        delivered_at: delivery?.deliveredAt ? delivery.deliveredAt.toISOString() : null,
        reservation_expires_at: reservationExpiresAt,
        resume_payment: resumePayment,
        support_whatsapp: supportWhatsapp,
      },
    });
  });

  return r;
}

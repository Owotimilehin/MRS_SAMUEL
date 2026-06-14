import { Hono } from "hono";
import { z } from "zod";
import { eq, and, desc, asc, isNull } from "drizzle-orm";
import {
  saleOrder,
  saleOrderItem,
  outboxEvent,
  productPrice,
  productVariant,
  customer,
  stockReservation,
  branch,
  type DbClient,
} from "@ms/db";
import { availableAtBranch, nextOrderNumber } from "@ms/domain";
import { normalizeNigerianPhone, phonesMatch, isOutsideLagos } from "@ms/shared";
import { rateLimit } from "../middleware/rate-limit.js";
import { BusinessError } from "../lib/errors.js";
import { createOpaySession } from "../payments/opay.js";
import { resolveCustomer } from "../lib/customers.js";
import { getDeliveryProvider } from "../delivery/index.js";
import { storeOptionSet, loadOptionSet } from "../delivery/quote-store.js";
import { takeCartAsOrderItems, clearCartForCookie } from "./public-cart.js";
import { verifyTurnstileToken } from "../lib/turnstile.js";
import { env } from "../env.js";

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

    if (pickupLat == null || pickupLng == null || !b.address) {
      // No pickup coords on file — cannot get live options. Delivery ₦0.
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
   * the new order id + an OPay checkout URL. If the device drops out before
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
      // A line is a preorder line when its variant is preorder_only OR the branch
      // is currently out of stock for it. Any preorder line makes the whole order
      // a preorder: it skips reservations now and defers the stock deduction to
      // fulfilment (see preorders.ts), but still requires payment.
      let orderIsPreorder = false;
      const lines: {
        productId: string;
        variantId: string;
        priceId: string;
        quantity: number;
        unit: number;
      }[] = [];

      for (const it of lineSource) {
        // Resolve to a concrete variant: prefer the explicit variant_id, else
        // the smallest can for the given product_id (legacy callers).
        // The cart-derived path always carries variant_id, so product_id may
        // be undefined.
        const itAny = it as { variant_id?: string; product_id?: string; quantity: number };
        let variantId: string | undefined = itAny.variant_id;
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
          preorderOnly = v.preorderOnly;
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
        const available = await availableAtBranch(tx, {
          branchId: body.branch_id,
          productId,
        });
        // Out of stock no longer blocks — it becomes a preorder line (made to
        // order, fulfilled later). preorder_only variants are always preorders.
        if (preorderOnly || available < it.quantity) {
          orderIsPreorder = true;
        }
        lines.push({
          productId,
          variantId,
          priceId: p.id,
          quantity: it.quantity,
          unit: p.priceNgn,
        });
        subtotal += p.priceNgn * it.quantity;
      }
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
          scheduledDeliveryAt: body.scheduled_delivery_at
            ? new Date(body.scheduled_delivery_at)
            : null,
          deliveryState: body.delivery_state ?? null,
          deliveryQuoteRef,
          deliveryAddressCode,
          deliveryAddressFormatted,
          notes: body.notes ?? null,
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
        },
      });
      return { order: o, customerEmail: body.customer.email ?? null };
    });

    // Initiate the OPay Cashier session (or mock URL in dev). PUBLIC_CUSTOMER_URL
    // wins when set; the admin→www substitution is a legacy fallback for prod
    // where customer + admin share a domain root.
    // The order owns the cart contents now — empty the cart so a refresh
    // doesn't replay the same items into a second order.
    await clearCartForCookie(db, c);

    const customerBase =
      env.PUBLIC_CUSTOMER_URL ?? env.PUBLIC_ADMIN_URL.replace("admin.", "www.");
    // returnUrl = where OPay sends the customer's browser back to; callbackUrl =
    // the server-to-server webhook that actually confirms payment.
    const returnUrl = `${customerBase}/order/${created.order.orderNumber}?paid=1`;
    const session = await createOpaySession({
      amountNgn: created.order.totalNgn,
      email: created.customerEmail ?? "no-email@example.com",
      reference: created.order.orderNumber,
      returnUrl,
      callbackUrl: `${env.PUBLIC_API_URL}/v1/webhooks/opay`,
      productName: `Mrs. Samuel order ${created.order.orderNumber}`,
    });

    return c.json(
      {
        data: {
          id: created.order.id,
          order_number: created.order.orderNumber,
          total_ngn: created.order.totalNgn,
          payment: {
            authorization_url: session.authorization_url,
            reference: session.reference,
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

    const [o] = await db.select().from(saleOrder).where(eq(saleOrder.orderNumber, orderNumber));
    if (!o) throw new BusinessError("not_found", "order not found", 404);
    const [cust] = o.customerId
      ? await db.select().from(customer).where(eq(customer.id, o.customerId))
      : [null];
    if (!cust?.phone || !phonesMatch(cust.phone, q.phone)) {
      // Same response as not-found so an attacker can't enumerate orders by id.
      throw new BusinessError("not_found", "order not found", 404);
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
      })
      .from(deliveryOrder)
      .where(eq(deliveryOrder.saleOrderId, o.id))
      .orderBy(descFn(deliveryOrder.requestedAt))
      .limit(1);

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
      },
    });
  });

  return r;
}

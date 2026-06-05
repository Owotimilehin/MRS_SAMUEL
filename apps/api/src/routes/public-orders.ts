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
import { getDeliveryProvider } from "../delivery/index.js";
import { storeQuote, loadQuote } from "../delivery/quote-store.js";
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
});

const TrackQuery = z.object({
  phone: z.string().min(7),
});

export function publicOrderRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", rateLimit({ points: 30, durationSeconds: 60, keyPrefix: "public-orders" }));

  /**
   * Live delivery-fee quote. Customer's checkout calls this as the address
   * settles. Falls back to the static branch zone fee if Bolt is unhappy so
   * the customer can still complete the order.
   */
  r.post("/quote", async (c) => {
    const body = QuoteRequest.parse(await c.req.json());
    const [b] = await db.select().from(branch).where(eq(branch.id, body.branch_id));
    if (!b || !b.isActive || b.deletedAt) {
      throw new BusinessError("not_found", "branch not found", 404);
    }
    const pickupLat = b.lat != null ? Number(b.lat) : null;
    const pickupLng = b.lng != null ? Number(b.lng) : null;
    if (pickupLat == null || pickupLng == null || !b.address) {
      // No pickup coords on file — cannot get a real quote; surface the
      // cheapest static zone fee as a safe fallback.
      const minZone = b.deliveryZones.reduce<number | null>(
        (acc, z) => (acc == null || z.fee_ngn < acc ? z.fee_ngn : acc),
        null,
      );
      return c.json({
        data: {
          provider: "fallback" as const,
          provider_quote_id: null,
          fee_ngn: minZone ?? 1500,
          eta_minutes: 30,
          notice: "Branch coordinates not configured — showing default zone fee.",
        },
      });
    }

    const provider = getDeliveryProvider();
    try {
      const input: Parameters<typeof provider.quote>[0] = {
        pickupAddress: b.address,
        pickupLat,
        pickupLng,
        dropoffAddress: body.dropoff_address,
      };
      if (body.dropoff_lat !== undefined) input.dropoffLat = body.dropoff_lat;
      if (body.dropoff_lng !== undefined) input.dropoffLng = body.dropoff_lng;
      const q = await provider.quote(input);
      // Stash the quote so the create-order endpoint can verify the customer
      // didn't tamper with the fee. Fails open if Redis is unavailable.
      await storeQuote(
        q.providerQuoteId,
        {
          provider: provider.name,
          branch_id: body.branch_id,
          fee_ngn: q.feeNgn,
          dropoff_address: body.dropoff_address,
          expires_at: Date.now() + q.expiresInSeconds * 1000,
        },
        q.expiresInSeconds,
      );
      return c.json({
        data: {
          provider: provider.name,
          provider_quote_id: q.providerQuoteId,
          fee_ngn: q.feeNgn,
          eta_minutes: q.etaMinutes,
          expires_in_seconds: q.expiresInSeconds,
          ...(q.notice ? { notice: q.notice } : {}),
        },
      });
    } catch (err) {
      // Provider down or address not geocodable — fall back to the cheapest
      // static zone fee so the customer can still complete checkout.
      const minZone = b.deliveryZones.reduce<number | null>(
        (acc, z) => (acc == null || z.fee_ngn < acc ? z.fee_ngn : acc),
        null,
      );
      const msg = err instanceof Error ? err.message : String(err);
      // A 400 on address/validate means the address was too vague to geocode.
      // Surface a helpful, customer-facing hint rather than the raw API path.
      const notice = /address\/validate.*400/.test(msg)
        ? "We couldn't confirm live delivery for that address. Add a street number, area and city (e.g. “12 Admiralty Way, Lekki, Lagos”). Standard delivery fee applied for now."
        : "Live delivery pricing is unavailable right now — standard delivery fee applied.";
      return c.json({
        data: {
          provider: "fallback" as const,
          provider_quote_id: null,
          fee_ngn: minZone ?? 1500,
          eta_minutes: 35,
          notice,
        },
      });
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
    // Outside Lagos has no Bolt last-mile: delivery is ₦0, arranged out-of-band.
    let deliveryFeeFinal = body.delivery_fee_ngn;
    if (outsideLagos) {
      // No Bolt last-mile outside Lagos — delivery is ₦0, arranged out-of-band.
      deliveryFeeFinal = 0;
    } else if (body.delivery_quote_id) {
      // A locked live quote wins; otherwise the fee must match a configured
      // zone fee (the static fallback the customer was shown).
      const stored = await loadQuote(body.delivery_quote_id);
      if (stored && stored.fee_ngn === body.delivery_fee_ngn) {
        deliveryFeeFinal = stored.fee_ngn;
      } else if (b.deliveryZones.some((z) => z.fee_ngn === body.delivery_fee_ngn)) {
        deliveryFeeFinal = body.delivery_fee_ngn;
      } else {
        throw new BusinessError("validation_failed", "delivery fee not recognised", 422);
      }
    } else if (b.deliveryZones.some((z) => z.fee_ngn === body.delivery_fee_ngn)) {
      deliveryFeeFinal = body.delivery_fee_ngn;
    } else {
      throw new BusinessError("validation_failed", "delivery fee not recognised", 422);
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
      const [cust] = await tx
        .insert(customer)
        .values({
          name: body.customer.name,
          phone: normalizedPhone,
          email: body.customer.email ?? null,
          defaultAddress: body.customer.address,
          source: "online",
        })
        .returning();
      if (!cust) throw new BusinessError("internal_error", "customer insert failed", 500);

      let subtotal = 0;
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
        if (variantId) {
          const [v] = await tx
            .select()
            .from(productVariant)
            .where(and(eq(productVariant.id, variantId), isNull(productVariant.deletedAt)));
          if (!v) {
            throw new BusinessError("not_found", `variant ${variantId} not found`, 404);
          }
          productId = v.productId;
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
          customerId: cust.id,
          status: "confirmed",
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
        await tx.insert(stockReservation).values({
          saleOrderId: o.id,
          branchId: body.branch_id,
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
          expiresAt,
        });
      }
      // Tell the owner (and anyone else subscribed) that a new online order
      // just landed and is waiting on payment.
      await tx.insert(outboxEvent).values({
        eventType: "sale.online_placed",
        payload: {
          sale_order_id: o.id,
          order_number: o.orderNumber,
          total_ngn: total,
          customer_name: cust.name,
          customer_phone: cust.phone,
          scheduled_delivery_at: o.scheduledDeliveryAt
            ? o.scheduledDeliveryAt.toISOString()
            : null,
          delivery_state: o.deliveryState ?? null,
        },
      });
      return { order: o, customerEmail: cust.email };
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

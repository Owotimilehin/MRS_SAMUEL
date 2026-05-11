import { Hono } from "hono";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import {
  saleOrder,
  saleOrderItem,
  productPrice,
  customer,
  stockReservation,
  branch,
  type DbClient,
} from "@ms/db";
import { availableAtBranch, nextOrderNumber } from "@ms/domain";
import { rateLimit } from "../middleware/rate-limit.js";
import { BusinessError } from "../lib/errors.js";
import { createPayazaSession } from "../payments/payaza.js";
import { env } from "../env.js";

const CreateOnlineOrder = z.object({
  branch_id: z.string().uuid(),
  zone_name: z.string().min(1),
  delivery_fee_ngn: z.number().int().nonnegative(),
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().min(7),
    email: z.string().email().optional(),
    address: z.string().min(3),
  }),
  items: z
    .array(z.object({ product_id: z.string().uuid(), quantity: z.number().int().positive() }))
    .min(1),
  notes: z.string().optional(),
});

const TrackQuery = z.object({
  phone: z.string().min(7),
});

export function publicOrderRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", rateLimit({ points: 30, durationSeconds: 60, keyPrefix: "public-orders" }));

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

    const [b] = await db.select().from(branch).where(eq(branch.id, body.branch_id));
    if (
      !b ||
      !b.deliveryZones.some(
        (z) => z.name === body.zone_name && z.fee_ngn === body.delivery_fee_ngn,
      )
    ) {
      throw new BusinessError("validation_failed", "invalid delivery zone", 422);
    }

    const created = await db.transaction(async (tx) => {
      const [cust] = await tx
        .insert(customer)
        .values({
          name: body.customer.name,
          phone: body.customer.phone,
          email: body.customer.email ?? null,
          defaultAddress: body.customer.address,
          source: "online",
        })
        .returning();
      if (!cust) throw new BusinessError("internal_error", "customer insert failed", 500);

      let subtotal = 0;
      const lines: {
        productId: string;
        priceId: string;
        quantity: number;
        unit: number;
      }[] = [];

      for (const it of body.items) {
        const [p] = await tx
          .select()
          .from(productPrice)
          .where(eq(productPrice.productId, it.product_id))
          .orderBy(desc(productPrice.validFrom))
          .limit(1);
        if (!p) {
          throw new BusinessError("not_found", `no price for product ${it.product_id}`, 404);
        }
        const available = await availableAtBranch(tx, {
          branchId: body.branch_id,
          productId: it.product_id,
        });
        if (available < it.quantity) {
          throw new BusinessError("conflict", "insufficient stock", 422, {
            product_id: it.product_id,
            available,
            requested: it.quantity,
          });
        }
        lines.push({
          productId: it.product_id,
          priceId: p.id,
          quantity: it.quantity,
          unit: p.priceNgn,
        });
        subtotal += p.priceNgn * it.quantity;
      }
      const total = subtotal + body.delivery_fee_ngn;
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
          deliveryFeeNgn: body.delivery_fee_ngn,
          totalNgn: total,
          paymentMethod: "card",
          paymentStatus: "pending",
          createdAtLocal: new Date(),
          idempotencyKey,
          notes: body.notes ?? null,
        })
        .returning();
      if (!o) throw new BusinessError("internal_error", "order insert failed", 500);

      const expiresAt = new Date(Date.now() + 30 * 60_000); // 30-min hold for online
      for (const l of lines) {
        await tx.insert(saleOrderItem).values({
          saleOrderId: o.id,
          productId: l.productId,
          productPriceId: l.priceId,
          quantity: l.quantity,
          unitPriceNgn: l.unit,
          lineTotalNgn: l.unit * l.quantity,
        });
        await tx.insert(stockReservation).values({
          saleOrderId: o.id,
          branchId: body.branch_id,
          productId: l.productId,
          quantity: l.quantity,
          expiresAt,
        });
      }
      return { order: o, customerEmail: cust.email };
    });

    // Initiate Payaza session (or mock URL in dev)
    const callbackUrl = `${env.PUBLIC_ADMIN_URL.replace("admin.", "www.")}/order/${created.order.orderNumber}/track`;
    const session = await createPayazaSession({
      amountNgn: created.order.totalNgn,
      email: created.customerEmail ?? "no-email@example.com",
      reference: created.order.orderNumber,
      callbackUrl,
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
    if (!cust?.phone || cust.phone !== q.phone) {
      // Same response as not-found so an attacker can't enumerate orders by id.
      throw new BusinessError("not_found", "order not found", 404);
    }
    return c.json({
      data: {
        order_number: o.orderNumber,
        status: o.status,
        payment_status: o.paymentStatus,
        total_ngn: o.totalNgn,
        channel: o.channel,
        created_at: o.createdAt,
      },
    });
  });

  return r;
}

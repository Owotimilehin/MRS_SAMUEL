import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { saleOrder, deliveryOrder, branch, customer, type DbClient } from "@ms/db";
import { requireAuth, requireCapability, requireAnyCapability } from "../middleware/auth.js";
import { requireBranchScope } from "../middleware/scope.js";
import { BusinessError } from "../lib/errors.js";
import { getDeliveryProvider } from "../delivery/index.js";

/**
 * Admin-facing delivery actions for a single online order. Mounted under
 * /v1/branches/:branchId/sales/:saleId/delivery. Rides are booked manually
 * (auto-dispatch is off) using the address/phone/name the customer provided
 * at checkout. Delivery is ₦0 to the customer; the courier fee shown here is
 * what the admin quotes the customer over WhatsApp.
 */
export function deliveryAdminRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireBranchScope());

  // Resolve the order + its pickup branch + customer contact, or throw.
  async function load(saleId: string) {
    const [o] = await db.select().from(saleOrder).where(eq(saleOrder.id, saleId));
    if (!o) throw new BusinessError("not_found", "order not found", 404);
    if (o.channel === "walkup") {
      throw new BusinessError("conflict", "delivery is only for online orders", 409);
    }
    const [b] = await db.select().from(branch).where(eq(branch.id, o.branchId));
    if (!b || !b.address) {
      throw new BusinessError("conflict", "pickup branch has no address on file", 409);
    }
    let custName = "Customer";
    let custPhone = "";
    // deliveryAddressFormatted is the geocoder-validated address captured at
    // quote time; fall back to customer's stored default address.
    let custAddress = o.deliveryAddressFormatted ?? "";
    if (o.customerId) {
      const [cust] = await db.select().from(customer).where(eq(customer.id, o.customerId));
      if (cust) {
        custName = cust.name ?? custName;
        custPhone = cust.phone ?? "";
        custAddress = o.deliveryAddressFormatted ?? cust.defaultAddress ?? "";
      }
    }
    if (!custAddress || !custPhone) {
      throw new BusinessError("conflict", "order is missing a delivery address or phone", 409);
    }
    // Mirror the storefront's address completion so geocoding succeeds.
    const dropoff = normalizeDropoff(custAddress, o.deliveryState ?? undefined);
    return { o, b, custName, custPhone, dropoff };
  }

  // GET options — live courier rates for this route.
  r.get("/options", requireCapability("sales.view"), async (c) => {
    const saleId = c.req.param("saleId");
    if (!saleId) throw new BusinessError("validation_failed", "saleId required", 400);
    const { b, dropoff } = await load(saleId);
    const provider = getDeliveryProvider();
    const q = await provider.quoteOptions({
      pickupAddress: b.address as string,
      pickupLat: b.lat != null ? Number(b.lat) : null,
      pickupLng: b.lng != null ? Number(b.lng) : null,
      dropoffAddress: dropoff,
    });
    return c.json({
      data: {
        quote_token: q.quoteToken,
        receiver_address_code: q.validatedAddress?.addressCode ?? null,
        options: q.options.map((o) => ({
          id: o.id,
          courier_name: o.courierName,
          fee_ngn: o.feeNgn,
          eta_minutes: o.etaMinutes,
        })),
      },
    });
  });

  // POST book — create the label, persist the delivery_order.
  r.post("/book", requireAnyCapability("orders.manage", "pos.sell"), async (c) => {
    const saleId = c.req.param("saleId");
    if (!saleId) throw new BusinessError("validation_failed", "saleId required", 400);
    const body = (await c.req.json()) as {
      option_id?: string;
      fee_ngn?: number;
      receiver_address_code?: number;
    };
    if (!body.option_id) throw new BusinessError("validation_failed", "option_id required", 400);
    const feeNgn = Number.isFinite(body.fee_ngn) ? Math.round(body.fee_ngn as number) : 0;

    const { o, b, custName, custPhone, dropoff } = await load(saleId);

    // Idempotency: refuse if a live (non-cancelled) delivery already exists.
    const [existing] = await db
      .select({ id: deliveryOrder.id, status: deliveryOrder.status })
      .from(deliveryOrder)
      .where(eq(deliveryOrder.saleOrderId, o.id))
      .orderBy(desc(deliveryOrder.requestedAt))
      .limit(1);
    if (existing && existing.status !== "cancelled") {
      throw new BusinessError("conflict", "a delivery already exists for this order", 409);
    }

    const provider = getDeliveryProvider();
    const result = await provider.requestDelivery({
      saleOrderId: o.id,
      orderNumber: o.orderNumber,
      providerQuoteId: body.option_id,
      pickupAddress: b.address as string,
      pickupLat: b.lat != null ? Number(b.lat) : 0,
      pickupLng: b.lng != null ? Number(b.lng) : 0,
      dropoffAddress: dropoff,
      customerName: custName,
      customerPhone: custPhone,
      ...(body.receiver_address_code != null
        ? { receiverAddressCode: body.receiver_address_code }
        : {}),
    });

    const [row] = await db
      .insert(deliveryOrder)
      .values({
        saleOrderId: o.id,
        provider: provider.name,
        externalRef: result.externalRef,
        pickupBranchId: b.id,
        pickupAddress: b.address as string,
        pickupLat: b.lat,
        pickupLng: b.lng,
        dropoffAddress: dropoff,
        quotedFeeNgn: feeNgn,
        etaMinutes: result.initialEtaMinutes,
        trackingUrl: result.trackingUrl,
        status: "searching_rider",
      })
      .returning();

    await db
      .update(saleOrder)
      .set({ deliveryProviderRef: result.externalRef, updatedAt: new Date() })
      .where(eq(saleOrder.id, o.id));

    return c.json({ data: row });
  });

  // POST cancel — cancel the latest live delivery.
  r.post("/cancel", requireAnyCapability("orders.manage", "pos.sell"), async (c) => {
    const saleId = c.req.param("saleId");
    if (!saleId) throw new BusinessError("validation_failed", "saleId required", 400);
    // Enforce the same guards as /options and /book: order must exist and must
    // be an online order (not a walk-up till sale).
    const { o } = await load(saleId);
    const [row] = await db
      .select()
      .from(deliveryOrder)
      .where(eq(deliveryOrder.saleOrderId, o.id))
      .orderBy(desc(deliveryOrder.requestedAt))
      .limit(1);
    if (!row || !row.externalRef) {
      throw new BusinessError("not_found", "no delivery to cancel", 404);
    }
    if (row.status === "cancelled") return c.json({ data: { status: "cancelled" } });
    const provider = getDeliveryProvider();
    await provider.cancelDelivery(row.externalRef);
    const now = new Date();
    await db
      .update(deliveryOrder)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(eq(deliveryOrder.id, row.id));
    return c.json({ data: { status: "cancelled" } });
  });

  return r;
}

/**
 * Shipbubble's validator needs a complete address string (street, area, state,
 * country). Append the delivery state + "Nigeria" when missing — mirrors the
 * storefront's normalizeDropoff so admin bookings geocode as well as the
 * customer preview did.
 */
function normalizeDropoff(addr: string, state?: string): string {
  const a = addr.trim().replace(/,\s*$/, "");
  if (/nigeria/i.test(a)) return a;
  const st = state && state.trim() ? state.trim() : "Lagos";
  return new RegExp(st, "i").test(a) ? `${a}, Nigeria` : `${a}, ${st}, Nigeria`;
}

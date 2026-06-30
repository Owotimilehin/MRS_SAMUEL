import { Hono } from "hono";
import { and, desc, eq, gt, inArray, max, count, sql } from "drizzle-orm";
import { saleOrder, deliveryOrder, customer, type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { BusinessError } from "../lib/errors.js";

/**
 * Read-only queue feed for online orders (channel=online|phone, status=paid|out_for_delivery).
 * Backs the owner/till queue screens, nav badge count, and new-order toast/chime.
 *
 * Mounted under /v1/online-orders (coexists with paymentsAdminRoutes at same prefix —
 * Hono matches both sub-apps).
 *
 * Auth: requireAuth() + requireCapability("sales.view").
 * Branch scoping: branch_staff see only their own branch; owner/admin/manager see all.
 */
export function onlineOrdersQueueRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireCapability("sales.view"));

  const ACTIVE_CHANNELS = ["online", "phone"] as const;
  const ACTIVE_STATUSES = ["paid", "out_for_delivery"] as const;

  /**
   * GET /active
   * Returns all active online/phone orders, newest first.
   * Response: { data: Array<{ id, order_number, branch_id, status, channel, total_ngn,
   *   created_at_local, customer_name, customer_phone, is_delivery, delivery_status }> }
   */
  r.get("/active", async (c) => {
    const auth = c.get("auth");
    const branchScoped = auth.role === "branch_staff" ? auth.branchId : null;

    // Base filter: active channel + active status
    const baseWhere = and(
      inArray(saleOrder.channel, [...ACTIVE_CHANNELS]),
      inArray(saleOrder.status, [...ACTIVE_STATUSES]),
      branchScoped ? eq(saleOrder.branchId, branchScoped) : undefined,
    );

    // Fetch active orders with optional customer join
    const orders = await db
      .select({
        id: saleOrder.id,
        orderNumber: saleOrder.orderNumber,
        branchId: saleOrder.branchId,
        status: saleOrder.status,
        channel: saleOrder.channel,
        totalNgn: saleOrder.totalNgn,
        createdAtLocal: saleOrder.createdAtLocal,
        deliveryFeeNgn: saleOrder.deliveryFeeNgn,
        deliveryAddressFormatted: saleOrder.deliveryAddressFormatted,
        deliveryState: saleOrder.deliveryState,
        scheduledDeliveryAt: saleOrder.scheduledDeliveryAt,
        isPreorder: saleOrder.isPreorder,
        producedAt: saleOrder.producedAt,
        customerId: saleOrder.customerId,
        customerName: customer.name,
        customerPhone: customer.phone,
      })
      .from(saleOrder)
      .leftJoin(customer, eq(saleOrder.customerId, customer.id))
      .where(baseWhere)
      .orderBy(desc(saleOrder.createdAtLocal));

    if (orders.length === 0) {
      return c.json({ data: [] });
    }

    // Fetch latest delivery_order status for each sale (one query, not N+1)
    const orderIds = orders.map((o) => o.id);
    // Get the latest delivery_order per sale_order_id using a lateral approach:
    // select the row with the highest requestedAt per saleOrderId.
    const latestDeliveries = await db
      .selectDistinctOn([deliveryOrder.saleOrderId], {
        saleOrderId: deliveryOrder.saleOrderId,
        status: deliveryOrder.status,
      })
      .from(deliveryOrder)
      .where(inArray(deliveryOrder.saleOrderId, orderIds))
      .orderBy(deliveryOrder.saleOrderId, desc(deliveryOrder.requestedAt));

    const deliveryStatusMap = new Map(
      latestDeliveries.map((d) => [d.saleOrderId, d.status]),
    );

    const data = orders.map((o) => {
      const latestDeliveryStatus = deliveryStatusMap.get(o.id) ?? null;
      const isDelivery =
        !!o.deliveryAddressFormatted ||
        !!o.deliveryState ||
        (o.deliveryFeeNgn ?? 0) > 0 ||
        latestDeliveryStatus !== null;

      const stage: "awaiting_production" | "ready" | "out_for_delivery" =
        o.status === "out_for_delivery"
          ? "out_for_delivery"
          : o.isPreorder && o.producedAt == null
            ? "awaiting_production"
            : "ready";

      return {
        id: o.id,
        order_number: o.orderNumber,
        branch_id: o.branchId,
        status: o.status,
        channel: o.channel,
        total_ngn: o.totalNgn,
        created_at_local: o.createdAtLocal,
        customer_name: o.customerName ?? null,
        customer_phone: o.customerPhone ?? null,
        delivery_state: o.deliveryState ?? null,
        scheduled_delivery_at: o.scheduledDeliveryAt ?? null,
        is_preorder: o.isPreorder,
        produced_at: o.producedAt ? (o.producedAt as Date).toISOString() : null,
        stage,
        is_delivery: isDelivery,
        delivery_status: latestDeliveryStatus,
      };
    });

    return c.json({ data });
  });

  /**
   * GET /active-count?since=<ISO>
   * Returns aggregate counts for badge/toast polling.
   * Response: { data: { count, newest, new_since } }
   * - count: total active orders awaiting fulfilment
   * - newest: max created_at_local (ISO string or null)
   * - new_since: how many active orders were created after `since`
   */
  r.get("/active-count", async (c) => {
    const auth = c.get("auth");
    const branchScoped = auth.role === "branch_staff" ? auth.branchId : null;
    const sinceParam = c.req.query("since");

    let sinceDate: Date | null = null;
    if (sinceParam) {
      sinceDate = new Date(sinceParam);
      if (isNaN(sinceDate.getTime())) {
        throw new BusinessError("validation_failed", "invalid since parameter", 400);
      }
    }

    const baseWhere = and(
      inArray(saleOrder.channel, [...ACTIVE_CHANNELS]),
      inArray(saleOrder.status, [...ACTIVE_STATUSES]),
      branchScoped ? eq(saleOrder.branchId, branchScoped) : undefined,
    );

    // Single aggregation query: count, max(created_at_local), count(> since)
    const [agg] = await db
      .select({
        count: count(),
        newest: max(saleOrder.createdAtLocal),
        new_since: sinceDate
          ? sql<number>`count(*) filter (where ${saleOrder.createdAtLocal} > ${sinceDate.toISOString()}::timestamptz)`
          : sql<number>`0`,
      })
      .from(saleOrder)
      .where(baseWhere);

    return c.json({
      data: {
        count: agg ? Number(agg.count) : 0,
        newest: agg?.newest ? (agg.newest as Date).toISOString() : null,
        new_since: agg ? Number(agg.new_since) : 0,
      },
    });
  });

  return r;
}

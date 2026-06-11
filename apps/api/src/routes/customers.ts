import { Hono } from "hono";
import { eq, and, sql, desc, isNull, notInArray } from "drizzle-orm";
import { saleOrder, customer, type DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { BusinessError } from "../lib/errors.js";

// Orders that shouldn't count toward a customer's order tally / lifetime spend.
// The detail endpoint still lists them (with their status) so nothing is hidden.
const NON_COUNTING_STATUSES = ["cancelled", "failed"] as const;

export function customerRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());

  /**
   * Aggregated customer list — one row per customer with their order count,
   * lifetime spend, and most-recent order. Counts exclude cancelled/failed
   * orders. Backs the owner Customers screen (replacing the old client-side
   * fan-out over every branch's sales).
   */
  r.get("/", requireCapability("customers.view"), async (c) => {
    const rows = await db
      .select({
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        orders: sql<number>`COUNT(${saleOrder.id})::int`,
        lifetimeNgn: sql<number>`COALESCE(SUM(${saleOrder.totalNgn}), 0)::int`,
        lastOrderAt: sql<string>`MAX(${saleOrder.createdAtLocal})`,
        lastOrderNumber: sql<string>`(ARRAY_AGG(${saleOrder.orderNumber} ORDER BY ${saleOrder.createdAtLocal} DESC))[1]`,
      })
      .from(customer)
      .innerJoin(
        saleOrder,
        and(
          eq(saleOrder.customerId, customer.id),
          notInArray(saleOrder.status, [...NON_COUNTING_STATUSES]),
        ),
      )
      .where(isNull(customer.deletedAt))
      .groupBy(customer.id)
      .orderBy(desc(sql`MAX(${saleOrder.createdAtLocal})`));
    return c.json({ data: rows });
  });

  /**
   * One customer + their full order history, newest first. Orders include
   * cancelled/failed (shown with status) so staff see everything; lifetimeNgn
   * sums only the counting statuses to match the list.
   */
  r.get("/:id", requireCapability("customers.view"), async (c) => {
    const id = c.req.param("id");
    if (!id) throw new BusinessError("validation_failed", "id required", 400);
    const [cust] = await db.select().from(customer).where(eq(customer.id, id));
    if (!cust || cust.deletedAt) throw new BusinessError("not_found", "customer not found", 404);

    const orders = await db
      .select({
        id: saleOrder.id,
        orderNumber: saleOrder.orderNumber,
        channel: saleOrder.channel,
        status: saleOrder.status,
        paymentStatus: saleOrder.paymentStatus,
        totalNgn: saleOrder.totalNgn,
        createdAtLocal: saleOrder.createdAtLocal,
      })
      .from(saleOrder)
      .where(eq(saleOrder.customerId, id))
      .orderBy(desc(saleOrder.createdAtLocal));

    const lifetimeNgn = orders
      .filter((o) => !NON_COUNTING_STATUSES.includes(o.status as (typeof NON_COUNTING_STATUSES)[number]))
      .reduce((sum, o) => sum + o.totalNgn, 0);

    return c.json({ data: { customer: cust, orders, lifetimeNgn } });
  });

  return r;
}

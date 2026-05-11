import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { DbClient } from "@ms/db";
import { requireAuth, requireRole } from "../middleware/auth.js";

export function reportRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireRole("owner"));

  r.get("/revenue", async (c) => {
    const from =
      c.req.query("from") ??
      new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = c.req.query("to") ?? new Date().toISOString().slice(0, 10);
    const rows = await db.execute<{
      branch_id: string;
      channel: string;
      gross_ngn: number;
      refunds_ngn: number;
      net_ngn: number;
      orders: number;
    }>(sql`
      WITH sales AS (
        SELECT branch_id, channel, total_ngn, id
        FROM sale_order
        WHERE status IN ('paid','handed_over','delivered')
          AND created_at_local::date BETWEEN ${from}::date AND ${to}::date
      ),
      refunds AS (
        SELECT branch_id, refund_amount_ngn,
               (SELECT channel FROM sale_order WHERE id = original_sale_order_id) AS channel
        FROM sale_return
        WHERE status = 'completed'
          AND created_at::date BETWEEN ${from}::date AND ${to}::date
      )
      SELECT
        s.branch_id,
        s.channel,
        SUM(s.total_ngn)::int AS gross_ngn,
        COALESCE((SELECT SUM(r.refund_amount_ngn) FROM refunds r
                  WHERE r.branch_id = s.branch_id AND r.channel = s.channel), 0)::int AS refunds_ngn,
        (SUM(s.total_ngn) - COALESCE((SELECT SUM(r.refund_amount_ngn) FROM refunds r
                  WHERE r.branch_id = s.branch_id AND r.channel = s.channel), 0))::int AS net_ngn,
        COUNT(*)::int AS orders
      FROM sales s
      GROUP BY s.branch_id, s.channel
      ORDER BY net_ngn DESC
    `);
    return c.json({ data: rows });
  });

  r.get("/top-products", async (c) => {
    const limit = Number(c.req.query("limit") ?? 10);
    const from =
      c.req.query("from") ??
      new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = c.req.query("to") ?? new Date().toISOString().slice(0, 10);
    const rows = await db.execute<{
      product_id: string;
      product_name: string;
      quantity: number;
      revenue_ngn: number;
    }>(sql`
      SELECT i.product_id, p.name AS product_name,
             SUM(i.quantity)::int AS quantity,
             SUM(i.line_total_ngn)::int AS revenue_ngn
      FROM sale_order_item i
      JOIN sale_order o ON o.id = i.sale_order_id
      JOIN product p ON p.id = i.product_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date BETWEEN ${from}::date AND ${to}::date
      GROUP BY i.product_id, p.name
      ORDER BY revenue_ngn DESC
      LIMIT ${limit}
    `);
    return c.json({ data: rows });
  });

  r.get("/branch-stock", async (c) => {
    const rows = await db.execute<{
      branch_id: string;
      product_id: string;
      balance: number;
    }>(sql`
      SELECT location_id AS branch_id, product_id, COALESCE(SUM(delta), 0)::int AS balance
      FROM stock_ledger
      WHERE location_type = 'branch'
      GROUP BY location_id, product_id
    `);
    return c.json({ data: rows });
  });

  r.get("/variances", async (c) => {
    const from =
      c.req.query("from") ??
      new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const rows = await db.execute<{
      daily_close_id: string;
      branch_id: string;
      business_date: string;
      variance_ngn: number;
    }>(sql`
      SELECT id AS daily_close_id, branch_id, business_date::text, variance_ngn
      FROM daily_close
      WHERE business_date >= ${from}::date
      ORDER BY business_date DESC
    `);
    return c.json({ data: rows });
  });

  return r;
}

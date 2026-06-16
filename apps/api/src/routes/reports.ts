import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { toCsv } from "../lib/csv.js";

export function reportRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth(), requireCapability("reports.view"));

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

  // Revenue / orders bucketed over time for trend charts. Zero-filled so the
  // x-axis is continuous even on days/weeks with no sales. Same status filter as
  // /revenue; net subtracts completed refunds in the same bucket.
  r.get("/timeseries", async (c) => {
    const from =
      c.req.query("from") ??
      new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = c.req.query("to") ?? new Date().toISOString().slice(0, 10);
    const interval = c.req.query("interval") === "week" ? "week" : "day";

    const seriesStart =
      interval === "week"
        ? sql`date_trunc('week', ${from}::timestamp)::date`
        : sql`${from}::date`;
    const step = interval === "week" ? sql`'1 week'::interval` : sql`'1 day'::interval`;
    const saleBucket =
      interval === "week"
        ? sql`date_trunc('week', created_at_local)::date`
        : sql`created_at_local::date`;
    const refundBucket =
      interval === "week"
        ? sql`date_trunc('week', created_at)::date`
        : sql`created_at::date`;

    const rows = await db.execute<{
      date: string;
      gross_ngn: number;
      net_ngn: number;
      orders: number;
    }>(sql`
      WITH buckets AS (
        SELECT generate_series(${seriesStart}, ${to}::date, ${step})::date AS d
      ),
      sales AS (
        SELECT ${saleBucket} AS d, SUM(total_ngn)::int AS gross, COUNT(*)::int AS orders
        FROM sale_order
        WHERE status IN ('paid','handed_over','delivered')
          AND created_at_local::date BETWEEN ${from}::date AND ${to}::date
        GROUP BY 1
      ),
      refunds AS (
        SELECT ${refundBucket} AS d, SUM(refund_amount_ngn)::int AS refunds
        FROM sale_return
        WHERE status = 'completed'
          AND created_at::date BETWEEN ${from}::date AND ${to}::date
        GROUP BY 1
      )
      SELECT
        b.d::text AS date,
        COALESCE(s.gross, 0)::int AS gross_ngn,
        (COALESCE(s.gross, 0) - COALESCE(r.refunds, 0))::int AS net_ngn,
        COALESCE(s.orders, 0)::int AS orders
      FROM buckets b
      LEFT JOIN sales s ON s.d = b.d
      LEFT JOIN refunds r ON r.d = b.d
      ORDER BY b.d
    `);
    return c.json({ data: rows });
  });

  r.get("/branch-stock", async (c) => {
    const rows = await db.execute<{
      branch_id: string;
      product_id: string;
      variant_id: string | null;
      balance: number;
    }>(sql`
      SELECT location_id AS branch_id, product_id, variant_id,
             COALESCE(SUM(delta), 0)::int AS balance
      FROM stock_ledger
      WHERE location_type = 'branch'
      GROUP BY location_id, product_id, variant_id
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

  // Monthly P&L. Revenue from sale_order (paid/handed_over/delivered) and
  // sale_return (completed) within the month, net of refunds; expenses from
  // business_expense (excludes soft-deleted). All in NGN.
  r.get("/pnl", async (c) => {
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return c.json(
        { error: { code: "validation_failed", message: "month must be YYYY-MM" } },
        400,
      );
    }
    const from = `${month}-01`;
    const [yy, mm] = month.split("-").map((s) => Number(s));
    const nextMonth =
      mm === 12 ? `${yy! + 1}-01-01` : `${yy}-${String(mm! + 1).padStart(2, "0")}-01`;

    const revRow = await db.execute<{ revenue_ngn: number; refunds_ngn: number }>(sql`
      WITH sales AS (
        SELECT total_ngn FROM sale_order
        WHERE status IN ('paid','handed_over','delivered')
          AND created_at_local::date >= ${from}::date
          AND created_at_local::date <  ${nextMonth}::date
      ),
      refunds AS (
        SELECT refund_amount_ngn FROM sale_return
        WHERE status = 'completed'
          AND created_at::date >= ${from}::date
          AND created_at::date <  ${nextMonth}::date
      )
      SELECT
        COALESCE((SELECT SUM(total_ngn) FROM sales), 0)::int AS revenue_ngn,
        COALESCE((SELECT SUM(refund_amount_ngn) FROM refunds), 0)::int AS refunds_ngn
    `);
    const rev = revRow[0] ?? { revenue_ngn: 0, refunds_ngn: 0 };

    const expRows = await db.execute<{
      category_code: string;
      amount_ngn: number;
      cnt: number;
    }>(sql`
      SELECT category_code,
             COALESCE(SUM(amount_ngn), 0)::int AS amount_ngn,
             COUNT(*)::int AS cnt
      FROM business_expense
      WHERE deleted_at IS NULL
        AND expense_date >= ${from}::date
        AND expense_date <  ${nextMonth}::date
      GROUP BY category_code
      ORDER BY amount_ngn DESC
    `);

    const LABEL: Record<string, string> = {
      raw_materials: "Raw materials",
      packaging: "Packaging",
      utilities: "Utilities",
      transport: "Transport",
      salaries: "Salaries",
      rent: "Rent",
      marketing: "Marketing",
      equipment: "Equipment",
      regulatory: "Regulatory",
      other_with_note: "Other",
    };
    const byCat = expRows.map((row) => ({
      category_code: row.category_code,
      label: LABEL[row.category_code] ?? row.category_code,
      amount_ngn: Number(row.amount_ngn),
    }));
    const totalExp = byCat.reduce((s, r) => s + r.amount_ngn, 0);
    const totalCnt = expRows.reduce((s, r) => s + Number(r.cnt), 0);
    const netRev = Number(rev.revenue_ngn) - Number(rev.refunds_ngn);
    const net = netRev - totalExp;

    if (c.req.query("format") === "csv") {
      const lines: Array<readonly unknown[]> = [];
      lines.push([`Mrs. Samuel - P&L for ${month}`, "", ""]);
      lines.push(["", "", ""]);
      lines.push(["Section", "Item", "Amount (NGN)"]);
      lines.push(["Revenue", "Sales", Number(rev.revenue_ngn)]);
      lines.push(["Revenue", "Refunds", -Number(rev.refunds_ngn)]);
      lines.push(["Revenue", "Net revenue", netRev]);
      lines.push(["", "", ""]);
      lines.push(["Section", "Category", "Amount (NGN)"]);
      for (const cat of byCat) {
        lines.push(["Expenses", cat.label, cat.amount_ngn]);
      }
      lines.push(["Expenses", "Total expenses", totalExp]);
      lines.push(["", "", ""]);
      lines.push(["Net", "Net (Revenue - Expenses)", net]);
      const filename = `pnl-${month}.csv`;
      c.header("Content-Type", "text/csv; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="${filename}"`);
      return c.body(toCsv(["", "", ""], lines));
    }

    return c.json({
      data: {
        month,
        revenue_ngn: Number(rev.revenue_ngn),
        refunds_ngn: Number(rev.refunds_ngn),
        net_revenue_ngn: netRev,
        expenses_total_ngn: totalExp,
        expenses_by_category: byCat,
        expense_count: totalCnt,
        net_ngn: net,
      },
    });
  });

  // Command-center snapshot: all counters needed for the stat-banner strips.
  // Each sub-query is wrapped in `block()` so a single failure yields 0s instead
  // of a 500. month_profit_ngn is computed in JS (spec requirement).
  //
  // Verified table/column names:
  //   preorders  → sale_order.is_preorder=true, status IN ('confirmed','paid','handed_over','out_for_delivery')
  //   bags_queue → sale_order_packaging rows joined to sale_order with status='confirmed'
  //   subscriptions → subscription_plan is a catalogue only; NO customer_subscription table exists
  //   leads      → subscription_lead.created_at (this calendar month)
  //   expiring_48h → 0 (no batch-expiry source in schema yet)
  //   active_subscriptions / mrr_ngn → 0 (no active-customer-subscription table)
  r.get("/overview", async (c) => {
    async function block<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
      try { return await fn(); } catch (err) { console.error(`[overview] ${label} block failed:`, err); return fallback; }
    }

    // Current calendar month boundaries — same pattern as /pnl.
    const now = new Date();
    const monthStr = now.toISOString().slice(0, 7); // "YYYY-MM"
    const from = `${monthStr}-01`;
    const [yy, mm] = monthStr.split("-").map((s) => Number(s));
    const nextMonth =
      mm === 12
        ? `${yy! + 1}-01-01`
        : `${yy}-${String(mm! + 1).padStart(2, "0")}-01`;

    const [stockBlock, fulfilmentBlock, todayBlock, growthBlock] = await Promise.all([
      // ── stock ───────────────────────────────────────────────────────────────
      block("stock", async () => {
        const rows = await db.execute<{ low_stock_skus: number }>(sql`
          SELECT COUNT(*)::int AS low_stock_skus
          FROM (
            SELECT product_id, variant_id, COALESCE(SUM(delta), 0) AS balance
            FROM stock_ledger
            WHERE location_type = 'branch'
            GROUP BY product_id, variant_id
          ) t
          WHERE balance BETWEEN 1 AND 10
        `);
        return {
          low_stock_skus: Number(rows[0]?.low_stock_skus ?? 0),
          expiring_48h: 0, // no batch-expiry source in schema yet
        };
      }, { low_stock_skus: 0, expiring_48h: 0 }),

      // ── fulfilment ──────────────────────────────────────────────────────────
      block("fulfilment", async () => {
        const [pendingRow, preorderRow, bagsRow] = await Promise.all([
          // Regular pending orders (not preorders, awaiting handover)
          db.execute<{ cnt: number }>(sql`
            SELECT COUNT(*)::int AS cnt
            FROM sale_order
            WHERE is_preorder = false
              AND status IN ('confirmed', 'paid', 'handed_over', 'out_for_delivery')
          `),
          // Open preorders (placed but not yet fulfilled)
          db.execute<{ cnt: number }>(sql`
            SELECT COUNT(*)::int AS cnt
            FROM sale_order
            WHERE is_preorder = true
              AND status IN ('confirmed', 'paid', 'handed_over', 'out_for_delivery')
          `),
          // Orders with bags attached that are still in confirmed (unfulfilled) state
          db.execute<{ cnt: number }>(sql`
            SELECT COUNT(DISTINCT sop.sale_order_id)::int AS cnt
            FROM sale_order_packaging sop
            JOIN sale_order so ON so.id = sop.sale_order_id
            WHERE so.status = 'confirmed'
          `),
        ]);
        return {
          orders_pending: Number(pendingRow[0]?.cnt ?? 0),
          preorders_open: Number(preorderRow[0]?.cnt ?? 0),
          bags_queue: Number(bagsRow[0]?.cnt ?? 0),
        };
      }, { orders_pending: 0, preorders_open: 0, bags_queue: 0 }),

      // ── today ───────────────────────────────────────────────────────────────
      block("today", async () => {
        const rows = await db.execute<{ bucket: string; net_ngn: number }>(sql`
          SELECT
            CASE
              WHEN created_at_local::date = CURRENT_DATE     THEN 'today'
              WHEN created_at_local::date = CURRENT_DATE - 1 THEN 'yesterday'
              ELSE 'wtd'
            END AS bucket,
            COALESCE(SUM(total_ngn), 0)::int AS net_ngn
          FROM sale_order
          WHERE status IN ('paid', 'handed_over', 'delivered')
            AND created_at_local::date >= date_trunc('week', CURRENT_DATE)::date
          GROUP BY 1
        `);
        const byBucket = Object.fromEntries(rows.map((r) => [r.bucket, Number(r.net_ngn)]));
        const todayNet = byBucket["today"] ?? 0;
        const yesterdayNet = byBucket["yesterday"] ?? 0;
        // wtd = sum of all week-to-date paid revenue (today + earlier days this week)
        const wtdNet = rows.reduce((s, r) => s + Number(r.net_ngn), 0);
        return {
          net_ngn: todayNet,
          yesterday_net_ngn: yesterdayNet,
          wtd_net_ngn: wtdNet,
        };
      }, { net_ngn: 0, yesterday_net_ngn: 0, wtd_net_ngn: 0 }),

      // ── growth ──────────────────────────────────────────────────────────────
      block("growth", async () => {
        const [revRow, expRow, leadsRow] = await Promise.all([
          db.execute<{ revenue_ngn: number }>(sql`
            SELECT COALESCE(SUM(total_ngn), 0)::int AS revenue_ngn
            FROM sale_order
            WHERE status IN ('paid', 'handed_over', 'delivered')
              AND created_at_local::date >= ${from}::date
              AND created_at_local::date <  ${nextMonth}::date
          `),
          db.execute<{ expenses_ngn: number }>(sql`
            SELECT COALESCE(SUM(amount_ngn), 0)::int AS expenses_ngn
            FROM business_expense
            WHERE deleted_at IS NULL
              AND expense_date >= ${from}::date
              AND expense_date <  ${nextMonth}::date
          `),
          db.execute<{ cnt: number }>(sql`
            SELECT COUNT(*)::int AS cnt
            FROM subscription_lead
            WHERE created_at::date >= ${from}::date
              AND created_at::date <  ${nextMonth}::date
          `),
        ]);
        const month_revenue_ngn = Number(revRow[0]?.revenue_ngn ?? 0);
        const month_expenses_ngn = Number(expRow[0]?.expenses_ngn ?? 0);
        return {
          month_revenue_ngn,
          month_expenses_ngn,
          month_profit_ngn: month_revenue_ngn - month_expenses_ngn,
          // No customer_subscription table exists — subscription_plan is a catalogue only.
          active_subscriptions: 0,
          mrr_ngn: 0,
          new_leads: Number(leadsRow[0]?.cnt ?? 0),
        };
      }, {
        month_revenue_ngn: 0,
        month_expenses_ngn: 0,
        month_profit_ngn: 0,
        active_subscriptions: 0,
        mrr_ngn: 0,
        new_leads: 0,
      }),
    ]);

    return c.json({
      data: {
        stock: stockBlock,
        fulfilment: fulfilmentBlock,
        today: todayBlock,
        growth: growthBlock,
      },
    });
  });

  return r;
}

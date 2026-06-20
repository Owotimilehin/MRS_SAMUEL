import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { DbClient } from "@ms/db";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { toCsv } from "../lib/csv.js";
import { allocateFifo, type CostLayer } from "../lib/packaging-cost.js";

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

    const [stockBlock, fulfilmentBlock, todayBlock] = await Promise.all([
      block("stock", async () => {
        const [factory, branch] = await Promise.all([
          db.execute<{ n: number }>(sql`
            SELECT COUNT(*)::int AS n FROM (
              SELECT product_id, variant_id, COALESCE(SUM(delta),0) AS balance
              FROM stock_ledger WHERE location_type = 'factory'
              GROUP BY product_id, variant_id
            ) t WHERE balance BETWEEN 1 AND 10
          `),
          db.execute<{ n: number }>(sql`
            SELECT COUNT(*)::int AS n FROM (
              SELECT product_id, variant_id, COALESCE(SUM(delta),0) AS balance
              FROM stock_ledger WHERE location_type = 'branch'
              GROUP BY product_id, variant_id
            ) t WHERE balance BETWEEN 1 AND 10
          `),
        ]);
        return {
          low_stock_factory: Number(factory[0]?.n ?? 0),
          low_stock_branch: Number(branch[0]?.n ?? 0),
          expiring_48h: 0,
        };
      }, { low_stock_factory: 0, low_stock_branch: 0, expiring_48h: 0 }),

      block("fulfilment", async () => {
        const [pendingRow, preorderRow, bagsRow, transferRow] = await Promise.all([
          db.execute<{ cnt: number }>(sql`
            SELECT COUNT(*)::int AS cnt FROM sale_order
            WHERE is_preorder = true
              AND fulfilled_at IS NULL
              AND status NOT IN ('cancelled','failed')`),
          db.execute<{ cnt: number }>(sql`
            SELECT COUNT(*)::int AS cnt FROM sale_order
            WHERE is_preorder = true
              AND status IN ('confirmed','paid','handed_over','out_for_delivery')`),
          db.execute<{ cnt: number }>(sql`
            SELECT COUNT(DISTINCT sop.sale_order_id)::int AS cnt
            FROM sale_order_packaging sop
            JOIN sale_order so ON so.id = sop.sale_order_id
            WHERE so.status = 'confirmed'`),
          db.execute<{ cnt: number }>(sql`
            SELECT COUNT(*)::int AS cnt FROM stock_transfer
            WHERE status IN ('dispatched','in_transit','arrived')`),
        ]);
        return {
          awaiting_fulfilment: Number(pendingRow[0]?.cnt ?? 0),
          preorders_open: Number(preorderRow[0]?.cnt ?? 0),
          bags_queue: Number(bagsRow[0]?.cnt ?? 0),
          pending_transfers: Number(transferRow[0]?.cnt ?? 0),
        };
      }, { awaiting_fulfilment: 0, preorders_open: 0, bags_queue: 0, pending_transfers: 0 }),

      block("today", async () => {
        const rows = await db.execute<{ size_ml: number; units: number }>(sql`
          SELECT pv.size_ml, SUM(i.quantity)::int AS units
          FROM sale_order_item i
          JOIN sale_order o ON o.id = i.sale_order_id
          JOIN product_variant pv ON pv.id = i.variant_id
          WHERE o.status IN ('paid','handed_over','delivered')
            AND o.created_at_local::date = CURRENT_DATE
          GROUP BY pv.size_ml ORDER BY pv.size_ml
        `);
        const units_by_size = rows.map((r) => ({ size_ml: Number(r.size_ml), units: Number(r.units) }));
        return { total_units: units_by_size.reduce((s, r) => s + r.units, 0), units_by_size };
      }, { total_units: 0, units_by_size: [] as Array<{ size_ml: number; units: number }> }),
    ]);

    return c.json({
      data: { stock: stockBlock, fulfilment: fulfilmentBlock, today: todayBlock },
    });
  });

  r.get("/daily", requireCapability("finance.view"), async (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json(
        { error: { code: "validation_failed", message: "date must be YYYY-MM-DD" } },
        400,
      );
    }

    const ALL_CATEGORIES = [
      "raw_materials", "packaging", "utilities", "transport", "salaries",
      "rent", "marketing", "equipment", "regulatory", "other_with_note",
    ] as const;
    const LABEL: Record<string, string> = {
      raw_materials: "Raw materials", packaging: "Packaging", utilities: "Utilities",
      transport: "Transport", salaries: "Salaries", rent: "Rent", marketing: "Marketing",
      equipment: "Equipment", regulatory: "Regulatory", other_with_note: "Other",
    };
    const requested = c.req.query("expense_categories");
    // packaging is ALWAYS excluded (counted per-unit). Default = all non-packaging.
    const selected = (requested
      ? requested.split(",").map((s) => s.trim()).filter((s) => ALL_CATEGORIES.includes(s as never))
      : ALL_CATEGORIES.filter((cat) => cat !== "packaging")
    ).filter((cat) => cat !== "packaging");

    // ── revenue + refunds for the day ──
    const revRow = await db.execute<{ revenue_ngn: number; refunds_ngn: number }>(sql`
      SELECT
        COALESCE((SELECT SUM(total_ngn) FROM sale_order
          WHERE status IN ('paid','handed_over','delivered')
            AND created_at_local::date = ${date}::date), 0)::int AS revenue_ngn,
        COALESCE((SELECT SUM(refund_amount_ngn) FROM sale_return
          WHERE status = 'completed' AND created_at::date = ${date}::date), 0)::int AS refunds_ngn
    `);
    const revenue = Number(revRow[0]?.revenue_ngn ?? 0);
    const refunds = Number(revRow[0]?.refunds_ngn ?? 0);

    // ── bottle units (day + prior) per bottle_material_id ──
    const bottleDay = await db.execute<{ material_id: string; units: number }>(sql`
      SELECT pv.bottle_material_id AS material_id, SUM(i.quantity)::int AS units
      FROM sale_order_item i
      JOIN sale_order o ON o.id = i.sale_order_id
      JOIN product_variant pv ON pv.id = i.variant_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date = ${date}::date
        AND pv.bottle_material_id IS NOT NULL
      GROUP BY pv.bottle_material_id
    `);
    const bottlePrior = await db.execute<{ material_id: string; units: number }>(sql`
      SELECT pv.bottle_material_id AS material_id, SUM(i.quantity)::int AS units
      FROM sale_order_item i
      JOIN sale_order o ON o.id = i.sale_order_id
      JOIN product_variant pv ON pv.id = i.variant_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date < ${date}::date
        AND pv.bottle_material_id IS NOT NULL
      GROUP BY pv.bottle_material_id
    `);

    // ── bag units (day + prior) per packaging_material_id ──
    const bagDay = await db.execute<{ material_id: string; units: number }>(sql`
      SELECT sop.packaging_material_id AS material_id, SUM(sop.quantity)::int AS units
      FROM sale_order_packaging sop
      JOIN sale_order o ON o.id = sop.sale_order_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date = ${date}::date
      GROUP BY sop.packaging_material_id
    `);
    const bagPrior = await db.execute<{ material_id: string; units: number }>(sql`
      SELECT sop.packaging_material_id AS material_id, SUM(sop.quantity)::int AS units
      FROM sale_order_packaging sop
      JOIN sale_order o ON o.id = sop.sale_order_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date < ${date}::date
      GROUP BY sop.packaging_material_id
    `);

    // ── purchase layers (oldest first) + latest fallback price + names ──
    const layerRows = await db.execute<{ material_id: string; quantity: number; unit_cost_ngn: number }>(sql`
      SELECT packaging_material_id AS material_id, quantity, unit_cost_ngn
      FROM packaging_purchase
      ORDER BY purchase_date ASC, id ASC
    `);
    const latestRows = await db.execute<{ material_id: string; unit_cost_ngn: number }>(sql`
      SELECT DISTINCT ON (packaging_material_id) packaging_material_id AS material_id, unit_cost_ngn
      FROM packaging_purchase
      ORDER BY packaging_material_id, purchase_date DESC, id DESC
    `);
    const nameRows = await db.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM packaging_material
    `);

    const layersByMat = new Map<string, CostLayer[]>();
    for (const row of layerRows) {
      const list = layersByMat.get(row.material_id) ?? [];
      list.push({ quantity: Number(row.quantity), unitCostNgn: Number(row.unit_cost_ngn) });
      layersByMat.set(row.material_id, list);
    }
    const fallbackByMat = new Map(latestRows.map((r) => [r.material_id, Number(r.unit_cost_ngn)]));
    const nameById = new Map(nameRows.map((r) => [r.id, r.name]));
    const priorBottle = new Map(bottlePrior.map((r) => [r.material_id, Number(r.units)]));
    const priorBag = new Map(bagPrior.map((r) => [r.material_id, Number(r.units)]));
    const caveats: string[] = [];

    function costDetail(
      dayRows: Array<{ material_id: string; units: number }>,
      priorMap: Map<string, number>,
    ): Array<{ material_id: string; units: number; cost_ngn: number }> {
      const out: Array<{ material_id: string; units: number; cost_ngn: number }> = [];
      for (const row of dayRows) {
        const layers = layersByMat.get(row.material_id) ?? [];
        const fallback = fallbackByMat.get(row.material_id) ?? 0;
        if (layers.length === 0 && fallback === 0) {
          caveats.push(`${nameById.get(row.material_id) ?? "A material"} has no purchase history — costed at ₦0`);
        }
        const res = allocateFifo(layers, priorMap.get(row.material_id) ?? 0, Number(row.units), fallback);
        out.push({ material_id: row.material_id, units: Number(row.units), cost_ngn: res.costNgn });
      }
      return out;
    }

    const bottleDetail = costDetail(bottleDay, priorBottle);
    const bagDetail = costDetail(bagDay, priorBag);
    const bottlesCost = bottleDetail.reduce((s, r) => s + r.cost_ngn, 0);
    const bagsCost = bagDetail.reduce((s, r) => s + r.cost_ngn, 0);
    const packagingBreakdown = [
      ...bottleDetail.map((r) => ({
        material_id: r.material_id,
        name: nameById.get(r.material_id) ?? "—",
        kind: "bottle" as const,
        units: r.units,
        unit_cost_ngn: r.units > 0 ? Math.round(r.cost_ngn / r.units) : 0,
        cost_ngn: r.cost_ngn,
      })),
      ...bagDetail.map((r) => ({
        material_id: r.material_id,
        name: nameById.get(r.material_id) ?? "—",
        kind: "bag" as const,
        units: r.units,
        unit_cost_ngn: r.units > 0 ? Math.round(r.cost_ngn / r.units) : 0,
        cost_ngn: r.cost_ngn,
      })),
    ];

    // ── expenses for the day (selected categories, never packaging) ──
    // When no categories are selected (e.g. every checkbox unchecked, or the
    // only requested category was "packaging" which is always stripped), skip
    // the query entirely — `ANY(ARRAY[]::business_expense_category[])` with an
    // empty list is fine, but building it from `''` is not a valid enum value
    // and Postgres rejects it with a 500. Zero categories selected means zero
    // expenses counted, by definition.
    let expensesByCat: Array<{ category_code: string; label: string; amount_ngn: number }> = [];
    if (selected.length > 0) {
      const expRows = await db.execute<{ category_code: string; amount_ngn: number }>(sql`
        SELECT category_code, COALESCE(SUM(amount_ngn), 0)::int AS amount_ngn
        FROM business_expense
        WHERE deleted_at IS NULL
          AND expense_date = ${date}::date
          AND category_code = ANY(${sql.raw(`ARRAY[${selected.map((s) => `'${s}'`).join(",")}]::business_expense_category[]`)})
        GROUP BY category_code
      `);
      expensesByCat = expRows.map((r) => ({
        category_code: r.category_code,
        label: LABEL[r.category_code] ?? r.category_code,
        amount_ngn: Number(r.amount_ngn),
      }));
    }
    const expenses = expensesByCat.reduce((s, r) => s + r.amount_ngn, 0);

    // ── units by size ──
    const sizeRows = await db.execute<{ size_ml: number; units: number }>(sql`
      SELECT pv.size_ml, SUM(i.quantity)::int AS units
      FROM sale_order_item i
      JOIN sale_order o ON o.id = i.sale_order_id
      JOIN product_variant pv ON pv.id = i.variant_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date = ${date}::date
      GROUP BY pv.size_ml
      ORDER BY pv.size_ml
    `);
    const unitsBySize = sizeRows.map((r) => ({ size_ml: Number(r.size_ml), units: Number(r.units) }));
    const totalUnits = unitsBySize.reduce((s, r) => s + r.units, 0);

    // ── revenue by size → flavour category (actual recorded line totals) ──
    const rbsRows = await db.execute<{
      size_ml: number;
      category: string;
      units: number;
      revenue_ngn: number;
    }>(sql`
      SELECT pv.size_ml AS size_ml, p.category AS category,
             SUM(i.quantity)::int AS units,
             SUM(i.line_total_ngn)::int AS revenue_ngn
      FROM sale_order_item i
      JOIN sale_order o ON o.id = i.sale_order_id
      JOIN product_variant pv ON pv.id = i.variant_id
      JOIN product p ON p.id = i.product_id
      WHERE o.status IN ('paid','handed_over','delivered')
        AND o.created_at_local::date = ${date}::date
      GROUP BY pv.size_ml, p.category
      ORDER BY pv.size_ml, p.category
    `);
    const CATEGORY_ORDER: Record<string, number> = { regular: 0, special: 1, punch: 2 };
    const bySizeMap = new Map<
      number,
      {
        size_ml: number;
        revenue_ngn: number;
        units: number;
        rows: Array<{ category: string; units: number; revenue_ngn: number; avg_unit_price_ngn: number }>;
      }
    >();
    for (const rbsRow of rbsRows) {
      const size = Number(rbsRow.size_ml);
      const units = Number(rbsRow.units);
      const rev = Number(rbsRow.revenue_ngn);
      const entry = bySizeMap.get(size) ?? { size_ml: size, revenue_ngn: 0, units: 0, rows: [] };
      entry.rows.push({
        category: rbsRow.category,
        units,
        revenue_ngn: rev,
        avg_unit_price_ngn: units > 0 ? Math.round(rev / units) : 0,
      });
      entry.revenue_ngn += rev;
      entry.units += units;
      bySizeMap.set(size, entry);
    }
    const revenueBySize = [...bySizeMap.values()]
      .sort((a, b) => a.size_ml - b.size_ml)
      .map((e) => ({
        ...e,
        rows: e.rows.sort(
          (a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9),
        ),
      }));
    const productSales = revenueBySize.reduce((s, e) => s + e.revenue_ngn, 0);

    // ── delivery fees collected on the day's counted orders (reconciliation) ──
    const delivRow = await db.execute<{ fees: number }>(sql`
      SELECT COALESCE(SUM(delivery_fee_ngn), 0)::int AS fees
      FROM sale_order
      WHERE status IN ('paid','handed_over','delivered')
        AND created_at_local::date = ${date}::date
    `);
    const deliveryFees = Number(delivRow[0]?.fees ?? 0);

    const netRevenue = revenue - refunds;
    const packagingCost = bottlesCost + bagsCost;
    const dailyProfit = netRevenue - packagingCost - expenses;
    const marginPct = netRevenue > 0 ? Math.round((dailyProfit / netRevenue) * 1000) / 10 : null;

    return c.json({
      data: {
        date,
        revenue_ngn: revenue,
        refunds_ngn: refunds,
        net_revenue_ngn: netRevenue,
        product_sales_ngn: productSales,
        delivery_fees_ngn: deliveryFees,
        packaging_cost_ngn: packagingCost,
        packaging_cost_bottles_ngn: bottlesCost,
        packaging_cost_bags_ngn: bagsCost,
        expenses_ngn: expenses,
        expenses_by_category: expensesByCat,
        daily_profit_ngn: dailyProfit,
        margin_pct: marginPct,
        total_units: totalUnits,
        units_by_size: unitsBySize,
        revenue_by_size: revenueBySize,
        packaging_breakdown: packagingBreakdown,
        caveats: Array.from(new Set(caveats)),
      },
    });
  });

  return r;
}

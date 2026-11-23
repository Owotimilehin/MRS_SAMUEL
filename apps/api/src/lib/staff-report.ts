/**
 * Pure helpers for two owner reports:
 *  - GET /reports/staff     sales per staff member (who rang each sale)
 *  - GET /reports/overview  per-location "running low" stock counts
 * The SQL fetches flat rows; the merging and maths live here so they can be
 * unit-tested without a database.
 */

/** Used when a size has no low_stock_level of its own. */
export const DEFAULT_LOW_STOCK_LEVEL = 10;

/** Label for counted orders with no staff user (storefront / online checkout). */
export const ONLINE_NO_STAFF = "Online (no staff)";

export type StaffSalesRow = {
  user_id: string | null;
  branch_id: string;
  orders: number;
  bottles: number;
  gross_ngn: number;
}

export type StaffRefundRow = {
  user_id: string | null;
  branch_id: string;
  refunds_ngn: number;
}

export type StaffCloseRow = {
  user_id: string;
  branch_id: string;
  closes: number;
  short_count: number;
  short_total_ngn: number;
}

export type StaffUserInfo = {
  id: string;
  name: string | null;
  email: string;
  role: string;
}

export interface StaffReportRow {
  user_id: string | null;
  name: string;
  email: string | null;
  role: string | null;
  branch_id: string;
  branch_name: string;
  orders: number;
  bottles: number;
  gross_ngn: number;
  refunds_ngn: number;
  net_ngn: number;
  avg_order_ngn: number;
  closes_submitted: number;
  short_count: number;
  short_total_ngn: number;
}

/**
 * One row per (staff user, branch). Sales, refunds and shift-end closes are
 * fetched separately and merged here, so a person who only submitted a close
 * (no sales) or only had a refund still gets a row. Orders with no staff user
 * become one "Online (no staff)" row per branch. Rows are sorted by net
 * revenue, highest first.
 */
export function buildStaffReport(input: {
  sales: StaffSalesRow[];
  refunds: StaffRefundRow[];
  closes: StaffCloseRow[];
  users: StaffUserInfo[];
  branches: Array<{ id: string; name: string }>;
}): StaffReportRow[] {
  const users = new Map(input.users.map((u) => [u.id, u]));
  const branches = new Map(input.branches.map((b) => [b.id, b.name]));
  const rows = new Map<string, StaffReportRow>();

  const get = (userId: string | null, branchId: string): StaffReportRow => {
    const key = `${userId ?? "-"}|${branchId}`;
    let row = rows.get(key);
    if (!row) {
      const u = userId ? users.get(userId) : undefined;
      row = {
        user_id: userId,
        name: userId ? (u?.name?.trim() || u?.email || "Unknown staff") : ONLINE_NO_STAFF,
        email: u?.email ?? null,
        role: u?.role ?? null,
        branch_id: branchId,
        branch_name: branches.get(branchId) ?? "Unknown branch",
        orders: 0,
        bottles: 0,
        gross_ngn: 0,
        refunds_ngn: 0,
        net_ngn: 0,
        avg_order_ngn: 0,
        closes_submitted: 0,
        short_count: 0,
        short_total_ngn: 0,
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const s of input.sales) {
    const row = get(s.user_id, s.branch_id);
    row.orders += Number(s.orders);
    row.bottles += Number(s.bottles);
    row.gross_ngn += Number(s.gross_ngn);
  }
  for (const r of input.refunds) {
    get(r.user_id, r.branch_id).refunds_ngn += Number(r.refunds_ngn);
  }
  for (const d of input.closes) {
    const row = get(d.user_id, d.branch_id);
    row.closes_submitted += Number(d.closes);
    row.short_count += Number(d.short_count);
    row.short_total_ngn += Number(d.short_total_ngn);
  }

  const out = [...rows.values()];
  for (const row of out) {
    row.net_ngn = row.gross_ngn - row.refunds_ngn;
    row.avg_order_ngn = row.orders > 0 ? Math.round(row.gross_ngn / row.orders) : 0;
  }
  return out.sort((a, b) => b.net_ngn - a.net_ngn || a.name.localeCompare(b.name));
}

export interface StaffReportTotals {
  orders: number;
  bottles: number;
  gross_ngn: number;
  refunds_ngn: number;
  net_ngn: number;
  avg_order_ngn: number;
  short_count: number;
  short_total_ngn: number;
}

export function staffReportTotals(rows: StaffReportRow[]): StaffReportTotals {
  const t = rows.reduce(
    (acc, r) => {
      acc.orders += r.orders;
      acc.bottles += r.bottles;
      acc.gross_ngn += r.gross_ngn;
      acc.refunds_ngn += r.refunds_ngn;
      acc.short_count += r.short_count;
      acc.short_total_ngn += r.short_total_ngn;
      return acc;
    },
    { orders: 0, bottles: 0, gross_ngn: 0, refunds_ngn: 0, short_count: 0, short_total_ngn: 0 },
  );
  return {
    ...t,
    net_ngn: t.gross_ngn - t.refunds_ngn,
    avg_order_ngn: t.orders > 0 ? Math.round(t.gross_ngn / t.orders) : 0,
  };
}

/** The level a size is "running low" at: its own level, else the default. */
export function lowStockLevelFor(level: number | null | undefined): number {
  return level === null || level === undefined ? DEFAULT_LOW_STOCK_LEVEL : level;
}

export type LowStockRow = {
  location_type: "factory" | "branch";
  location_id: string;
  location_name: string;
  variant_id: string;
  product_name: string;
  size_ml: number;
  balance: number;
  level: number;
}

/**
 * Turn the per-(location, size) rows already filtered to "at or below level"
 * into the overview's counts plus the most urgent items (lowest stock first,
 * so empty shelves lead). Counts are per location: the same size low at two
 * branches counts twice, because each shelf needs its own restock.
 */
export function summariseLowStock(rows: LowStockRow[], limit = 20): {
  low_stock_factory: number;
  low_stock_branch: number;
  low_stock_items: LowStockRow[];
} {
  const low = rows.filter((r) => Number(r.balance) <= Number(r.level));
  const items = [...low]
    .map((r) => ({ ...r, balance: Number(r.balance), level: Number(r.level), size_ml: Number(r.size_ml) }))
    .sort(
      (a, b) =>
        a.balance - b.balance ||
        a.product_name.localeCompare(b.product_name) ||
        a.size_ml - b.size_ml ||
        a.location_name.localeCompare(b.location_name),
    )
    .slice(0, limit);
  return {
    low_stock_factory: low.filter((r) => r.location_type === "factory").length,
    low_stock_branch: low.filter((r) => r.location_type === "branch").length,
    low_stock_items: items,
  };
}

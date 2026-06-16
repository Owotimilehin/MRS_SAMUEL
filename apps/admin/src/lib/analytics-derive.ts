// Pure transforms from raw report responses into chart-ready shapes. Kept free
// of React/fetch so they can be reasoned about (and unit-tested) on their own.

export interface RevenueRow {
  branch_id: string;
  channel: string;
  gross_ngn: number;
  refunds_ngn: number;
  net_ngn: number;
  orders: number;
}
export interface TopProductRow {
  product_id: string;
  product_name: string;
  quantity: number;
  revenue_ngn: number;
}
export interface ProductRow {
  id: string;
  name: string;
  slug: string;
  category: string;
}
export interface BranchRow {
  id: string;
  name: string;
}
export interface TimePoint {
  date: string;
  gross_ngn: number;
  net_ngn: number;
  orders: number;
}

export interface Kpis {
  net: number;
  gross: number;
  refunds: number;
  orders: number;
  avgOrder: number;
  refundRate: number; // 0..1
}

export function deriveKpis(revenue: RevenueRow[]): Kpis {
  const net = sum(revenue, (r) => r.net_ngn);
  const gross = sum(revenue, (r) => r.gross_ngn);
  const refunds = sum(revenue, (r) => r.refunds_ngn);
  const orders = sum(revenue, (r) => r.orders);
  return {
    net,
    gross,
    refunds,
    orders,
    avgOrder: orders > 0 ? Math.round(net / orders) : 0,
    refundRate: gross > 0 ? refunds / gross : 0,
  };
}

export interface Slice {
  key: string;
  label: string;
  value: number;
}

/** Revenue (net) grouped by sales channel, largest first. */
export function deriveChannelMix(
  revenue: RevenueRow[],
  label: (c: string) => string,
): Slice[] {
  const m = new Map<string, number>();
  for (const r of revenue) m.set(r.channel, (m.get(r.channel) ?? 0) + r.net_ngn);
  return [...m.entries()]
    .map(([key, value]) => ({ key, label: label(key), value }))
    .filter((s) => s.value !== 0)
    .sort((a, b) => b.value - a.value);
}

export interface BranchPerf {
  id: string;
  name: string;
  net: number;
  orders: number;
}

/** Net revenue + orders per branch, largest first. */
export function deriveBranchMix(revenue: RevenueRow[], branches: BranchRow[]): BranchPerf[] {
  const nameOf = new Map(branches.map((b) => [b.id, b.name]));
  const m = new Map<string, { net: number; orders: number }>();
  for (const r of revenue) {
    const cur = m.get(r.branch_id) ?? { net: 0, orders: 0 };
    cur.net += r.net_ngn;
    cur.orders += r.orders;
    m.set(r.branch_id, cur);
  }
  return [...m.entries()]
    .map(([id, v]) => ({ id, name: nameOf.get(id) ?? id.slice(0, 8), ...v }))
    .sort((a, b) => b.net - a.net);
}

/** Revenue grouped by product category (joins top-products → products). */
export function deriveCategoryMix(
  top: TopProductRow[],
  products: ProductRow[],
): Slice[] {
  const catOf = new Map(products.map((p) => [p.id, p.category]));
  const m = new Map<string, number>();
  for (const t of top) {
    const cat = catOf.get(t.product_id) ?? "other";
    m.set(cat, (m.get(cat) ?? 0) + t.revenue_ngn);
  }
  const LABEL: Record<string, string> = { regular: "Regular", special: "Special", punch: "Punch", other: "Other" };
  return [...m.entries()]
    .map(([key, value]) => ({ key, label: LABEL[key] ?? key, value }))
    .filter((s) => s.value !== 0)
    .sort((a, b) => b.value - a.value);
}

function sum<T>(rows: T[], pick: (r: T) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0);
}

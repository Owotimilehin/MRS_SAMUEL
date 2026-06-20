import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { Stat } from "../../components/Stat.js";
import { FlavourMedia } from "../../components/FlavourMedia.js";
import { StatHero } from "../../components/StatHero.js";
import { api } from "../../lib/api.js";
import { useCan } from "../../lib/auth.js";
import { ngn } from "../../lib/format.js";
import { downloadCsv } from "../../lib/csv.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import {
  DAILY_EXPENSE_CATEGORIES,
  getIncludedExpenseCategories,
  setIncludedExpenseCategories,
  type DailyExpenseCategory,
} from "../../lib/finance-settings.js";

interface RevenueRow {
  branch_id: string;
  channel: string;
  gross_ngn: number;
  refunds_ngn: number;
  net_ngn: number;
  orders: number;
}
interface TopProductRow {
  product_id: string;
  product_name: string;
  quantity: number;
  revenue_ngn: number;
}
interface VarianceRow {
  daily_close_id: string;
  branch_id: string;
  business_date: string;
  variance_ngn: number;
}
interface BranchRow {
  id: string;
  name: string;
  code: string;
}
interface ReviewBody {
  data: {
    transfer_variances: Array<{ id: string }>;
    return_approvals: Array<{ id: string }>;
  };
}
interface Overview {
  stock: { low_stock_factory: number; low_stock_branch: number; expiring_48h: number };
  fulfilment: {
    pos_orders_today: number;
    online_orders_today: number;
    online_pending: number;
    preorders_open: number;
    bags_queue: number;
    pending_transfers: number;
  };
  today: { total_units: number; units_by_size: Array<{ size_ml: number; units: number }> };
}
interface RevenueSizeRow {
  category: string;
  units: number;
  revenue_ngn: number;
  avg_unit_price_ngn: number;
}
interface RevenueBySize {
  size_ml: number;
  revenue_ngn: number;
  units: number;
  rows: RevenueSizeRow[];
}
interface PackagingLine {
  material_id: string;
  name: string;
  kind: "bottle" | "bag";
  units: number;
  unit_cost_ngn: number;
  cost_ngn: number;
}
interface DailyFinancials {
  date: string;
  revenue_ngn: number;
  refunds_ngn: number;
  net_revenue_ngn: number;
  product_sales_ngn: number;
  delivery_fees_ngn: number;
  other_adjustments_ngn: number;
  revenue_by_size: RevenueBySize[];
  packaging_cost_ngn: number;
  packaging_cost_bottles_ngn: number;
  packaging_cost_bags_ngn: number;
  packaging_breakdown: PackagingLine[];
  expenses_ngn: number;
  daily_profit_ngn: number;
  margin_pct: number | null;
  total_units: number;
  units_by_size: Array<{ size_ml: number; units: number }>;
  caveats: string[];
}

// Top-products / revenue endpoints return a product name but no slug; derive a
// slug from the name so FlavourMedia can resolve the right bottle (exact for
// known flavours, a stable hash fallback otherwise).
function slugify(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function nDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

const CATEGORY_LABEL: Record<string, string> = {
  regular: "Regular",
  special: "Special",
  punch: "Punch",
};

function ReconLine({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        padding: "3px 0",
        fontSize: strong ? 15 : 13,
        fontWeight: strong ? 800 : 500,
        color: strong ? "var(--ink)" : "var(--ink-soft)",
      }}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

export function DashboardPage(): JSX.Element {
  const [from, setFrom] = useState(nDaysAgo(7));
  const [to, setTo] = useState(today());
  const [revenue, setRevenue] = useState<RevenueRow[]>([]);
  const [topProducts, setTopProducts] = useState<TopProductRow[]>([]);
  const [variances, setVariances] = useState<VarianceRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const can = useCan();
  const showFinance = can("finance.view");
  const [finDate, setFinDate] = useState(today());
  const [includedCats, setIncludedCats] = useState<DailyExpenseCategory[]>(getIncludedExpenseCategories());
  const [daily, setDaily] = useState<DailyFinancials | null>(null);

  useEffect(() => {
    if (!showFinance) return;
    let cancelled = false;
    void (async () => {
      try {
        const qs = `date=${finDate}&expense_categories=${includedCats.join(",")}`;
        const res = await api<{ data: DailyFinancials }>(`/reports/daily?${qs}`);
        if (!cancelled) setDaily(res.data);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [showFinance, finDate, includedCats]);

  function toggleCat(code: DailyExpenseCategory): void {
    setIncludedCats((prev) => {
      const next = prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code];
      setIncludedExpenseCategories(next);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        // The "Needs review" count requires orders.manage (owners/managers).
        // Admins land on this dashboard without that cap, so fetch it only when
        // permitted and never let it reject the whole load — one forbidden
        // optional widget must not blank the entire dashboard.
        const reviewP = can("orders.manage")
          ? api<ReviewBody>(`/review`).catch(() => null)
          : Promise.resolve(null);
        // Money tables (revenue/top-products/variances/branches) are rendered
        // only behind `showFinance` — don't even fetch them for non-finance
        // roles so the money payloads never travel to those browsers.
        const moneyP = showFinance
          ? Promise.all([
              api<{ data: RevenueRow[] }>(`/reports/revenue?from=${from}&to=${to}`),
              api<{ data: TopProductRow[] }>(`/reports/top-products?from=${from}&to=${to}&limit=5`),
              api<{ data: VarianceRow[] }>(`/reports/variances?from=${nDaysAgo(30)}`),
              api<{ data: BranchRow[] }>(`/branches`),
            ])
          : Promise.resolve(null);
        const [money, rev2, ov] = await Promise.all([
          moneyP,
          reviewP,
          api<{ data: Overview }>(`/reports/overview`),
        ]);
        if (cancelled) return;
        if (money) {
          const [rev, top, vari, br] = money;
          setRevenue(rev.data);
          setTopProducts(top.data);
          setVariances(vari.data);
          setBranches(br.data);
        } else {
          setRevenue([]);
          setTopProducts([]);
          setVariances([]);
          setBranches([]);
        }
        setReviewCount(
          rev2 ? rev2.data.transfer_variances.length + rev2.data.return_approvals.length : 0,
        );
        setOverview(ov.data);
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `can` (and the `showFinance` derived from it) is session-stable;
    // depending on it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  const branchName = (id: string): string => branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  const totals = revenue.reduce(
    (acc, r) => ({
      gross: acc.gross + r.gross_ngn,
      refunds: acc.refunds + r.refunds_ngn,
      net: acc.net + r.net_ngn,
      orders: acc.orders + r.orders,
    }),
    { gross: 0, refunds: 0, net: 0, orders: 0 },
  );

  const byBranch = new Map<string, { gross: number; net: number; orders: number }>();
  for (const r of revenue) {
    const cur = byBranch.get(r.branch_id) ?? { gross: 0, net: 0, orders: 0 };
    cur.gross += r.gross_ngn;
    cur.net += r.net_ngn;
    cur.orders += r.orders;
    byBranch.set(r.branch_id, cur);
  }

  return (
    <Shell
      title="Dashboard"
      crumb="Owner"
      actions={
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label className="t-eyebrow" htmlFor="dash-from" style={{ color: "var(--ink-soft)" }}>
            From
          </label>
          <input
            id="dash-from"
            type="date"
            className="input"
            style={{ width: 150, height: 36 }}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <label className="t-eyebrow" htmlFor="dash-to" style={{ color: "var(--ink-soft)" }}>
            To
          </label>
          <input
            id="dash-to"
            type="date"
            className="input"
            style={{ width: 150, height: 36 }}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      }
    >
      <StatHero
        eyebrow="Overview"
        title="Store performance"
        sub="Revenue, orders and the things that need your attention — across every branch, poured fresh."
        bottleSlug={topProducts[0] ? slugify(topProducts[0].product_name) : "sunrise"}
      />

      {showFinance && (
        <section className="card" style={{ marginBottom: 26 }}>
          <header className="card__head">
            <h2 className="t-h2">Daily financials</h2>
            <input
              type="date"
              className="input"
              style={{ width: 160, height: 36 }}
              value={finDate}
              max={today()}
              onChange={(e) => setFinDate(e.target.value)}
            />
          </header>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 16,
            }}
          >
            {/* ── Card 1: Net revenue (nested size → type, reconciled) ── */}
            <div className="card card--soft" style={{ padding: 16 }}>
              <Stat label="Net revenue" value={ngn(daily?.net_revenue_ngn ?? 0)} tone="accent" />
              {daily && daily.revenue_by_size.length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  {daily.revenue_by_size.map((s) => (
                    <div key={s.size_ml} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                        <span>{s.size_ml}ml</span>
                        <span className="tabular-nums">{ngn(s.revenue_ngn)}</span>
                      </div>
                      {s.rows.map((r) => (
                        <div
                          key={r.category}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: 13,
                            color: "var(--ink-soft)",
                            paddingLeft: 12,
                          }}
                        >
                          <span>
                            {CATEGORY_LABEL[r.category] ?? r.category} · {r.units} × {ngn(r.avg_unit_price_ngn)} avg
                          </span>
                          <span className="tabular-nums">{ngn(r.revenue_ngn)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  <div style={{ borderTop: "1px solid var(--line)", marginTop: 8, paddingTop: 8 }}>
                    <ReconLine label="Product sales" value={ngn(daily.product_sales_ngn)} />
                    {daily.delivery_fees_ngn > 0 && (
                      <ReconLine label="+ Delivery fees" value={ngn(daily.delivery_fees_ngn)} />
                    )}
                    {daily.other_adjustments_ngn !== 0 && (
                      <ReconLine
                        label="+ Other (subscriptions/adjustments)"
                        value={ngn(daily.other_adjustments_ngn)}
                      />
                    )}
                    {daily.refunds_ngn > 0 && (
                      <ReconLine label="− Refunds" value={ngn(daily.refunds_ngn)} />
                    )}
                    <ReconLine label="= Net revenue" value={ngn(daily.net_revenue_ngn)} strong />
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 12, fontSize: 13, color: "var(--ink-soft)" }}>No sales recorded.</div>
              )}
            </div>

            {/* ── Card 2: Packaging cost (per material, grouped) ── */}
            <div className="card card--soft" style={{ padding: 16 }}>
              <Stat label="Packaging cost" value={ngn(daily?.packaging_cost_ngn ?? 0)} />
              {daily && daily.packaging_breakdown.length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  {(["bottle", "bag"] as const).map((kind) => {
                    const lines = daily.packaging_breakdown.filter((p) => p.kind === kind);
                    if (lines.length === 0) return null;
                    const subtotal = lines.reduce((s, p) => s + p.cost_ngn, 0);
                    return (
                      <div key={kind} style={{ marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                          <span>{kind === "bottle" ? "Bottles" : "Bags"}</span>
                          <span className="tabular-nums">{ngn(subtotal)}</span>
                        </div>
                        {lines.map((p) => (
                          <div
                            key={p.material_id}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: 13,
                              color: "var(--ink-soft)",
                              paddingLeft: 12,
                            }}
                          >
                            <span>
                              {p.name} · {p.units} × {ngn(p.unit_cost_ngn)}
                            </span>
                            <span className="tabular-nums">{ngn(p.cost_ngn)}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ marginTop: 12, fontSize: 13, color: "var(--ink-soft)" }}>No packaging consumed.</div>
              )}
              {daily && daily.caveats.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: "var(--warning)" }}>
                  {daily.caveats.join(" · ")}
                </div>
              )}
            </div>

            {/* ── Card 3: Profit (waterfall + margin %) ── */}
            <div className="card card--soft" style={{ padding: 16 }}>
              <Stat
                label="Daily profit"
                value={ngn(daily?.daily_profit_ngn ?? 0)}
                tone={(daily?.daily_profit_ngn ?? 0) >= 0 ? "good" : "bad"}
              />
              <div style={{ marginTop: 12 }}>
                <ReconLine label="Net revenue" value={ngn(daily?.net_revenue_ngn ?? 0)} />
                <ReconLine label="− Packaging cost" value={ngn(daily?.packaging_cost_ngn ?? 0)} />
                <ReconLine label="− Expenses" value={ngn(daily?.expenses_ngn ?? 0)} />
                <div style={{ borderTop: "1px solid var(--line)", marginTop: 8, paddingTop: 8 }}>
                  <ReconLine label="= Profit" value={ngn(daily?.daily_profit_ngn ?? 0)} strong />
                  <ReconLine
                    label="Margin"
                    value={daily?.margin_pct == null ? "—" : `${daily.margin_pct}%`}
                  />
                </div>
              </div>
            </div>
          </div>

          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>
              Which expenses count?
            </summary>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 10 }}>
              {DAILY_EXPENSE_CATEGORIES.map((cat) => (
                <label key={cat.code} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={includedCats.includes(cat.code)}
                    onChange={() => toggleCat(cat.code)}
                  />
                  {cat.label}
                </label>
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-soft)" }}>
              Bottle &amp; bag purchases are always excluded — they're counted per unit sold.
            </div>
          </details>
        </section>
      )}

      {showFinance && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: 16,
            marginBottom: 26,
          }}
          className="ed-rise"
        >
          <Stat label="Net revenue" value={ngn(totals.net)} hint={`${from} → ${to}`} tone="accent" />
          <Stat label="Gross" value={ngn(totals.gross)} hint={`${totals.orders} orders`} />
          <Stat label="Refunds" value={ngn(totals.refunds)} tone={totals.refunds > 0 ? "warn" : "default"} />
        </div>
      )}

      {overview && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: 16,
            marginBottom: 26,
          }}
          className="ed-rise"
        >
          <Stat
            label="Units sold today"
            value={String(overview.today.total_units)}
            hint={overview.today.units_by_size.map((u) => `${u.size_ml}ml: ${u.units}`).join(" · ") || "No sales yet"}
          />
          <Stat
            label="POS orders today"
            value={String(overview.fulfilment.pos_orders_today)}
            hint={`${overview.fulfilment.preorders_open} preorders · ${overview.fulfilment.bags_queue} bags`}
          />
          <Stat
            label="Online orders today"
            value={String(overview.fulfilment.online_orders_today)}
            tone={overview.fulfilment.online_pending > 0 ? "warn" : "good"}
            hint={
              overview.fulfilment.online_pending > 0
                ? `${overview.fulfilment.online_pending} awaiting fulfilment`
                : "All fulfilled"
            }
          />
          <Stat
            label="Pending transfers"
            value={String(overview.fulfilment.pending_transfers)}
            tone={overview.fulfilment.pending_transfers > 0 ? "warn" : "good"}
            hint={overview.fulfilment.pending_transfers > 0 ? "Awaiting receipt" : "All received"}
          />
          <Stat
            label="Low stock — factory"
            value={String(overview.stock.low_stock_factory)}
            tone={overview.stock.low_stock_factory > 0 ? "bad" : "good"}
            hint={`Branch: ${overview.stock.low_stock_branch} low`}
          />
          <Stat
            label="Needs review"
            value={String(reviewCount)}
            tone={reviewCount > 0 ? "warn" : "good"}
            hint={reviewCount > 0 ? "Open the inbox" : "All clear"}
          />
        </div>
      )}

      {showFinance && (
      <div className="l-split l-split--dash" style={{ marginBottom: 18 }}>
        <section className="card">
          <header className="card__head">
            <h2 className="t-h2">Branch performance</h2>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button
                type="button"
                className="btn btn--subtle btn--sm"
                disabled={revenue.length === 0}
                onClick={() =>
                  downloadCsv(
                    `revenue-${from}-to-${to}`,
                    revenue.map((r) => ({
                      branch: branchName(r.branch_id),
                      channel: r.channel,
                      gross_ngn: r.gross_ngn,
                      refunds_ngn: r.refunds_ngn,
                      net_ngn: r.net_ngn,
                      orders: r.orders,
                    })),
                  )
                }
              >
                Export CSV
              </button>
              <Link to="/owner/branches" style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>
                Manage branches →
              </Link>
            </div>
          </header>
          {loading ? (
            <InlineLoader />
          ) : byBranch.size === 0 ? (
            <div className="empty">
              <div className="empty__title">No sales in this range</div>
              Try widening the date range.
            </div>
          ) : (
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th className="table__num">Gross</th>
                    <th className="table__num">Net</th>
                    <th className="table__num">Orders</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from(byBranch.entries())
                    .sort((a, b) => b[1].net - a[1].net)
                    .map(([id, v]) => (
                      <tr key={id}>
                        <td>{branchName(id)}</td>
                        <td className="table__num">{ngn(v.gross)}</td>
                        <td className="table__num" style={{ fontWeight: 700 }}>
                          {ngn(v.net)}
                        </td>
                        <td className="table__num">{v.orders}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card__head"><h2 className="t-h2">Top products</h2></div>
          {loading ? (
            <InlineLoader />
          ) : topProducts.length === 0 ? (
            <div className="empty">No sales yet.</div>
          ) : (
            <ol style={{ display: "flex", flexDirection: "column", gap: 10, margin: 0, padding: 0, listStyle: "none" }}>
              {topProducts.map((p, idx) => (
                <li
                  key={p.product_id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "26px 46px 1fr auto",
                    alignItems: "center",
                    gap: 11,
                    padding: "8px 0",
                    borderBottom: idx === topProducts.length - 1 ? "none" : "1px solid var(--line)",
                  }}
                >
                  <span className="pill pill--grad" style={{ width: 26, height: 26, padding: 0, justifyContent: "center" }}>
                    {idx + 1}
                  </span>
                  <FlavourMedia size="chip" product={{ slug: slugify(p.product_name) }} />
                  <div>
                    <div style={{ fontWeight: 600 }}>{p.product_name}</div>
                    <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{p.quantity} sold</div>
                  </div>
                  <div className="tabular-nums" style={{ fontWeight: 700 }}>
                    {ngn(p.revenue_ngn)}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
      )}

      {showFinance && (
      <section className="card">
        <header className="card__head">
          <h2 className="t-h2">Recent variances</h2>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              disabled={variances.length === 0}
              onClick={() =>
                downloadCsv(
                  `variances-${from}-to-${to}`,
                  variances.map((v) => ({
                    business_date: v.business_date,
                    branch: branchName(v.branch_id),
                    variance_ngn: v.variance_ngn,
                  })),
                )
              }
            >
              Export CSV
            </button>
            <Link to="/owner/closes" style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>
              All closes →
            </Link>
          </div>
        </header>
        {loading ? (
          <InlineLoader />
        ) : variances.length === 0 ? (
          <div className="empty">No variances in the last 30 days. Clean books.</div>
        ) : (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Branch</th>
                  <th className="table__num">Variance</th>
                  <th><span className="sr-only">View</span></th>
                </tr>
              </thead>
              <tbody>
                {variances.slice(0, 8).map((v) => (
                  <tr key={v.daily_close_id}>
                    <td>{v.business_date}</td>
                    <td>{branchName(v.branch_id)}</td>
                    <td
                      className="table__num"
                      style={{
                        fontWeight: 700,
                        color: v.variance_ngn < 0 ? "var(--danger)" : v.variance_ngn > 0 ? "var(--warning)" : "var(--ink-soft)",
                      }}
                    >
                      {v.variance_ngn > 0 ? "+" : ""}
                      {ngn(v.variance_ngn)}
                    </td>
                    <td className="table__num">
                      <Link to="/owner/closes" className="pill pill--ink">
                        Review
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}
    </Shell>
  );
}

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
  stock: { low_stock_skus: number; expiring_48h: number };
  fulfilment: { orders_pending: number; preorders_open: number; bags_queue: number };
  today: { net_ngn: number; yesterday_net_ngn: number; wtd_net_ngn: number };
  growth: {
    month_revenue_ngn: number;
    month_expenses_ngn: number;
    month_profit_ngn: number;
    active_subscriptions: number;
    mrr_ngn: number;
    new_leads: number;
  };
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
function deltaPct(current: number, prior: number): string | undefined {
  if (prior <= 0) return undefined;
  const pct = Math.round(((current - prior) / prior) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
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
        const [rev, top, vari, br, rev2, ov] = await Promise.all([
          api<{ data: RevenueRow[] }>(`/reports/revenue?from=${from}&to=${to}`),
          api<{ data: TopProductRow[] }>(`/reports/top-products?from=${from}&to=${to}&limit=5`),
          api<{ data: VarianceRow[] }>(`/reports/variances?from=${nDaysAgo(30)}`),
          api<{ data: BranchRow[] }>(`/branches`),
          reviewP,
          api<{ data: Overview }>(`/reports/overview`),
        ]);
        if (cancelled) return;
        setRevenue(rev.data);
        setTopProducts(top.data);
        setVariances(vari.data);
        setBranches(br.data);
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
    // `can` is session-stable; depending on it would refetch on every render.
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
        <Stat
          label="Needs review"
          value={String(reviewCount)}
          tone={reviewCount > 0 ? "warn" : "good"}
          hint={reviewCount > 0 ? "Open the inbox" : "All clear"}
        />
      </div>

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
            label="Low-stock SKUs"
            value={String(overview.stock.low_stock_skus)}
            tone={overview.stock.low_stock_skus > 0 ? "bad" : "good"}
            hint={overview.stock.expiring_48h > 0 ? `${overview.stock.expiring_48h} expiring ≤48h` : "Stock healthy"}
          />
          <Stat
            label="Orders pending"
            value={String(overview.fulfilment.orders_pending)}
            tone={overview.fulfilment.orders_pending > 0 ? "warn" : "good"}
            hint={`${overview.fulfilment.preorders_open} preorders · ${overview.fulfilment.bags_queue} bags`}
          />
          {(() => {
            const d = deltaPct(overview.today.net_ngn, overview.today.yesterday_net_ngn);
            return d !== undefined ? (
              <Stat
                label="Today's sales"
                value={ngn(overview.today.net_ngn)}
                delta={d}
                hint={`Week so far ${ngn(overview.today.wtd_net_ngn)}`}
              />
            ) : (
              <Stat
                label="Today's sales"
                value={ngn(overview.today.net_ngn)}
                hint={`Week so far ${ngn(overview.today.wtd_net_ngn)}`}
              />
            );
          })()}
          <Stat
            label="Month profit"
            value={ngn(overview.growth.month_profit_ngn)}
            tone={overview.growth.month_profit_ngn >= 0 ? "good" : "bad"}
            hint={`${overview.growth.active_subscriptions} subs · ${ngn(overview.growth.mrr_ngn)} MRR · ${overview.growth.new_leads} leads`}
          />
        </div>
      )}

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
    </Shell>
  );
}

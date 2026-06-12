import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { Stat } from "../../components/Stat.js";
import { api } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";
import { downloadCsv } from "../../lib/csv.js";
import { InlineLoader } from "../../components/Spinner.js";

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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function nDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

export function DashboardPage(): JSX.Element {
  const [from, setFrom] = useState(nDaysAgo(7));
  const [to, setTo] = useState(today());
  const [revenue, setRevenue] = useState<RevenueRow[]>([]);
  const [topProducts, setTopProducts] = useState<TopProductRow[]>([]);
  const [variances, setVariances] = useState<VarianceRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [rev, top, vari, br, rev2] = await Promise.all([
          api<{ data: RevenueRow[] }>(`/reports/revenue?from=${from}&to=${to}`),
          api<{ data: TopProductRow[] }>(`/reports/top-products?from=${from}&to=${to}&limit=5`),
          api<{ data: VarianceRow[] }>(`/reports/variances?from=${nDaysAgo(30)}`),
          api<{ data: BranchRow[] }>(`/branches`),
          api<ReviewBody>(`/review`),
        ]);
        if (cancelled) return;
        setRevenue(rev.data);
        setTopProducts(top.data);
        setVariances(vari.data);
        setBranches(br.data);
        setReviewCount(
          rev2.data.transfer_variances.length + rev2.data.return_approvals.length,
        );
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
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
      <div className="page-head ed-rise">
        <div className="page-head__titles">
          <div className="page-head__eyebrow">Overview</div>
          <h1 className="page-head__title">Store performance</h1>
          <p className="page-head__sub">
            Revenue, orders and items that need your attention across every branch.
          </p>
        </div>
      </div>

      {error && (
        <div
          className="card"
          style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}
        >
          {error}
        </div>
      )}

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

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr",
          gap: 18,
          marginBottom: 18,
        }}
      >
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
                    gridTemplateColumns: "28px 1fr auto",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 0",
                    borderBottom: idx === topProducts.length - 1 ? "none" : "1px solid var(--line)",
                  }}
                >
                  <span className="pill pill--grad" style={{ width: 28, height: 28, padding: 0, justifyContent: "center" }}>
                    {idx + 1}
                  </span>
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

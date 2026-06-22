import { useEffect, useMemo, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { Stat } from "../../components/Stat.js";
import { FlavourMedia } from "../../components/FlavourMedia.js";
import { InlineLoader } from "../../components/Spinner.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";
import { toast } from "../../lib/toast.js";
import { channelLabel } from "../../lib/analytics-theme.js";
import {
  deriveKpis,
  deriveChannelMix,
  deriveBranchMix,
  deriveCategoryMix,
  type RevenueRow,
  type TopProductRow,
  type ProductRow,
  type BranchRow,
  type TimePoint,
} from "../../lib/analytics-derive.js";
import {
  TrendChart,
  MixDonut,
  BranchBars,
  PnlBars,
  Sparkline,
} from "../../components/AnalyticsCharts.js";

interface Pnl {
  month: string;
  net_revenue_ngn: number;
  expenses_total_ngn: number;
  net_ngn: number;
  expenses_by_category: Array<{ category_code: string; label: string; amount_ngn: number }>;
}

const slugify = (v: string): string =>
  v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const nDaysAgo = (n: number): string => iso(new Date(Date.now() - n * 86_400_000));
const thisMonth = (): string => new Date().toISOString().slice(0, 7);

const PRESETS = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

export function AnalyticsPage(): JSX.Element {
  const [from, setFrom] = useState(nDaysAgo(30));
  const [to, setTo] = useState(iso(new Date()));
  const [month, setMonth] = useState(thisMonth());

  const [series, setSeries] = useState<TimePoint[]>([]);
  const [revenue, setRevenue] = useState<RevenueRow[]>([]);
  const [top, setTop] = useState<TopProductRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [loading, setLoading] = useState(true);

  // Wide ranges bucket weekly so the x-axis stays readable.
  const interval = useMemo(() => {
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    return days > 60 ? "week" : "day";
  }, [from, to]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [ts, rev, tp, prod, br] = await Promise.all([
          api<{ data: TimePoint[] }>(`/reports/timeseries?from=${from}&to=${to}&interval=${interval}`),
          api<{ data: RevenueRow[] }>(`/reports/revenue?from=${from}&to=${to}`),
          api<{ data: TopProductRow[] }>(`/reports/top-products?from=${from}&to=${to}&limit=6`),
          api<{ data: ProductRow[] }>(`/products`),
          api<{ data: BranchRow[] }>(`/branches`),
        ]);
        if (cancelled) return;
        setSeries(ts.data);
        setRevenue(rev.data);
        setTop(tp.data);
        setProducts(prod.data);
        setBranches(br.data);
      } catch (err) {
        if (!cancelled) toast.error(humanizeError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [from, to, interval]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ data: Pnl }>(`/reports/pnl?month=${month}`);
        if (!cancelled) setPnl(res.data);
      } catch (err) {
        if (!cancelled) toast.error(humanizeError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [month]);

  const kpis = useMemo(() => deriveKpis(revenue), [revenue]);
  const channelMix = useMemo(() => deriveChannelMix(revenue, channelLabel), [revenue]);
  const branchMix = useMemo(() => deriveBranchMix(revenue, branches), [revenue, branches]);
  const categoryMix = useMemo(() => deriveCategoryMix(top, products), [top, products]);

  const hasSales = kpis.gross > 0 || kpis.orders > 0;
  const activePreset = PRESETS.find((p) => from === nDaysAgo(p.days) && to === iso(new Date()))?.days ?? null;

  return (
    <Shell
      title="Analytics"
      crumb="Owner"
      actions={
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {PRESETS.map((p) => (
            <button
              key={p.days}
              type="button"
              className={`btn btn--sm ${activePreset === p.days ? "btn--primary" : "btn--subtle"}`}
              onClick={() => {
                setFrom(nDaysAgo(p.days));
                setTo(iso(new Date()));
              }}
            >
              {p.label}
            </button>
          ))}
          <input type="date" className="input" style={{ width: 150, height: 36 }} value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          <input type="date" className="input" style={{ width: 150, height: 36 }} value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        </div>
      }
    >
      <section className="juice-hero ed-rise">
        <div className="juice-hero__body">
          <div className="juice-hero__eyebrow">Analytics</div>
          <h1 className="juice-hero__title">Business performance</h1>
          <p className="juice-hero__sub">
            How revenue, channels, branches and flavours are trending — {from} → {to}.
          </p>
        </div>
      </section>

      {/* KPI band */}
      <div
        className="ed-rise"
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16, marginBottom: 22 }}
      >
        <Stat label="Net revenue" value={ngn(kpis.net)} tone="accent">
          <Sparkline data={series} dataKey="net_ngn" color="#1f7a44" />
        </Stat>
        <Stat label="Orders" value={String(kpis.orders)}>
          <Sparkline data={series} dataKey="orders" color="#e85d1c" />
        </Stat>
        <Stat label="Avg order value" value={ngn(kpis.avgOrder)} />
        <Stat
          label="Refund rate"
          value={`${(kpis.refundRate * 100).toFixed(1)}%`}
          tone={kpis.refundRate > 0.05 ? "warn" : "good"}
          hint={ngn(kpis.refunds)}
        />
      </div>

      {/* Trend */}
      <section className="card glass-card" style={{ marginBottom: 18 }}>
        <div className="card__head"><h2 className="t-h2">Revenue &amp; orders</h2></div>
        {loading ? <InlineLoader /> : hasSales ? <TrendChart data={series} /> : <EmptyChart note="No sales in this range yet." />}
      </section>

      {/* Channel + branch */}
      <div className="l-split l-split--dash" style={{ marginBottom: 18 }}>
        <section className="card glass-card">
          <div className="card__head"><h2 className="t-h2">Revenue by channel</h2></div>
          {channelMix.length > 0 ? <MixDonut data={channelMix} /> : <EmptyChart note="No channel data yet." />}
        </section>
        <section className="card glass-card">
          <div className="card__head"><h2 className="t-h2">Branch comparison</h2></div>
          {branchMix.length > 0 ? <BranchBars data={branchMix} /> : <EmptyChart note="No branch sales yet." />}
        </section>
      </div>

      {/* Products + category */}
      <div className="l-split l-split--dash" style={{ marginBottom: 18 }}>
        <section className="card glass-card">
          <div className="card__head"><h2 className="t-h2">Top flavours</h2></div>
          {top.length > 0 ? (
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {top.map((p, idx) => (
                <li
                  key={p.product_id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "24px 44px 1fr auto",
                    alignItems: "center",
                    gap: 11,
                    padding: "8px 0",
                    borderBottom: idx === top.length - 1 ? "none" : "1px solid var(--line)",
                  }}
                >
                  <span className="pill pill--grad" style={{ width: 24, height: 24, padding: 0, justifyContent: "center" }}>{idx + 1}</span>
                  <FlavourMedia size="chip" product={{ slug: slugify(p.product_name) }} />
                  <div>
                    <div style={{ fontWeight: 600 }}>{p.product_name}</div>
                    <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{p.quantity} sold</div>
                  </div>
                  <div className="tabular-nums" style={{ fontWeight: 700 }}>{ngn(p.revenue_ngn)}</div>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyChart note="No products sold yet." />
          )}
        </section>
        <section className="card glass-card">
          <div className="card__head"><h2 className="t-h2">Revenue by category</h2></div>
          {categoryMix.length > 0 ? <MixDonut data={categoryMix} /> : <EmptyChart note="No category data yet." />}
        </section>
      </div>

      {/* P&L */}
      <section className="card glass-card">
        <header className="card__head">
          <h2 className="t-h2">Profit &amp; loss</h2>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input type="month" className="input" style={{ width: 160, height: 36 }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="P&L month" />
            <button type="button" className="btn btn--subtle btn--sm" onClick={() => window.open(`/v1/reports/pnl?month=${month}&format=csv`, "_blank")}>
              Export CSV
            </button>
          </div>
        </header>
        {!pnl ? (
          <InlineLoader />
        ) : (
          <div className="l-split l-split--dash">
            <div>
              <PnlBars netRevenue={pnl.net_revenue_ngn} expenses={pnl.expenses_total_ngn} net={pnl.net_ngn} />
              <div style={{ marginTop: 10, fontSize: 13, color: "var(--ink-soft)" }}>
                Net profit for {pnl.month}:{" "}
                <strong style={{ color: pnl.net_ngn >= 0 ? "var(--success-ink)" : "var(--danger-ink)" }}>{ngn(pnl.net_ngn)}</strong>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-soft)", marginBottom: 8 }}>Expenses by category</div>
              {pnl.expenses_by_category.length > 0 ? (
                <MixDonut data={pnl.expenses_by_category.map((e) => ({ key: e.category_code, label: e.label, value: e.amount_ngn }))} />
              ) : (
                <EmptyChart note="No expenses recorded this month." />
              )}
            </div>
          </div>
        )}
      </section>
    </Shell>
  );
}

function EmptyChart({ note }: { note: string }): JSX.Element {
  return (
    <div className="empty" style={{ border: 0, padding: "40px 20px" }}>
      {note}
    </div>
  );
}

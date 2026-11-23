import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  ClipboardCheck,
  CreditCard,
  PackageCheck,
  RotateCcw,
  ShoppingBag,
  Truck,
} from "lucide-react";
import { Shell } from "../../components/Shell.js";
import { FlavourMedia } from "../../components/FlavourMedia.js";
import { RevenueTrend, type TrendPoint } from "../../components/RevenueTrend.js";
import { api, humanizeError } from "../../lib/api.js";
import { useAuthUser, useCan } from "../../lib/auth.js";
import { ngn } from "../../lib/format.js";
import { dayLabel } from "../../lib/date-labels.js";
import { downloadCsv } from "../../lib/csv.js";
import { getFlavourVisual } from "../../lib/flavour-visuals.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import {
  buildNeeds,
  channelTotals,
  greeting,
  heroStamp,
  lagosDate,
  lagosDaysAgo,
  lagosMonthStart,
  lagosWeekStart,
  type NeedItem,
  type OverviewData,
  type ReviewData,
} from "../../lib/overview-logic.js";
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
  kind: "bottle" | "bag" | "straw";
  units: number;
  unit_cost_ngn: number;
  cost_ngn: number;
}
interface DailyFinancials {
  from: string;
  to: string;
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

// Top-products returns a name but no slug; derive one so the right bottle shows.
function slugify(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

type DashPeriod = "today" | "week" | "month" | "custom";
const PERIOD_WORD: Record<DashPeriod, string> = {
  today: "today",
  week: "this week",
  month: "this month",
  custom: "in this range",
};

function rangeLabel(from: string, to: string): string {
  const fmt = (s: string): string =>
    new Date(`${s}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`;
}

const CATEGORY_LABEL: Record<string, string> = { regular: "Regular", special: "Special", punch: "Punch" };

const NEED_ICON: Record<string, JSX.Element> = {
  close: <ClipboardCheck aria-hidden="true" />,
  xfer: <Truck aria-hidden="true" />,
  ret: <RotateCcw aria-hidden="true" />,
  payments: <CreditCard aria-hidden="true" />,
  online: <ShoppingBag aria-hidden="true" />,
  lowstock: <Boxes aria-hidden="true" />,
  expiring: <AlertTriangle aria-hidden="true" />,
};

function ReconLine({ label, value, strong }: { label: string; value: string; strong?: boolean }): JSX.Element {
  return (
    <div className={`ov-recon${strong ? " ov-recon--strong" : ""}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/** Margin ring: one value, so a single arc on a track. */
function MarginRing({ pct }: { pct: number | null }): JSX.Element {
  const r = 26;
  const c = 2 * Math.PI * r;
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <svg className="ov-ring" viewBox="0 0 62 62" role="img" aria-label={pct == null ? "Margin not available" : `Margin ${pct}%`}>
      <circle cx="31" cy="31" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
      <circle
        cx="31" cy="31" r={r} fill="none" stroke="var(--leaf)" strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 31 31)"
      />
      <text x="31" y="35" textAnchor="middle" className="ov-ring__t">{pct == null ? "—" : `${Math.round(pct)}%`}</text>
    </svg>
  );
}

function NeedCard({ item }: { item: NeedItem }): JSX.Element {
  const kind = item.key.split("-")[0]!;
  return (
    <Link to={item.to} className="ov-need">
      <span className={`ov-need__ic t-${item.tone}`}>{NEED_ICON[kind] ?? <AlertTriangle aria-hidden="true" />}</span>
      <span className="ov-need__txt">
        <b>{item.title}</b>
        <small>{item.detail}</small>
      </span>
      <span className="ov-need__act">{item.action}</span>
    </Link>
  );
}

export function DashboardPage(): JSX.Element {
  const user = useAuthUser();
  const can = useCan();
  // finance.daily gates the money cards (owner, admin, manager).
  const showFinance = can("finance.daily");
  const canReview = can("orders.manage");

  const [period, setPeriod] = useState<DashPeriod>("today");
  const [from, setFrom] = useState(lagosDate());
  const [to, setTo] = useState(lagosDate());
  const [revenue, setRevenue] = useState<RevenueRow[]>([]);
  const [topProducts, setTopProducts] = useState<TopProductRow[]>([]);
  const [variances, setVariances] = useState<VarianceRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [includedCats, setIncludedCats] = useState<DailyExpenseCategory[]>(getIncludedExpenseCategories());
  const [daily, setDaily] = useState<DailyFinancials | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Keep the hero clock current without a reload.
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  function applyPeriod(p: DashPeriod): void {
    setPeriod(p);
    const today = lagosDate();
    if (p === "today") { setFrom(today); setTo(today); }
    else if (p === "week") { setFrom(lagosWeekStart()); setTo(today); }
    else if (p === "month") { setFrom(lagosMonthStart()); setTo(today); }
  }

  useEffect(() => {
    if (!showFinance) return;
    let cancelled = false;
    void (async () => {
      try {
        const qs = `from=${from}&to=${to}&expense_categories=${includedCats.join(",")}`;
        const res = await api<{ data: DailyFinancials }>(`/reports/daily?${qs}`);
        if (!cancelled) setDaily(res.data);
      } catch (err) {
        if (!cancelled) toast.error(humanizeError(err));
      }
    })();
    return () => { cancelled = true; };
  }, [showFinance, from, to, includedCats]);

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
        // One forbidden optional widget must never blank the whole page.
        const reviewP = canReview
          ? api<{ data: ReviewData }>(`/review`).then((r) => r.data).catch(() => null)
          : Promise.resolve(null);
        // Money payloads only travel to finance roles.
        const moneyP = showFinance
          ? Promise.all([
              api<{ data: RevenueRow[] }>(`/reports/revenue?from=${from}&to=${to}`),
              api<{ data: TopProductRow[] }>(`/reports/top-products?from=${from}&to=${to}&limit=6`),
              api<{ data: VarianceRow[] }>(`/reports/variances?from=${lagosDaysAgo(30)}`),
              api<{ data: BranchRow[] }>(`/branches`),
              api<{ data: TrendPoint[] }>(`/reports/timeseries?from=${lagosDaysAgo(13)}&to=${lagosDate()}&interval=day`)
                .catch(() => ({ data: [] as TrendPoint[] })),
            ])
          : Promise.resolve(null);
        const [money, rev, ov] = await Promise.all([
          moneyP,
          reviewP,
          api<{ data: OverviewData }>(`/reports/overview`).then((r) => r.data).catch(() => null),
        ]);
        if (cancelled) return;
        setRevenue(money?.[0].data ?? []);
        setTopProducts(money?.[1].data ?? []);
        setVariances(money?.[2].data ?? []);
        setBranches(money?.[3].data ?? []);
        setTrend(money?.[4].data ?? []);
        setReview(rev);
        setOverview(ov);
      } catch (err) {
        if (!cancelled) toast.error(humanizeError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // `can` is session-stable; depending on it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  const branchName = (id: string): string => branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  const totals = useMemo(
    () =>
      revenue.reduce(
        (acc, r) => ({ gross: acc.gross + r.gross_ngn, refunds: acc.refunds + r.refunds_ngn, net: acc.net + r.net_ngn, orders: acc.orders + r.orders }),
        { gross: 0, refunds: 0, net: 0, orders: 0 },
      ),
    [revenue],
  );
  const byBranch = useMemo(() => {
    const m = new Map<string, { gross: number; net: number; orders: number }>();
    for (const r of revenue) {
      const cur = m.get(r.branch_id) ?? { gross: 0, net: 0, orders: 0 };
      cur.gross += r.gross_ngn;
      cur.net += r.net_ngn;
      cur.orders += r.orders;
      m.set(r.branch_id, cur);
    }
    return m;
  }, [revenue]);
  const channels = useMemo(() => channelTotals(revenue), [revenue]);
  const channelSum = channels.reduce((s, c) => s + c.net, 0);
  const needs = useMemo(() => buildNeeds(review, overview), [review, overview]);
  const trendTotal = trend.reduce((s, p) => s + p.net_ngn, 0);

  const top = topProducts[0];
  const topVisual = getFlavourVisual({ slug: top ? slugify(top.product_name) : "sunrise" });
  const word = PERIOD_WORD[period];
  const name = user.role === "owner" ? "Mrs. Samuel" : (user.email?.split("@")[0] ?? "there");
  const tagline = top
    ? <>{top.product_name} is pouring fast {word}.</>
    : <>A fresh day at the counter.</>;

  // Waterfall: every bar is a share of money in (sales + delivery).
  const moneyIn = daily ? daily.product_sales_ngn + daily.delivery_fees_ngn + Math.max(0, daily.other_adjustments_ngn) : 0;
  const pct = (v: number): string => `${moneyIn > 0 ? Math.min(100, (Math.abs(v) / moneyIn) * 100) : 0}%`;
  const shelfMax = Math.max(1, ...topProducts.map((p) => p.quantity));

  return (
    <Shell
      title="Dashboard"
      crumb="Owner"
      actions={
        <div className="ov-head-actions">
          <div className="ov-periods" role="group" aria-label="Period">
            {([
              ["today", "Today"],
              ["week", "This week"],
              ["month", "This month"],
              ["custom", "Custom"],
            ] as Array<[DashPeriod, string]>).map(([key, label]) => (
              <button key={key} type="button" className={period === key ? "on" : ""} aria-pressed={period === key} onClick={() => applyPeriod(key)}>
                {label}
              </button>
            ))}
          </div>
          {period === "custom" && (
            <div className="ov-dates">
              <label htmlFor="dash-from">From</label>
              <input id="dash-from" type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
              <label htmlFor="dash-to">To</label>
              <input id="dash-to" type="date" className="input" value={to} min={from} max={lagosDate()} onChange={(e) => setTo(e.target.value)} />
            </div>
          )}
        </div>
      }
    >
      <div className="ov">
        {/* ═════════ Hero ═════════ */}
        <section className="ov-hero">
          <img className="ov-hero__cluster" src="/flavours/decor/cluster-citrus.png" alt="" aria-hidden="true" />
          <img className="ov-hero__splash" src={topVisual.splash} alt="" aria-hidden="true" />
          <img className="ov-hero__bottle" src={topVisual.bottle} alt="" aria-hidden="true" />
          <div className="ov-hero__eb">{heroStamp(now)}</div>
          <h1>
            {greeting(now)}, {name}.<br />
            <em>{tagline}</em>
          </h1>
          <p>Takings, bottles, deliveries and anything waiting on you, across the factory, the shops and online.</p>
          <div className="ov-chips">
            {showFinance ? (
              <>
                <div className="ov-chip ov-chip--hot"><b className="tabular-nums">{ngn(daily?.net_revenue_ngn ?? totals.net)}</b><span>Net revenue {word}</span></div>
                <div className="ov-chip"><b className="tabular-nums">{daily?.total_units ?? 0}</b><span>Bottles sold</span></div>
                <div className="ov-chip"><b className="tabular-nums">{totals.orders}</b><span>Orders {word}</span></div>
                <div className="ov-chip"><b className="tabular-nums">{daily?.margin_pct == null ? "—" : `${daily.margin_pct}%`}</b><span>Margin</span></div>
              </>
            ) : (
              <>
                <div className="ov-chip ov-chip--hot"><b className="tabular-nums">{overview?.today.total_units ?? 0}</b><span>Bottles sold today</span></div>
                <div className="ov-chip"><b className="tabular-nums">{overview?.fulfilment.pos_orders_today ?? 0}</b><span>Till orders today</span></div>
                <div className="ov-chip"><b className="tabular-nums">{overview?.fulfilment.online_orders_today ?? 0}</b><span>Online orders today</span></div>
              </>
            )}
          </div>
        </section>

        {/* ═════════ Needs you now ═════════ */}
        <div className="ov-sh">
          <h2>Needs you now</h2>
          <p>{loading ? "Checking…" : needs.length === 0 ? "Nothing waiting" : `${needs.length} ${needs.length === 1 ? "thing" : "things"} waiting`}</p>
          {canReview && <Link to="/owner/review">Open Needs review <ArrowRight aria-hidden="true" /></Link>}
        </div>
        {loading ? (
          <InlineLoader />
        ) : needs.length === 0 ? (
          <div className="ov-clear"><PackageCheck aria-hidden="true" /> All clear. Nothing needs you right now.</div>
        ) : (
          <div className="ov-needs">{needs.map((n) => <NeedCard key={n.key} item={n} />)}</div>
        )}

        {showFinance && (
          <>
            {/* ═════════ Sales & money ═════════ */}
            <div className="ov-sh">
              <h2>Sales &amp; money</h2>
              <p>{rangeLabel(daily?.from ?? from, daily?.to ?? to)} · bottles and bags costed per unit sold</p>
            </div>
            <div className="ov-grid ov-grid--main">
              <section className="card ov-card">
                <div className="ov-ch">
                  <h3>Net revenue, last 14 days</h3>
                </div>
                <div className="ov-big">
                  <b className="tabular-nums">{ngn(trendTotal)}</b>
                  <span>across {trend.reduce((s, p) => s + p.orders, 0)} orders</span>
                </div>
                <RevenueTrend points={trend} />
                <div className="ov-channels">
                  <div className="ov-ch-title">By channel, {word}</div>
                  {channels.length === 0 ? (
                    <div className="ov-muted">No sales {word} yet.</div>
                  ) : (
                    <>
                      <div className="ov-cbar" role="img" aria-label={channels.map((c) => `${c.label} ${ngn(c.net)}`).join(", ")}>
                        {channels.map((c) => (
                          <i key={c.key} style={{ width: `${(c.net / channelSum) * 100}%`, background: `var(${c.varName})` }} />
                        ))}
                      </div>
                      <div className="ov-clegend">
                        {channels.map((c) => (
                          <span key={c.key}>
                            <i style={{ background: `var(${c.varName})` }} />
                            {c.label}
                            <b className="tabular-nums">{ngn(c.net)}</b>
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </section>

              <section className="card ov-card">
                <div className="ov-ch">
                  <h3>Money {word}</h3>
                </div>
                {!daily ? (
                  <InlineLoader />
                ) : (
                  <>
                    <div className="ov-wf">
                      <div className="ov-wr"><span className="l">Juice sales</span><span className="t"><i style={{ width: pct(daily.product_sales_ngn), background: "var(--leaf-2)" }} /></span><span className="v tabular-nums">{ngn(daily.product_sales_ngn)}</span></div>
                      {daily.delivery_fees_ngn > 0 && (
                        <div className="ov-wr"><span className="l">Delivery fees</span><span className="t"><i style={{ width: pct(daily.delivery_fees_ngn), background: "var(--leaf-2)" }} /></span><span className="v tabular-nums">{ngn(daily.delivery_fees_ngn)}</span></div>
                      )}
                      {daily.refunds_ngn > 0 && (
                        <div className="ov-wr"><span className="l">Refunds</span><span className="t"><i style={{ width: pct(daily.refunds_ngn), background: "var(--bad)" }} /></span><span className="v tabular-nums">−{ngn(daily.refunds_ngn)}</span></div>
                      )}
                      <div className="ov-wr"><span className="l">Bottles &amp; bags</span><span className="t"><i style={{ width: pct(daily.packaging_cost_ngn), background: "var(--orange)" }} /></span><span className="v tabular-nums">−{ngn(daily.packaging_cost_ngn)}</span></div>
                      <div className="ov-wr"><span className="l">Expenses</span><span className="t"><i style={{ width: pct(daily.expenses_ngn), background: "var(--orange)" }} /></span><span className="v tabular-nums">−{ngn(daily.expenses_ngn)}</span></div>
                    </div>
                    <div className="ov-profit">
                      <div>
                        <small>Profit {word}</small>
                        <b className={`tabular-nums${daily.daily_profit_ngn < 0 ? " neg" : ""}`}>{ngn(daily.daily_profit_ngn)}</b>
                        <small>after bottles, bags and the expenses you count</small>
                      </div>
                      <MarginRing pct={daily.margin_pct} />
                    </div>
                    {daily.caveats.length > 0 && <div className="ov-caveat">{daily.caveats.join(" · ")}</div>}
                    <details className="ov-details">
                      <summary>Which expenses count?</summary>
                      <div className="ov-cats">
                        {DAILY_EXPENSE_CATEGORIES.map((cat) => (
                          <label key={cat.code}>
                            <input type="checkbox" checked={includedCats.includes(cat.code)} onChange={() => toggleCat(cat.code)} />
                            {cat.label}
                          </label>
                        ))}
                      </div>
                      <div className="ov-muted">Bottle &amp; bag purchases are always left out: they're counted per unit sold.</div>
                    </details>
                  </>
                )}
              </section>
            </div>

            {/* ═════════ Financials: the full breakdown, always open ═════════ */}
            {daily && (
              <>
                <div className="ov-sh">
                  <h2>Financials</h2>
                  <p>{rangeLabel(daily.from, daily.to)}</p>
                </div>
                <div className="ov-fin">
                  <section className="card ov-card ov-fin__card">
                    <div className="ov-fin__head">
                      <span>Net revenue</span>
                      <b className="tabular-nums">{ngn(daily.net_revenue_ngn)}</b>
                    </div>
                    {daily.revenue_by_size.length === 0 ? (
                      <div className="ov-muted">No sales recorded.</div>
                    ) : (
                      <>
                        {daily.revenue_by_size.map((s) => (
                          <div key={s.size_ml} className="ov-fin__grp">
                            <ReconLine label={`${s.size_ml}ml`} value={ngn(s.revenue_ngn)} strong />
                            {s.rows.map((r) => (
                              <ReconLine
                                key={r.category}
                                label={`${CATEGORY_LABEL[r.category] ?? r.category} · ${r.units} × ${ngn(r.avg_unit_price_ngn)} avg`}
                                value={ngn(r.revenue_ngn)}
                              />
                            ))}
                          </div>
                        ))}
                        <div className="ov-fin__sum">
                          <ReconLine label="Product sales" value={ngn(daily.product_sales_ngn)} />
                          {daily.delivery_fees_ngn > 0 && <ReconLine label="+ Delivery fees" value={ngn(daily.delivery_fees_ngn)} />}
                          {daily.other_adjustments_ngn !== 0 && <ReconLine label="+ Other adjustments" value={ngn(daily.other_adjustments_ngn)} />}
                          {daily.refunds_ngn > 0 && <ReconLine label="− Refunds" value={ngn(daily.refunds_ngn)} />}
                          <ReconLine label="= Net revenue" value={ngn(daily.net_revenue_ngn)} strong />
                        </div>
                      </>
                    )}
                  </section>

                  <section className="card ov-card ov-fin__card">
                    <div className="ov-fin__head">
                      <span>Packaging cost</span>
                      <b className="tabular-nums">{ngn(daily.packaging_cost_ngn)}</b>
                    </div>
                    {daily.packaging_breakdown.length === 0 ? (
                      <div className="ov-muted">No packaging used.</div>
                    ) : (
                      (["bottle", "bag", "straw"] as const).map((kind) => {
                        const lines = daily.packaging_breakdown.filter((p) => p.kind === kind);
                        if (lines.length === 0) return null;
                        return (
                          <div key={kind} className="ov-fin__grp">
                            <ReconLine
                              label={kind === "bottle" ? "Bottles" : kind === "bag" ? "Bags" : "Straws"}
                              value={ngn(lines.reduce((t, p) => t + p.cost_ngn, 0))}
                              strong
                            />
                            {lines.map((p) => (
                              <ReconLine key={p.material_id} label={`${p.name} · ${p.units} × ${ngn(p.unit_cost_ngn)}`} value={ngn(p.cost_ngn)} />
                            ))}
                          </div>
                        );
                      })
                    )}
                    {(() => {
                      // Anything in the total that no line explains, shown so the card adds up.
                      const gap = daily.packaging_cost_ngn - daily.packaging_breakdown.reduce((t, p) => t + p.cost_ngn, 0);
                      return gap !== 0 ? (
                        <div className="ov-fin__grp"><ReconLine label="Other packaging (not itemised)" value={ngn(gap)} /></div>
                      ) : null;
                    })()}
                    {daily.caveats.length > 0 && <div className="ov-caveat ov-caveat--in">{daily.caveats.join(" · ")}</div>}
                  </section>

                  <section className="card ov-card ov-fin__card">
                    <div className="ov-fin__head">
                      <span>Profit</span>
                      <b className={`tabular-nums${daily.daily_profit_ngn < 0 ? " neg" : " pos"}`}>{ngn(daily.daily_profit_ngn)}</b>
                    </div>
                    <div className="ov-fin__grp">
                      <ReconLine label="Net revenue" value={ngn(daily.net_revenue_ngn)} />
                      <ReconLine label="− Packaging cost" value={ngn(daily.packaging_cost_ngn)} />
                      <ReconLine label="− Expenses" value={ngn(daily.expenses_ngn)} />
                    </div>
                    <div className="ov-fin__sum">
                      <ReconLine label="= Profit" value={ngn(daily.daily_profit_ngn)} strong />
                      <ReconLine label="Margin" value={daily.margin_pct == null ? "—" : `${daily.margin_pct}%`} />
                    </div>
                    {daily.expenses_ngn > daily.net_revenue_ngn && (
                      <div className="ov-caveat ov-caveat--in">
                        Expenses are more than today's takings. If rent or salaries are counted here, untick them under "Which expenses count?".
                      </div>
                    )}
                  </section>
                </div>
              </>
            )}

            {/* ═════════ On the shelf ═════════ */}
            <div className="ov-sh">
              <h2>On the shelf {word}</h2>
              <p>Top flavours by bottles sold</p>
              <Link to="/owner/products">All products <ArrowRight aria-hidden="true" /></Link>
            </div>
            {loading ? (
              <InlineLoader />
            ) : topProducts.length === 0 ? (
              <div className="ov-clear">No bottles sold {word} yet.</div>
            ) : (
              <div className="ov-shelf">
                {topProducts.map((p, i) => {
                  const v = getFlavourVisual({ slug: slugify(p.product_name) });
                  return (
                    <div key={p.product_id} className="ov-fl" style={{ "--s": v.surface, "--c": v.accent } as CSSProperties}>
                      <span className="ov-fl__rank">#{i + 1}</span>
                      <FlavourMedia size="tile" product={{ slug: slugify(p.product_name) }} />
                      <b>{p.product_name}</b>
                      <div className="ov-fl__meta tabular-nums">
                        <span>{p.quantity} sold</span>
                        <span>{ngn(p.revenue_ngn)}</span>
                      </div>
                      <div className="ov-fl__bar"><i style={{ width: `${(p.quantity / shelfMax) * 100}%` }} /></div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ═════════ Orders on the move ═════════ */}
        {overview && (
          <>
            <div className="ov-sh">
              <h2>Orders on the move</h2>
              <p>Live today across the till, online and the factory</p>
            </div>
            <div className="ov-grid ov-grid--ops">
              <section className="card ov-card">
                <div className="ov-ch">
                  <h3>Orders today</h3>
                  <div className="r">
                    {overview.fulfilment.online_pending > 0
                      ? <span className="tag t-warn">{overview.fulfilment.online_pending} awaiting fulfilment</span>
                      : <span className="tag t-good">All fulfilled</span>}
                  </div>
                </div>
                <div className="ov-pipe">
                  <Link to="/owner/orders"><b className="tabular-nums">{overview.fulfilment.pos_orders_today}</b><span>At the till</span></Link>
                  <Link to="/owner/online-orders"><b className="tabular-nums">{overview.fulfilment.online_orders_today}</b><span>Online</span></Link>
                  <Link to="/owner/online-orders" className={overview.fulfilment.online_pending > 0 ? "hot" : ""}><b className="tabular-nums">{overview.fulfilment.online_pending}</b><span>To fulfil</span></Link>
                  <Link to="/owner/preorders"><b className="tabular-nums">{overview.fulfilment.preorders_open}</b><span>Preorders open</span></Link>
                  <Link to="/owner/orders"><b className="tabular-nums">{overview.fulfilment.bags_queue}</b><span>Bags to pack</span></Link>
                  <Link to="/owner/transfers"><b className="tabular-nums">{overview.fulfilment.pending_transfers}</b><span>Transfers on the way</span></Link>
                </div>
                {overview.today.units_by_size.length > 0 && (
                  <div className="ov-sizes">
                    {overview.today.units_by_size.map((u) => (
                      <span key={u.size_ml} className="tag t-mute tabular-nums">{u.size_ml}ml · {u.units}</span>
                    ))}
                  </div>
                )}
              </section>
              <section className="card ov-card">
                <div className="ov-ch">
                  <h3>Stock</h3>
                  <div className="r"><Link to="/owner/inventory" className="ov-link">Inventory <ArrowRight aria-hidden="true" /></Link></div>
                </div>
                <div className="ov-stock">
                  <div><span>Low at the factory</span><span className={`tag ${overview.stock.low_stock_factory > 0 ? "t-bad" : "t-good"}`}>{overview.stock.low_stock_factory > 0 ? `${overview.stock.low_stock_factory} low` : "OK"}</span></div>
                  <div><span>Low at the shops</span><span className={`tag ${overview.stock.low_stock_branch > 0 ? "t-warn" : "t-good"}`}>{overview.stock.low_stock_branch > 0 ? `${overview.stock.low_stock_branch} low` : "OK"}</span></div>
                  <div><span>Expiring within 48 hours</span><span className={`tag ${overview.stock.expiring_48h > 0 ? "t-warn" : "t-good"}`}>{overview.stock.expiring_48h > 0 ? `${overview.stock.expiring_48h} batches` : "None"}</span></div>
                  <div><span>Transfers on the way</span><span className="tag t-mute">{overview.fulfilment.pending_transfers}</span></div>
                </div>
              </section>
            </div>
          </>
        )}

        {showFinance && (
          <>
            {/* ═════════ Shops & the till ═════════ */}
            <div className="ov-sh">
              <h2>Shops &amp; the till</h2>
              <p>How each branch is selling, and how shift-end counts are landing</p>
            </div>
            <div className="ov-grid ov-grid--ops">
              <section className="card ov-card">
                <div className="ov-ch">
                  <h3>Branch performance</h3>
                  <div className="r">
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      disabled={revenue.length === 0}
                      onClick={() =>
                        downloadCsv(
                          `revenue-${from}-to-${to}`,
                          revenue.map((r) => ({ branch: branchName(r.branch_id), channel: r.channel, gross_ngn: r.gross_ngn, refunds_ngn: r.refunds_ngn, net_ngn: r.net_ngn, orders: r.orders })),
                        )
                      }
                    >
                      Export CSV
                    </button>
                  </div>
                </div>
                {loading ? (
                  <InlineLoader />
                ) : byBranch.size === 0 ? (
                  <div className="ov-muted ov-pad">No sales {word}.</div>
                ) : (
                  <div className="table-wrap" style={{ border: 0 }}>
                    <table className="table">
                      <thead>
                        <tr><th>Branch</th><th className="table__num">Gross</th><th className="table__num">Net</th><th className="table__num">Orders</th></tr>
                      </thead>
                      <tbody>
                        {Array.from(byBranch.entries()).sort((a, b) => b[1].net - a[1].net).map(([id, v]) => (
                          <tr key={id}>
                            <td>{branchName(id)}</td>
                            <td className="table__num">{ngn(v.gross)}</td>
                            <td className="table__num" style={{ fontWeight: 700 }}>{ngn(v.net)}</td>
                            <td className="table__num">{v.orders}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section className="card ov-card">
                <div className="ov-ch">
                  <h3>Shift-end differences</h3>
                  <div className="r">
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      disabled={variances.length === 0}
                      onClick={() =>
                        downloadCsv(
                          `variances-last-30-days`,
                          variances.map((v) => ({ business_date: v.business_date, branch: branchName(v.branch_id), variance_ngn: v.variance_ngn })),
                        )
                      }
                    >
                      Export CSV
                    </button>
                    <Link to="/owner/closes" className="ov-link">All <ArrowRight aria-hidden="true" /></Link>
                  </div>
                  <div className="sub">Last 30 days</div>
                </div>
                {loading ? (
                  <InlineLoader />
                ) : variances.length === 0 ? (
                  <div className="ov-muted ov-pad">No differences in the last 30 days. Clean books.</div>
                ) : (
                  <ul className="ov-closes">
                    {variances.slice(0, 6).map((v) => (
                      <li key={v.daily_close_id}>
                        <span>
                          <b>{branchName(v.branch_id)}</b>
                          <small>{dayLabel(v.business_date)}</small>
                        </span>
                        <span className={`tag ${v.variance_ngn < 0 ? "t-bad" : v.variance_ngn > 0 ? "t-warn" : "t-mute"} tabular-nums`}>
                          {v.variance_ngn < 0 ? `${ngn(-v.variance_ngn)} short` : v.variance_ngn > 0 ? `${ngn(v.variance_ngn)} over` : "Exact"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}

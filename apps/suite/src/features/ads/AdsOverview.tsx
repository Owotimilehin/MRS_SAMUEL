/**
 * Ads → Overview (suite spec 12, 7.3): what was spent, what Meta counted, and
 * the paid orders we traced back to adverts, with the rule written beside it.
 * Read-only.
 */
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { money } from "@ms/shared";
import { DataState } from "@admin/components/DataState.js";
import { Stat } from "@admin/components/Stat.js";
import { StatHero } from "@admin/components/StatHero.js";
import { COLOR_AXIS, COLOR_GRID, SERIES_COLORS, ngn, shortDate } from "@admin/lib/analytics-theme.js";
import { adsApi, adsKeys, type AdsStatus, type DayFigures } from "./ads-api.js";
import { dayZoneCaption } from "./ads-logic.js";

const tooltipStyle = {
  background: "rgba(255,255,255,0.96)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  boxShadow: "var(--shadow-card)",
  fontSize: 12,
  padding: "8px 12px",
} as const;
const labelStyle = { fontWeight: 700, color: "#1b2a20", marginBottom: 2 } as const;
const tick = { fontSize: 11, fill: COLOR_AXIS } as const;

/** Bars for spend, a line for chats started. A day with no figure is a gap, never a zero. */
export function SpendChart({ days, currency }: { days: DayFigures[]; currency: string }): JSX.Element {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={days} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
        <CartesianGrid stroke={COLOR_GRID} vertical={false} />
        <XAxis dataKey="day" tickFormatter={shortDate} tick={tick} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis yAxisId="spend" tick={tick} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => money(v, currency)} />
        <YAxis yAxisId="chats" orientation="right" allowDecimals={false} tick={tick} tickLine={false} axisLine={false} width={32} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelStyle={labelStyle}
          labelFormatter={(l) => shortDate(String(l))}
          formatter={(value, name) => (name === "Spent" ? money(Number(value), currency) : String(value))}
          cursor={{ fill: "rgba(31,122,68,0.06)" }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar yAxisId="spend" dataKey="spend" name="Spent" fill={SERIES_COLORS[0]} radius={[6, 6, 0, 0]} isAnimationActive={false} maxBarSize={36} />
        <Line yAxisId="chats" dataKey="conversations_started" name="Chats started (Meta)" stroke={SERIES_COLORS[1]} strokeWidth={2} dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function OrdersChart({ days }: { days: { day: string; orders: number }[] }): JSX.Element {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={days} margin={{ top: 8, right: 22, left: -12, bottom: 0 }}>
        <CartesianGrid stroke={COLOR_GRID} vertical={false} />
        <XAxis dataKey="day" tickFormatter={shortDate} tick={tick} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis allowDecimals={false} tick={tick} tickLine={false} axisLine={false} width={40} />
        <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} labelFormatter={(l) => shortDate(String(l))} cursor={{ fill: "rgba(31,122,68,0.06)" }} />
        <Bar dataKey="orders" name="Orders traced to adverts" fill={SERIES_COLORS[2]} radius={[6, 6, 0, 0]} isAnimationActive={false} maxBarSize={36} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** The box that says exactly how an order is counted for an advert. Always shown. */
export function HowWeCount({ windowDays }: { windowDays: number }): JSX.Element {
  return (
    <div className="ads-note">
      <h3>How we count an order for an advert</h3>
      <p>
        We count a paid order when the same customer tapped an advert and started a chat with us up to {windowDays} {windowDays === 1 ? "day" : "days"} before
        ordering. If they tapped more than one advert, the latest one gets the order. Cancelled and refunded orders are left out. We cannot see orders made
        under a different phone number or account than the one that chatted, so the real figure may be higher. Meta&apos;s own purchase count can differ from
        ours.
      </p>
    </div>
  );
}

/** Every day in the range, with 0 where no order was traced (orders are our own count, so 0 is a real zero). */
function fillOrderDays(from: string, to: string, rows: { day: string; orders: number }[]): { day: string; orders: number }[] {
  const by = new Map(rows.map((r) => [r.day, r.orders]));
  const out: { day: string; orders: number }[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let i = 0; d <= end && i < 401; i++) {
    const day = d.toISOString().slice(0, 10);
    out.push({ day, orders: by.get(day) ?? 0 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function AdsOverview({ from, to, status }: { from: string; to: string; status: AdsStatus }): JSX.Element {
  const q = useQuery({ queryKey: adsKeys.overview(from, to), queryFn: () => adsApi.overview(from, to), enabled: from <= to });
  const d = q.data;
  const currency = d?.currency ?? status.account?.currency ?? "NGN";
  const t = d?.totals;
  return (
    <>
      <StatHero eyebrow="Ads" title="What our adverts did" sub="Spend and results from Meta, and the orders we traced back to each advert." loading={q.isLoading} />
      {status.account?.problem ? <div className="ads-strip ads-strip--warn">{status.account.problem}</div> : null}
      <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {d && t ? (
          <>
            {!d.has_figures ? <div className="empty">No advert figures for these dates.</div> : null}
            <div className="ibx-stats">
              <Stat label="Spent" value={money(t.spend, currency)} tone="accent" />
              <Stat label="Times shown" value={t.impressions.toLocaleString("en-NG")} />
              <Stat label="Taps" value={t.clicks.toLocaleString("en-NG")} />
              <Stat label="Chats started (Meta's count)" value={t.conversations_started.toLocaleString("en-NG")} />
              <Stat label="Cost per chat" value={t.cost_per_conversation === null ? "—" : money(Math.round(t.cost_per_conversation), currency)} />
              <Stat label="Orders traced to adverts" value={String(t.orders)} tone="good" />
              <Stat label="Sales from those orders" value={ngn(t.order_value_ngn)} tone="good" />
              <Stat
                label="Cost per order"
                value={t.cost_per_order === null ? "—" : ngn(t.cost_per_order)}
                {...(currency !== "NGN" ? { hint: "Shown only when the ad account is in naira." } : {})}
              />
            </div>
            {currency !== "NGN" ? <p className="ads-fine">Spend is in {currency}; sales are in naira. We do not convert between them.</p> : null}
            <div className="ads-split">
              <section className="card">
                <h2 className="t-h2" style={{ marginBottom: 2 }}>Spend and chats by day</h2>
                <p className="ads-chartcap">{dayZoneCaption(d.day_zone)}</p>
                <SpendChart days={d.per_day} currency={currency} />
              </section>
              <section className="card">
                <h2 className="t-h2" style={{ marginBottom: 2 }}>Orders traced to adverts by day</h2>
                <p className="ads-chartcap">Days are Lagos days.</p>
                <OrdersChart days={fillOrderDays(from, to, d.orders_per_day)} />
              </section>
            </div>
          </>
        ) : null}
      </DataState>
      <HowWeCount windowDays={status.settings.attribution_window_days} />
    </>
  );
}

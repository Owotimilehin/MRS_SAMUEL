import {
  ResponsiveContainer,
  ComposedChart,
  AreaChart,
  Area,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import {
  COLOR_REVENUE,
  COLOR_ORDERS,
  COLOR_GRID,
  COLOR_AXIS,
  colorAt,
  ngn,
  ngnCompact,
  shortDate,
} from "../lib/analytics-theme.js";
import type { TimePoint, Slice, BranchPerf } from "../lib/analytics-derive.js";

// One glass tooltip look for every chart.
const tooltipStyle = {
  background: "rgba(255,255,255,0.96)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  boxShadow: "var(--shadow-card)",
  fontSize: 12,
  padding: "8px 12px",
} as const;
const labelStyle = { fontWeight: 700, color: "#1b2a20", marginBottom: 2 } as const;
// Recharts tooltip values arrive as number | string | array; coerce safely.
const money = (v: number | string | Array<number | string>): string =>
  ngn(Number(Array.isArray(v) ? v[0] : v));

/** Tiny area sparkline for a KPI card. */
export function Sparkline({
  data,
  dataKey,
  color,
}: {
  data: TimePoint[];
  dataKey: "net_ngn" | "orders";
  color: string;
}): JSX.Element {
  return (
    <ResponsiveContainer width="100%" height={34}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} fill={color} fillOpacity={0.14} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Headline: net revenue area + orders line, dual axis. */
export function TrendChart({ data }: { data: TimePoint[] }): JSX.Element {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="ms-net-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLOR_REVENUE} stopOpacity={0.34} />
            <stop offset="100%" stopColor={COLOR_REVENUE} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={COLOR_GRID} vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: COLOR_AXIS }} tickLine={false} axisLine={false} minTickGap={26} />
        <YAxis yAxisId="rev" tickFormatter={ngnCompact} tick={{ fontSize: 11, fill: COLOR_AXIS }} tickLine={false} axisLine={false} width={58} />
        <YAxis yAxisId="ord" orientation="right" allowDecimals={false} tick={{ fontSize: 11, fill: COLOR_AXIS }} tickLine={false} axisLine={false} width={30} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelStyle={labelStyle}
          labelFormatter={(l) => shortDate(String(l))}
          formatter={(value, name) => (name === "Orders" ? [String(value), name] : [money(value), name])}
        />
        <Area yAxisId="rev" type="monotone" dataKey="net_ngn" name="Net revenue" stroke={COLOR_REVENUE} strokeWidth={2.5} fill="url(#ms-net-fill)" />
        <Line yAxisId="ord" type="monotone" dataKey="orders" name="Orders" stroke={COLOR_ORDERS} strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Donut with a coloured legend listing each slice + amount. */
export function MixDonut({ data }: { data: Slice[] }): JSX.Element {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <div style={{ width: 200, height: 200, flex: "none", position: "relative" }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="label" innerRadius={62} outerRadius={94} paddingAngle={data.length > 1 ? 2 : 0} stroke="none">
              {data.map((s, i) => (
                <Cell key={s.key} fill={colorAt(i)} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} formatter={(v) => money(v)} />
          </PieChart>
        </ResponsiveContainer>
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "var(--ink-soft)", letterSpacing: "0.04em" }}>TOTAL</div>
            <div className="font-display" style={{ fontSize: 18, color: "var(--brand)" }}>{ngnCompact(total)}</div>
          </div>
        </div>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 140 }}>
        {data.map((s, i) => (
          <li key={s.key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
            <span style={{ width: 12, height: 12, borderRadius: 4, background: colorAt(i), flex: "none" }} />
            <span style={{ flex: 1, color: "var(--ink)" }}>{s.label}</span>
            <span className="tabular-nums" style={{ fontWeight: 700 }}>{ngn(s.value)}</span>
            <span style={{ width: 44, textAlign: "right", color: "var(--ink-soft)", fontSize: 12 }}>
              {total > 0 ? `${Math.round((s.value / total) * 100)}%` : "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal bars comparing branches by net revenue. */
export function BranchBars({ data }: { data: BranchPerf[] }): JSX.Element {
  return (
    <ResponsiveContainer width="100%" height={Math.max(140, data.length * 46)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
        <CartesianGrid stroke={COLOR_GRID} horizontal={false} />
        <XAxis type="number" tickFormatter={ngnCompact} tick={{ fontSize: 11, fill: COLOR_AXIS }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="name" width={96} tick={{ fontSize: 12, fill: "#1b2a20" }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} cursor={{ fill: "rgba(31,122,68,0.06)" }} formatter={(v) => money(v)} />
        <Bar dataKey="net" name="Net revenue" radius={[0, 8, 8, 0]} barSize={18}>
          {data.map((b, i) => (
            <Cell key={b.id} fill={colorAt(i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** P&L summary bars: net revenue, expenses, net profit. */
export function PnlBars({
  netRevenue,
  expenses,
  net,
}: {
  netRevenue: number;
  expenses: number;
  net: number;
}): JSX.Element {
  const data = [
    { name: "Net revenue", value: netRevenue, c: COLOR_REVENUE },
    { name: "Expenses", value: expenses, c: COLOR_ORDERS },
    { name: "Net profit", value: net, c: net >= 0 ? "#1f9e74" : "#dc2626" },
  ];
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
        <CartesianGrid stroke={COLOR_GRID} horizontal={false} />
        <XAxis type="number" tickFormatter={ngnCompact} tick={{ fontSize: 11, fill: COLOR_AXIS }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="name" width={96} tick={{ fontSize: 12, fill: "#1b2a20" }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} cursor={{ fill: "rgba(31,122,68,0.06)" }} formatter={(v) => money(v)} />
        <Bar dataKey="value" radius={[0, 8, 8, 0]} barSize={26}>
          {data.map((d) => (
            <Cell key={d.name} fill={d.c} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

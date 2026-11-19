/**
 * One trend chart (suite spec 11, section 7.1): bars or a line per day, drawn like the
 * Reports screen. A day with no figure is a gap, never a zero, and hovering it says so.
 * Every chart has one value axis, and the note under it says which clock its days follow.
 */
import { useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataState } from "@admin/components/DataState.js";
import { COLOR_AXIS, COLOR_GRID, SERIES_COLORS, colorAt, shortDate } from "@admin/lib/analytics-theme.js";
import { insightKeys, insightsApi, type Series } from "./insights-api.js";
import { allMissing, chartTicks, formatFigure, gapText, partColorIndex, partLabel, zoneNote } from "./insights-logic.js";

export const tooltipStyle = {
  background: "rgba(255,255,255,0.96)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  boxShadow: "var(--shadow-card)",
  fontSize: 12,
  padding: "8px 12px",
} as const;

export interface ChartSeries {
  key: string;
  name: string;
  color: string;
  as: "bar" | "line";
  stack?: string;
}
export type ChartRow = { day: string } & Record<string, number | null | string>;

/** The tooltip: every series by name, and a plain sentence where the day has no figure. */
function GapTooltip({ active, label, payload, series, network }: { active?: boolean; label?: string; payload?: { payload?: ChartRow }[]; series: ChartSeries[]; network: string }): JSX.Element | null {
  if (!active || !label) return null;
  const row = payload?.[0]?.payload;
  const known = series.filter((s) => row && typeof row[s.key] === "number");
  return (
    <div style={tooltipStyle}>
      <div style={{ fontWeight: 700, color: "#1b2a20", marginBottom: 2 }}>{shortDate(String(label))}</div>
      {known.length === 0 ? (
        <div>{gapText(network)}</div>
      ) : (
        known.map((s) => (
          <div key={s.key} className="ins-tip__row">
            <span className="ins-tip__dot" style={{ background: s.color }} />
            <span>{s.name}</span>
            <strong>{formatFigure(row![s.key] as number)}</strong>
          </div>
        ))
      )}
    </div>
  );
}

/** The drawing itself. `dimNewest` days at the right are drawn lighter: Meta may still be counting them. */
export function DayChart({ rows, series, network, dimNewest = 0 }: { rows: ChartRow[]; series: ChartSeries[]; network: string; dimNewest?: number }): JSX.Element {
  const ticks = chartTicks(rows.map((r) => r.day), 6);
  const bars = series.filter((s) => s.as === "bar");
  const lastStacked = new Map<string, string>();
  for (const s of bars) if (s.stack) lastStacked.set(s.stack, s.key);
  return (
    <div className="ins-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 22, left: -12, bottom: 0 }}>
          <CartesianGrid stroke={COLOR_GRID} vertical={false} />
          <XAxis dataKey="day" ticks={ticks} interval={0} tickFormatter={shortDate} tick={{ fontSize: 11, fill: COLOR_AXIS }} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: COLOR_AXIS }} tickLine={false} axisLine={false} width={44} />
          <Tooltip content={<GapTooltip series={series} network={network} />} cursor={{ fill: "rgba(31,122,68,0.06)" }} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {bars.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.name}
              fill={s.color}
              {...(s.stack ? { stackId: s.stack } : {})}
              radius={!s.stack || lastStacked.get(s.stack) === s.key ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
              maxBarSize={36}
            >
              {rows.map((r, i) => (
                <Cell key={r.day} fillOpacity={i >= rows.length - dimNewest ? 0.6 : 1} />
              ))}
            </Bar>
          ))}
          {series
            .filter((s) => s.as === "line")
            .map((s) => (
              <Line key={s.key} dataKey={s.key} name={s.name} type="monotone" stroke={s.color} strokeWidth={2} dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
            ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** What one choice in a chart's select shows. */
export interface FigureOption {
  label: string;
  as: "bar" | "line";
  /** Each is one call to /series. With `allParts` there is exactly one and it is asked for with breakdown "*". */
  series: { metric: string; breakdown?: string; name: string }[];
  allParts?: boolean;
  /** Said under the chart when Meta has given no figure at all for this choice. */
  emptyNote?: string;
}

export function ChartCard({ title, children, note, extra }: { title: string; children: ReactNode; note: string; extra?: ReactNode }): JSX.Element {
  return (
    <section className="card ins-card">
      <div className="ins-card__head">
        <h2 className="t-h2">{title}</h2>
        {extra}
      </div>
      {children}
      <p className="ins-fine">{note}</p>
    </section>
  );
}

/** A chart of one Meta source with a select to change the figure shown. */
export function TrendChart(props: {
  title: string;
  network: "Facebook" | "Instagram";
  source: "facebook_page" | "instagram_account";
  options: FigureOption[];
  from: string;
  to: string;
  dimNewest: number;
}): JSX.Element {
  const [choice, setChoice] = useState(0);
  const option = props.options[choice] ?? props.options[0]!;
  const results = useQueries({
    queries: option.series.map((s) => {
      const breakdown = option.allParts ? "*" : (s.breakdown ?? "");
      return {
        queryKey: insightKeys.series(props.source, s.metric, breakdown, props.from, props.to),
        queryFn: () => insightsApi.series(props.source, s.metric, breakdown, props.from, props.to),
      };
    }),
  });
  const loading = results.some((r) => r.isLoading);
  const error = results.find((r) => r.error)?.error ?? null;
  const data = results.map((r) => r.data).filter((d): d is Series => !!d);

  const series: ChartSeries[] = [];
  const rows = new Map<string, ChartRow>();
  const put = (key: string, points: { day: string; value: number | null }[]): void => {
    for (const p of points) rows.set(p.day, { ...(rows.get(p.day) ?? { day: p.day }), [key]: p.value });
  };
  let empty = true;
  if (!loading && !error && data.length === option.series.length) {
    if (option.allParts) {
      for (const part of [...(data[0]!.series ?? [])].sort((a, b) => partColorIndex(a.breakdown) - partColorIndex(b.breakdown))) {
        series.push({ key: part.breakdown, name: partLabel(part.breakdown), color: colorAt(partColorIndex(part.breakdown)), as: "bar", stack: "parts" });
        put(part.breakdown, part.points);
        if (!allMissing(part.points)) empty = false;
      }
    } else {
      option.series.forEach((s, i) => {
        const key = `s${i}`;
        series.push({ key, name: s.name, color: SERIES_COLORS[i]!, as: option.as });
        put(key, data[i]!.points ?? []);
        if (!allMissing(data[i]!.points)) empty = false;
      });
    }
  }
  const zone = data[0]?.day_zone ?? (props.source === "facebook_page" ? "America/Los_Angeles" : "Africa/Lagos");
  const note = [empty && !loading && !error ? (option.emptyNote ?? `No figures from ${props.network} for these dates yet.`) : "", zoneNote(zone)].filter(Boolean).join(" ");
  const select = (
    <label className="ins-pick">
      <span className="sr-only">Figure shown for {props.network}</span>
      <select className="select" value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
        {props.options.map((o, i) => (
          <option key={o.label} value={i}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <ChartCard title={props.title} note={note} extra={select}>
      <DataState loading={loading} error={error} onRetry={() => results.forEach((r) => void r.refetch())}>
        {/* Lines are running totals: the newest days are not "still counting", so only bars are dimmed. */}
        <DayChart rows={[...rows.values()]} series={series} network={props.network} dimNewest={option.as === "bar" ? props.dimNewest : 0} />
      </DataState>
    </ChartCard>
  );
}

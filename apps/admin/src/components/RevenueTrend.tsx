import { useId, useMemo, useState } from "react";
import { ngn } from "../lib/format.js";
import { ngnShort } from "../lib/overview-logic.js";

export interface TrendPoint {
  date: string; // yyyy-mm-dd
  net_ngn: number;
  orders: number;
}

const W = 640;
const H = 200;
const PAD = { l: 52, r: 12, t: 14, b: 26 };

function dayShort(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** Net revenue per day: one series, so no legend; crosshair + tooltip on hover. */
export function RevenueTrend({ points }: { points: TrendPoint[] }): JSX.Element {
  const gradId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    const max = Math.max(1, ...points.map((p) => p.net_ngn));
    // A round ceiling so gridlines land on readable values.
    const mag = 10 ** Math.floor(Math.log10(max));
    const top = Math.ceil(max / mag) * mag;
    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const x = (i: number): number => PAD.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
    const y = (v: number): number => PAD.t + ih - (Math.max(0, v) / top) * ih;
    const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.net_ngn).toFixed(1)}`).join(" ");
    const area = points.length
      ? `${line} L${x(points.length - 1).toFixed(1)},${PAD.t + ih} L${x(0).toFixed(1)},${PAD.t + ih} Z`
      : "";
    return { top, x, y, line, area, ih };
  }, [points]);

  if (points.length === 0) {
    return <div className="empty" style={{ margin: "8px 20px 18px" }}>No sales in the last 14 days.</div>;
  }

  const ticks = [0, 0.5, 1].map((f) => geo.top * f);
  const labelIdx = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const hp = hover != null ? points[hover] : null;

  function onMove(e: React.PointerEvent<SVGSVGElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    points.forEach((_, i) => {
      const d = Math.abs(geo.x(i) - sx);
      if (d < bestD) { bestD = d; best = i; }
    });
    setHover(best);
  }

  return (
    <div className="ov-trend">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Net revenue per day, ${dayShort(points[0]!.date)} to ${dayShort(points[points.length - 1]!.date)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--leaf-2)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--leaf-2)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line className="ov-gl" x1={PAD.l} x2={W - PAD.r} y1={geo.y(t)} y2={geo.y(t)} />
            <text className="ov-axis" x={PAD.l - 8} y={geo.y(t) + 4} textAnchor="end">{ngnShort(t)}</text>
          </g>
        ))}
        {labelIdx.map((i) => (
          <text key={i} className="ov-axis" x={geo.x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>
            {dayShort(points[i]!.date)}
          </text>
        ))}
        <path d={geo.area} fill={`url(#${gradId})`} />
        <path d={geo.line} fill="none" stroke="var(--leaf)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hp && hover != null && (
          <g>
            <line className="ov-cross" x1={geo.x(hover)} x2={geo.x(hover)} y1={PAD.t} y2={PAD.t + geo.ih} />
            <circle cx={geo.x(hover)} cy={geo.y(hp.net_ngn)} r={5} fill="var(--leaf)" stroke="var(--card)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && hover != null && (
        <div
          className="ov-tip"
          style={{ left: `${(geo.x(hover) / W) * 100}%`, transform: hover > points.length / 2 ? "translateX(-105%)" : "translateX(5%)" }}
        >
          <b>{dayShort(hp.date)}</b>
          <span className="tabular-nums">{ngn(hp.net_ngn)}</span>
          <small>{hp.orders} {hp.orders === 1 ? "order" : "orders"}</small>
        </div>
      )}
    </div>
  );
}

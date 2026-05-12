import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { Stat } from "../../components/Stat.js";
import { api } from "../../lib/api.js";
import { ngn, formatDate } from "../../lib/format.js";

interface Branch {
  id: string;
  name: string;
}
interface Product {
  id: string;
  name: string;
}
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
interface BranchStockRow {
  branch_id: string;
  product_id: string;
  balance: number;
}
interface VarianceRow {
  daily_close_id: string;
  branch_id: string;
  business_date: string;
  variance_ngn: number;
}
interface DeviceRow {
  device_id: string;
  branch_id: string | null;
  app_version: string | null;
  queue_depth: number;
  last_sync_at: string | null;
  reported_at: string;
  age_seconds: number;
}

export function DashboardPage(): JSX.Element {
  const today = new Date().toISOString().slice(0, 10);
  const sevenAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [todayRev, setTodayRev] = useState<RevenueRow[]>([]);
  const [weekRev, setWeekRev] = useState<RevenueRow[]>([]);
  const [top, setTop] = useState<TopProductRow[]>([]);
  const [stock, setStock] = useState<BranchStockRow[]>([]);
  const [variances, setVariances] = useState<VarianceRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [b, p, t, w, tp, st, v, d] = await Promise.all([
          api<{ data: Branch[] }>("/branches"),
          api<{ data: Product[] }>("/products"),
          api<{ data: RevenueRow[] }>(`/reports/revenue?from=${today}&to=${today}`),
          api<{ data: RevenueRow[] }>(`/reports/revenue?from=${sevenAgo}&to=${today}`),
          api<{ data: TopProductRow[] }>(`/reports/top-products?limit=5&from=${sevenAgo}&to=${today}`),
          api<{ data: BranchStockRow[] }>("/reports/branch-stock"),
          api<{ data: VarianceRow[] }>(`/reports/variances?from=${sevenAgo}`),
          api<{ data: DeviceRow[] }>("/telemetry/devices"),
        ]);
        setBranches(b.data);
        setProducts(p.data);
        setTodayRev(t.data);
        setWeekRev(w.data);
        setTop(tp.data);
        setStock(st.data);
        setVariances(v.data);
        setDevices(d.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [today, sevenAgo]);

  const todayGross = todayRev.reduce((s, r) => s + r.gross_ngn, 0);
  const todayNet = todayRev.reduce((s, r) => s + r.net_ngn, 0);
  const todayOrders = todayRev.reduce((s, r) => s + r.orders, 0);
  const weekNet = weekRev.reduce((s, r) => s + r.net_ngn, 0);

  const branchName = (id: string): string =>
    branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);
  const productName = (id: string): string =>
    products.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  return (
    <Shell title="Dashboard">
      <div className="flex flex-col gap-6">
        {error && (
          <div
            className="p-3 rounded-md text-sm"
            style={{ background: "rgba(198,58,46,0.12)", color: "var(--ms-danger)" }}
          >
            {error}
          </div>
        )}

        <div className="grid grid-cols-4 gap-4">
          <Stat label="Today gross" value={ngn(todayGross)} tone="good" />
          <Stat label="Today net" value={ngn(todayNet)} hint="after refunds" />
          <Stat label="Orders today" value={String(todayOrders)} />
          <Stat label="Week net" value={ngn(weekNet)} hint={`since ${formatDate(sevenAgo)}`} />
        </div>

        <section
          className="rounded-xl p-5 flex flex-col gap-3"
          style={{ background: "var(--ms-surface)", border: "1px solid var(--ms-border)" }}
        >
          <h2 className="font-display text-lg font-bold">Revenue by branch × channel (today)</h2>
          {todayRev.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--ms-ink-3)" }}>No sales yet today.</p>
          ) : (
            <table className="w-full text-sm">
              <thead style={{ background: "var(--ms-surface-alt)" }}>
                <tr>
                  <th className="text-left px-3 py-2 text-xs">Branch</th>
                  <th className="text-left px-3 py-2 text-xs">Channel</th>
                  <th className="text-right px-3 py-2 text-xs">Orders</th>
                  <th className="text-right px-3 py-2 text-xs">Gross</th>
                  <th className="text-right px-3 py-2 text-xs">Refunds</th>
                  <th className="text-right px-3 py-2 text-xs">Net</th>
                </tr>
              </thead>
              <tbody>
                {todayRev.map((r, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--ms-divider)" }}>
                    <td className="px-3 py-2">{branchName(r.branch_id)}</td>
                    <td className="px-3 py-2 text-xs">{r.channel}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.orders}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ngn(r.gross_ngn)}</td>
                    <td
                      className="px-3 py-2 text-right tabular-nums"
                      style={{ color: r.refunds_ngn > 0 ? "var(--ms-danger)" : "var(--ms-ink-3)" }}
                    >
                      {ngn(r.refunds_ngn)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">
                      {ngn(r.net_ngn)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <div className="grid grid-cols-2 gap-6">
          <section
            className="rounded-xl p-5 flex flex-col gap-3"
            style={{ background: "var(--ms-surface)", border: "1px solid var(--ms-border)" }}
          >
            <h2 className="font-display text-lg font-bold">Top products (7d)</h2>
            {top.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--ms-ink-3)" }}>No sales yet.</p>
            ) : (
              <ol className="flex flex-col gap-2 text-sm">
                {top.map((p, i) => (
                  <li key={p.product_id} className="flex items-baseline justify-between">
                    <span>
                      <span style={{ color: "var(--ms-ink-3)" }}>{i + 1}.</span> {p.product_name}
                    </span>
                    <span className="tabular-nums">
                      {p.quantity} · <strong>{ngn(p.revenue_ngn)}</strong>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section
            className="rounded-xl p-5 flex flex-col gap-3"
            style={{ background: "var(--ms-surface)", border: "1px solid var(--ms-border)" }}
          >
            <h2 className="font-display text-lg font-bold">Cash variances (7d)</h2>
            {variances.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--ms-ink-3)" }}>No closes filed.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {variances.slice(0, 8).map((v) => (
                  <li key={v.daily_close_id} className="flex items-baseline justify-between">
                    <span>
                      {branchName(v.branch_id)} · {formatDate(v.business_date)}
                    </span>
                    <span
                      className="tabular-nums"
                      style={{
                        color:
                          v.variance_ngn === 0
                            ? "var(--ms-green-900)"
                            : "var(--ms-danger)",
                      }}
                    >
                      {ngn(v.variance_ngn)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section
          className="rounded-xl p-5 flex flex-col gap-3"
          style={{ background: "var(--ms-surface)", border: "1px solid var(--ms-border)" }}
        >
          <h2 className="font-display text-lg font-bold">Branch devices</h2>
          {devices.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--ms-ink-3)" }}>
              No devices have reported yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead style={{ background: "var(--ms-surface-alt)" }}>
                <tr>
                  <th className="text-left px-3 py-2 text-xs">Branch</th>
                  <th className="text-left px-3 py-2 text-xs">Device</th>
                  <th className="text-right px-3 py-2 text-xs">Queue</th>
                  <th className="text-left px-3 py-2 text-xs">Version</th>
                  <th className="text-right px-3 py-2 text-xs">Last seen</th>
                  <th className="text-right px-3 py-2 text-xs">Status</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((dev) => {
                  const stale = dev.age_seconds > 15 * 60;
                  const veryStale = dev.age_seconds > 60 * 60;
                  const queueBad = dev.queue_depth >= 10;
                  const tone = veryStale || queueBad ? "bad" : stale ? "warn" : "good";
                  const label = tone === "bad" ? "🔴" : tone === "warn" ? "🟡" : "🟢";
                  const ageMin = Math.round(dev.age_seconds / 60);
                  return (
                    <tr key={dev.device_id} style={{ borderTop: "1px solid var(--ms-divider)" }}>
                      <td className="px-3 py-2">
                        {dev.branch_id ? branchName(dev.branch_id) : "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {dev.device_id.slice(0, 8)}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        style={{ color: queueBad ? "var(--ms-danger)" : "var(--ms-ink-2)" }}
                      >
                        {dev.queue_depth}
                      </td>
                      <td className="px-3 py-2 text-xs" style={{ color: "var(--ms-ink-3)" }}>
                        {dev.app_version ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-xs" style={{ color: "var(--ms-ink-3)" }}>
                        {ageMin < 1 ? "just now" : `${ageMin}m ago`}
                      </td>
                      <td className="px-3 py-2 text-right">{label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section
          className="rounded-xl p-5 flex flex-col gap-3"
          style={{ background: "var(--ms-surface)", border: "1px solid var(--ms-border)" }}
        >
          <h2 className="font-display text-lg font-bold">Branch stock</h2>
          {stock.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--ms-ink-3)" }}>No stock movements yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead style={{ background: "var(--ms-surface-alt)" }}>
                <tr>
                  <th className="text-left px-3 py-2 text-xs">Branch</th>
                  <th className="text-left px-3 py-2 text-xs">Product</th>
                  <th className="text-right px-3 py-2 text-xs">Balance</th>
                </tr>
              </thead>
              <tbody>
                {stock
                  .filter((s) => s.balance > 0)
                  .map((s, i) => (
                    <tr
                      key={`${s.branch_id}-${s.product_id}-${i}`}
                      style={{ borderTop: "1px solid var(--ms-divider)" }}
                    >
                      <td className="px-3 py-2">{branchName(s.branch_id)}</td>
                      <td className="px-3 py-2">{productName(s.product_id)}</td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        style={{ color: s.balance < 5 ? "var(--ms-danger)" : "var(--ms-ink-2)" }}
                      >
                        {s.balance}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </Shell>
  );
}

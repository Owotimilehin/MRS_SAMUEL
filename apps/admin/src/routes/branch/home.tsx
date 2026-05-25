import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BranchShell } from "../../components/BranchShell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { useSyncState } from "../../sync/state.js";

interface Sale {
  id: string;
  orderNumber: string;
  status: string;
  totalNgn: number;
  createdAtLocal: string;
  channel: string;
}

const TILES = [
  { to: "/branch/sell", label: "Sell", icon: "🥤", desc: "Take a walk-up sale" },
  { to: "/branch/transfers", label: "Receive", icon: "📦", desc: "Mark incoming arrived" },
  { to: "/branch/stock", label: "Stock", icon: "📊", desc: "Check what's on the shelf" },
  { to: "/branch/returns", label: "Returns", icon: "↩️", desc: "Process a return" },
  { to: "/branch/close", label: "Close", icon: "🧾", desc: "End-of-day reconciliation" },
];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function BranchHomePage({ branchId }: { branchId: string }): JSX.Element {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sync = useSyncState();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<{ data: Sale[] }>(`/branches/${branchId}/sales`);
        if (cancelled) return;
        setSales(res.data);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  const today = todayISO();
  const salesToday = sales.filter((s) => s.createdAtLocal.startsWith(today));
  const todaysTotal = salesToday.reduce((acc, s) => acc + s.totalNgn, 0);
  const recent = sales.slice(0, 5);

  return (
    <BranchShell branchId={branchId} title="Today">
      <div className="branch-home">
        <section className="branch-home__kpi">
          <KpiCard label="Today's sales" value={salesToday.length.toString()} />
          <KpiCard label="Revenue" value={ngn(todaysTotal)} accent />
          <KpiCard
            label="Sync queue"
            value={`${sync.queued}`}
            {...(sync.queued > 0 ? { tone: "warn" as const } : {})}
          />
        </section>

        <section className="branch-home__tiles">
          {TILES.map((t) => (
            <Link key={t.to} to={t.to} className="branch-tile">
              <span className="branch-tile__icon" aria-hidden>
                {t.icon}
              </span>
              <span className="branch-tile__label">{t.label}</span>
              <span className="branch-tile__desc">{t.desc}</span>
            </Link>
          ))}
        </section>

        <section className="card" style={{ marginTop: 16 }}>
          <header
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <h2 className="t-h2">Recent sales</h2>
            <Link
              to="/branch/sales"
              style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600 }}
            >
              See all →
            </Link>
          </header>
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
          {loading ? (
            <InlineLoader />
          ) : recent.length === 0 ? (
            <div className="empty">
              <div className="empty__title">No sales yet today</div>
              Tap <strong>Sell</strong> to take the first one.
            </div>
          ) : (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {recent.map((s) => (
                <li key={s.id}>
                  <Link
                    to="/branch/sales/$saleId"
                    params={{ saleId: s.id }}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto auto",
                      gap: 12,
                      padding: "10px 12px",
                      borderRadius: 12,
                      background: "var(--surface-soft)",
                      textDecoration: "none",
                      color: "inherit",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>{s.orderNumber}</div>
                      <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                        {formatDateTime(s.createdAtLocal)} · {s.channel}
                      </div>
                    </div>
                    <span className="tabular-nums" style={{ fontWeight: 700 }}>
                      {ngn(s.totalNgn)}
                    </span>
                    <span className="pill">{s.status}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </BranchShell>
  );
}

function KpiCard({
  label,
  value,
  accent,
  tone,
}: {
  label: string;
  value: string;
  accent?: boolean;
  tone?: "warn";
}): JSX.Element {
  return (
    <div
      className="card"
      style={{
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--ink-soft)",
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      <span
        className="tabular-nums"
        style={{
          fontSize: 28,
          fontWeight: 800,
          background: accent ? "var(--grad)" : undefined,
          WebkitBackgroundClip: accent ? "text" : undefined,
          backgroundClip: accent ? "text" : undefined,
          color: accent
            ? "transparent"
            : tone === "warn"
              ? "var(--warning)"
              : "var(--ink)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

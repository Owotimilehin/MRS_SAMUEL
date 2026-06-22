import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Shell } from "../../components/Shell.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { downloadCsv } from "../../lib/csv.js";
import { toast } from "../../lib/toast.js";
import { StatHero } from "../../components/StatHero.js";

interface CustomerSummary {
  id: string;
  name: string | null;
  phone: string | null;
  orders: number;
  lifetimeNgn: number;
  lastOrderAt: string;
  lastOrderNumber: string;
}

export function CustomersPage(): JSX.Element {
  const [rows, setRows] = useState<CustomerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "repeat" | "new7d">("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<{ data: CustomerSummary[] }>("/customers");
        if (cancelled) return;
        setRows(res.data);
      } catch (err) {
        if (!cancelled) toast.error(humanizeError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const sevenAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return rows.filter((r) => {
      if (filter === "repeat" && r.orders < 2) return false;
      if (filter === "new7d" && r.lastOrderAt < sevenAgo) return false;
      if (q.trim()) {
        const t = q.trim().toLowerCase();
        const hay = `${r.name ?? ""} ${r.phone ?? ""} ${r.lastOrderNumber}`.toLowerCase();
        if (!hay.includes(t)) return false;
      }
      return true;
    });
  }, [rows, filter, q]);

  return (
    <Shell
      title="Customers"
      crumb="Owner"
      actions={
        <button
          type="button"
          className="btn btn--subtle btn--sm"
          disabled={filtered.length === 0}
          onClick={() =>
            downloadCsv(
              `customers-${new Date().toISOString().slice(0, 10)}`,
              filtered.map((r) => ({
                name: r.name ?? "",
                phone: r.phone ?? "",
                orders: r.orders,
                lifetime_ngn: r.lifetimeNgn,
                last_order: r.lastOrderAt,
                last_order_number: r.lastOrderNumber,
              })),
            )
          }
        >
          Export CSV
        </button>
      }
    >
      <StatHero
        eyebrow="Sales"
        title="Customers"
        sub="Everyone who has ordered from Mrs. Samuel."
        loading={loading}
        chips={[
          {
            label: "Total",
            value: rows.length,
          },
          {
            label: "Repeat buyers",
            value: rows.filter((r) => r.orders >= 2).length,
          },
          {
            label: "New (7 days)",
            value: rows.filter((r) => r.lastOrderAt >= new Date(Date.now() - 7 * 86_400_000).toISOString()).length,
          },
          {
            label: "Lifetime revenue",
            value: ngn(rows.reduce((sum, r) => sum + r.lifetimeNgn, 0)),
          },
        ]}
      />

      <div className="toolbar ed-rise">
        <span className="toolbar__search">
          <Search />
          <input
            className="input"
            type="search"
            placeholder="Search name, phone or order number…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </span>
        <span className="toolbar__spacer" />
        <div className="t-tabs" role="tablist">
            {(["all", "repeat", "new7d"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                className={filter === f ? "is-active" : ""}
                onClick={() => setFilter(f)}
                style={{
                  padding: "6px 14px",
                  border: "1px solid var(--line)",
                  borderRadius: 999,
                  background: filter === f ? "var(--ink)" : "transparent",
                  color: filter === f ? "#fff" : "var(--ink)",
                  marginRight: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {f === "all" ? "All" : f === "repeat" ? "Repeat (2+)" : "New (7 days)"}
              </button>
            ))}
          </div>
        <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>
          {filtered.length} of {rows.length}
        </span>
      </div>

      

        {loading ? (
          <InlineLoader />
        ) : filtered.length === 0 ? (
          <div className="empty">
            <div className="empty__title">No customers yet</div>
            Customers appear here once a sale is rung up with their phone or name.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th className="table__num">Orders</th>
                  <th className="table__num">Lifetime</th>
                  <th>Last order</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>
                      {r.name ?? <span style={{ color: "var(--ink-soft)" }}>—</span>}
                    </td>
                    <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
                      {r.phone ?? "—"}
                    </td>
                    <td className="table__num">{r.orders}</td>
                    <td className="table__num" style={{ fontWeight: 700 }}>
                      {ngn(r.lifetimeNgn)}
                    </td>
                    <td>
                      {formatDateTime(r.lastOrderAt)}
                      <span style={{ color: "var(--ink-soft)", marginLeft: 6 }}>
                        · {r.lastOrderNumber}
                      </span>
                    </td>
                    <td className="table__num">
                      <Link
                        to="/owner/customers/$customerId"
                        params={{ customerId: r.id }}
                        className="pill pill--ink"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > 200 && (
              <p style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 12 }}>
                Showing first 200 of {filtered.length}. Use search to narrow down.
              </p>
            )}
          </div>
        )}
    </Shell>
  );
}

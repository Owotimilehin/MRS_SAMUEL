import { useEffect, useMemo, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { downloadCsv } from "../../lib/csv.js";

interface Branch {
  id: string;
  name: string;
}
interface RawSale {
  id: string;
  orderNumber: string;
  customerId: string | null;
  totalNgn: number;
  createdAtLocal: string;
}
interface CustomerSummary {
  customerId: string;
  orders: number;
  lifetimeNgn: number;
  lastOrderAt: string;
  lastOrderNumber: string;
}

export function CustomersPage(): JSX.Element {
  const [rows, setRows] = useState<CustomerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "repeat" | "new7d">("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const br = await api<{ data: Branch[] }>("/branches");
        const allSales = await Promise.all(
          br.data.map((b) =>
            api<{ data: RawSale[] }>(`/branches/${b.id}/sales`).then((r) => r.data),
          ),
        );
        if (cancelled) return;
        const flat = allSales.flat();
        const byCustomer = new Map<string, CustomerSummary>();
        for (const s of flat) {
          if (!s.customerId) continue;
          const ex = byCustomer.get(s.customerId);
          if (ex) {
            ex.orders += 1;
            ex.lifetimeNgn += s.totalNgn;
            if (s.createdAtLocal > ex.lastOrderAt) {
              ex.lastOrderAt = s.createdAtLocal;
              ex.lastOrderNumber = s.orderNumber;
            }
          } else {
            byCustomer.set(s.customerId, {
              customerId: s.customerId,
              orders: 1,
              lifetimeNgn: s.totalNgn,
              lastOrderAt: s.createdAtLocal,
              lastOrderNumber: s.orderNumber,
            });
          }
        }
        setRows(
          Array.from(byCustomer.values()).sort((a, b) =>
            a.lastOrderAt > b.lastOrderAt ? -1 : 1,
          ),
        );
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
  }, []);

  const filtered = useMemo(() => {
    const sevenAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return rows.filter((r) => {
      if (filter === "repeat" && r.orders < 2) return false;
      if (filter === "new7d" && r.lastOrderAt < sevenAgo) return false;
      if (q.trim()) {
        const t = q.trim().toLowerCase();
        if (!r.customerId.toLowerCase().includes(t) && !r.lastOrderNumber.toLowerCase().includes(t))
          return false;
      }
      return true;
    });
  }, [rows, filter, q]);

  return (
    <Shell
      title="Customers"
      actions={
        <button
          type="button"
          className="btn btn--subtle btn--sm"
          disabled={filtered.length === 0}
          onClick={() =>
            downloadCsv(
              `customers-${new Date().toISOString().slice(0, 10)}`,
              filtered.map((r) => ({
                customer_id: r.customerId,
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
      <section className="card">
        <header
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          <input
            className="input"
            placeholder="Search customer or order number…"
            style={{ flex: "1 1 240px", maxWidth: 320 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
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
          <span style={{ color: "var(--ink-soft)", fontSize: 13, marginLeft: "auto" }}>
            {filtered.length} of {rows.length}
          </span>
        </header>

        {error && (
          <div role="alert" className="empty" style={{ color: "var(--danger)" }}>
            {error}
          </div>
        )}

        {loading ? (
          <InlineLoader />
        ) : filtered.length === 0 ? (
          <div className="empty">
            <div className="empty__title">No customers yet</div>
            Customers will appear here once their orders land.
          </div>
        ) : (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Customer ID</th>
                  <th className="table__num">Orders</th>
                  <th className="table__num">Lifetime</th>
                  <th>Last order</th>
                  <th>Last order #</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => (
                  <tr key={r.customerId}>
                    <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
                      {r.customerId.slice(0, 8)}…
                    </td>
                    <td className="table__num">{r.orders}</td>
                    <td className="table__num" style={{ fontWeight: 700 }}>
                      {ngn(r.lifetimeNgn)}
                    </td>
                    <td>{formatDateTime(r.lastOrderAt)}</td>
                    <td style={{ fontWeight: 600 }}>{r.lastOrderNumber}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 14 }}>
          For contact details on any customer, open one of their orders from{" "}
          <a href="/owner/orders" style={{ color: "var(--accent)", fontWeight: 600 }}>
            Orders
          </a>
          .
        </p>
      </section>
    </Shell>
  );
}

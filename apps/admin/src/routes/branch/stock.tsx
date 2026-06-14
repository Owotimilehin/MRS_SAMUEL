import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import { local } from "../../db/local.js";
import { api } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";

interface Product {
  id: string;
  name: string;
  category: string;
}

export function BranchStockPage({ branchId }: { branchId: string }): JSX.Element {
  const products = useLiveQuery(() => local.products.toArray(), [], []);
  const [serverBalances, setServerBalances] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<{
          data: Array<{ product_id: string; variant_id: string | null; balance: number }>;
        }>(`/stock/branch/${branchId}`);
        if (!cancelled) {
          // Reads are per-variant; roll up to per-flavour totals for this view.
          const totals: Record<string, number> = {};
          for (const x of res.data) totals[x.product_id] = (totals[x.product_id] ?? 0) + x.balance;
          setServerBalances(totals);
          setError(null);
        }
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

  // Local available (server ledger projected + local reservations)
  const localAvailable = useLiveQuery(
    async () => {
      const rows = await local.ledger
        .where("[location_type+location_id+product_id]")
        .between(["branch", branchId, ""], ["branch", branchId, "￿"])
        .toArray();
      const reservations = await local.reservations.toArray();
      const now = Date.now();
      const balances: Record<string, number> = {};
      for (const r of rows) balances[r.product_id] = (balances[r.product_id] ?? 0) + r.delta;
      for (const r of reservations.filter((x) => x.expires_at > now)) {
        balances[r.product_id] = (balances[r.product_id] ?? 0) - r.quantity;
      }
      return balances;
    },
    [branchId],
    {} as Record<string, number>,
  );

  const rows = (products as Product[]).map((p) => {
    const server = serverBalances[p.id] ?? 0;
    const local = localAvailable[p.id] ?? server;
    return { ...p, server, local };
  });
  rows.sort((a, b) => a.local - b.local);

  const lowCount = rows.filter((r) => r.local <= 5 && r.local > 0).length;
  const oosCount = rows.filter((r) => r.local <= 0).length;

  return (
    <BranchShell branchId={branchId} title="Stock">
      {error && (
        <div
          className="card"
          style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}
        >
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <span className={oosCount > 0 ? "pill pill--danger" : "pill"}>Out of stock · {oosCount}</span>
        <span className={lowCount > 0 ? "pill pill--warning" : "pill"}>Low · {lowCount}</span>
        <span className="pill">{rows.length} products</span>
      </div>

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">No products synced yet. Connect to the network to pull the catalog.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th className="table__num">Available now</th>
                <th className="table__num">Server balance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tone =
                  r.local <= 0 ? "danger" : r.local <= 5 ? "warning" : r.local <= 15 ? "default" : "success";
                return (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td style={{ color: "var(--ink-soft)", textTransform: "capitalize" }}>{r.category}</td>
                    <td
                      className="table__num"
                      style={{
                        fontWeight: 800,
                        color:
                          tone === "danger"
                            ? "var(--danger)"
                            : tone === "warning"
                              ? "var(--warning)"
                              : tone === "success"
                                ? "var(--success)"
                                : "var(--ink)",
                      }}
                    >
                      {r.local}
                    </td>
                    <td className="table__num" style={{ color: "var(--ink-soft)" }}>
                      {r.server}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {tone === "danger" ? (
                        <span className="pill pill--danger">OOS</span>
                      ) : tone === "warning" ? (
                        <span className="pill pill--warning">Low</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 14 }}>
        “Available now” reflects unsynced reservations so the till can refuse out-of-stock sales offline.
        “Server balance” is the last value pulled from the ledger.
      </p>
    </BranchShell>
  );
}

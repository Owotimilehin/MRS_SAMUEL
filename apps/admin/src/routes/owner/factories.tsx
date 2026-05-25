import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";

interface Factory {
  id: string;
  name: string;
  code: string;
  address: string | null;
  createdAt: string;
}
interface Product {
  id: string;
  name: string;
}

export function FactoriesPage(): JSX.Element {
  const [rows, setRows] = useState<Factory[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [balances, setBalances] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [f, p] = await Promise.all([
          api<{ data: Factory[] }>(`/factories`),
          api<{ data: Product[] }>(`/products`),
        ]);
        if (cancelled) return;
        setRows(f.data);
        setProducts(p.data);
        // Pull stock for each factory
        const stocks = await Promise.all(
          f.data.map((row) =>
            api<{ data: Record<string, number> }>(`/stock/factory/${row.id}`).then((r) => ({
              id: row.id,
              data: r.data,
            })),
          ),
        );
        if (cancelled) return;
        const next: Record<string, Record<string, number>> = {};
        for (const s of stocks) next[s.id] = s.data;
        setBalances(next);
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

  const productName = (id: string): string => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  return (
    <Shell title="Factories">
      {error && (
        <div
          className="card"
          style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No factories</div>
          Factories are seeded via the database. Ask your DBA to add one.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {rows.map((f) => {
            const stock = balances[f.id] ?? {};
            const entries = Object.entries(stock).sort((a, b) => b[1] - a[1]);
            const totalUnits = entries.reduce((sum, [, q]) => sum + q, 0);
            return (
              <section key={f.id} className="card">
                <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                  <div>
                    <h2 className="t-h2">{f.name}</h2>
                    <div style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 4 }}>
                      <span style={{ fontFamily: "monospace" }}>{f.code}</span>
                      {f.address && ` · ${f.address}`}
                    </div>
                  </div>
                  <span className="pill pill--accent">
                    {totalUnits.toLocaleString()} bottles on hand
                  </span>
                </header>
                {entries.length === 0 ? (
                  <div className="empty">No stock recorded yet.</div>
                ) : (
                  <div className="table-wrap" style={{ border: 0 }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th className="table__num">On hand</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map(([pid, qty]) => (
                          <tr key={pid}>
                            <td>{productName(pid)}</td>
                            <td
                              className="table__num"
                              style={{
                                fontWeight: 700,
                                color:
                                  qty <= 0
                                    ? "var(--danger)"
                                    : qty <= 50
                                      ? "var(--warning)"
                                      : "var(--ink)",
                              }}
                            >
                              {qty.toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </Shell>
  );
}

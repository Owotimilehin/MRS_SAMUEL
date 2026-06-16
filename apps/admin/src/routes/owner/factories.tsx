import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import { StatHero } from "../../components/StatHero.js";

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
interface StockRow {
  product_id: string;
  variant_id: string | null;
  size_ml: number | null;
  balance: number;
}

const sizeLabel = (ml: number | null): string => (ml ? `${ml}ml` : "No size");

export function FactoriesPage(): JSX.Element {
  const [rows, setRows] = useState<Factory[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  // Per-factory, the raw per-(product, size) balances so we can show the
  // bottle distribution per size instead of only a per-flavour roll-up.
  const [balances, setBalances] = useState<Record<string, StockRow[]>>({});
  const [loading, setLoading] = useState(true);

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
        // Pull per-size stock for each factory.
        const stocks = await Promise.all(
          f.data.map((row) =>
            api<{ data: StockRow[] }>(`/stock/factory/${row.id}`).then((r) => ({
              id: row.id,
              data: r.data,
            })),
          ),
        );
        if (cancelled) return;
        const next: Record<string, StockRow[]> = {};
        for (const s of stocks) next[s.id] = s.data;
        setBalances(next);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const productName = (id: string): string => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  const totalBottles = Object.values(balances).reduce(
    (sum, stock) => sum + stock.reduce((s, r) => s + r.balance, 0),
    0,
  );
  const withStock = Object.values(balances).filter((s) => s.some((r) => r.balance > 0)).length;

  return (
    <Shell title="Factories">
      <StatHero
        eyebrow="Admin"
        title="Factories"
        sub="Production sites that supply stock to branches."
        loading={loading}
        chips={[
          { label: "Factories", value: rows.length },
          { label: "With stock", value: withStock, tone: withStock > 0 ? "good" : "warn" },
          { label: "Bottles on hand", value: totalBottles.toLocaleString() },
        ]}
      />

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
            const stock = balances[f.id] ?? [];
            // Group the per-size rows under each flavour, sorted by flavour
            // total (desc) then size (asc) so the biggest holdings lead.
            const byProduct = new Map<string, StockRow[]>();
            for (const x of stock) {
              const list = byProduct.get(x.product_id) ?? [];
              list.push(x);
              byProduct.set(x.product_id, list);
            }
            const groups = [...byProduct.entries()]
              .map(([pid, sizes]) => ({
                pid,
                sizes: [...sizes].sort((a, b) => (a.size_ml ?? 0) - (b.size_ml ?? 0)),
                total: sizes.reduce((sum, s) => sum + s.balance, 0),
              }))
              .sort((a, b) => b.total - a.total);
            const totalUnits = groups.reduce((sum, g) => sum + g.total, 0);
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
                {groups.length === 0 ? (
                  <div className="empty">No stock recorded yet.</div>
                ) : (
                  <div className="table-wrap" style={{ border: 0 }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th>Size</th>
                          <th className="table__num">On hand</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups.map((g) =>
                          g.sizes.map((s, i) => (
                            <tr key={`${g.pid}:${s.variant_id ?? "null"}`}>
                              {i === 0 ? (
                                <td rowSpan={g.sizes.length} style={{ verticalAlign: "top", fontWeight: 600 }}>
                                  {productName(g.pid)}
                                  <div style={{ color: "var(--ink-soft)", fontSize: 12, fontWeight: 400, marginTop: 2 }}>
                                    {g.total.toLocaleString()} total
                                  </div>
                                </td>
                              ) : null}
                              <td style={{ color: "var(--ink-soft)" }}>{sizeLabel(s.size_ml)}</td>
                              <td
                                className="table__num"
                                style={{
                                  fontWeight: 700,
                                  color:
                                    s.balance <= 0
                                      ? "var(--danger)"
                                      : s.balance <= 50
                                        ? "var(--warning)"
                                        : "var(--ink)",
                                }}
                              >
                                {s.balance.toLocaleString()}
                              </td>
                            </tr>
                          )),
                        )}
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

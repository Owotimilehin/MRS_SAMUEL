import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";

interface Factory { id: string; name: string }
interface Product { id: string; name: string; category: string }

export function FactoryInventoryPage(): JSX.Element {
  const [factories, setFactories] = useState<Factory[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [stock, setStock] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [f, p] = await Promise.all([
          api<{ data: Factory[] }>(`/factories`),
          api<{ data: Product[] }>(`/products`),
        ]);
        if (cancelled) return;
        setFactories(f.data);
        setProducts(p.data);
        const balances = await Promise.all(
          f.data.map((row) =>
            api<{ data: Array<{ product_id: string; variant_id: string | null; balance: number }> }>(
              `/stock/factory/${row.id}`,
            ).then((r) => {
              // Reads are per-variant; roll up to per-flavour totals for this view.
              const totals: Record<string, number> = {};
              for (const x of r.data) totals[x.product_id] = (totals[x.product_id] ?? 0) + x.balance;
              return { id: row.id, data: totals };
            }),
          ),
        );
        if (cancelled) return;
        const next: Record<string, Record<string, number>> = {};
        for (const x of balances) next[x.id] = x.data;
        setStock(next);
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

  const sortedProducts = [...products].sort((a, b) =>
    a.category === b.category
      ? a.name.localeCompare(b.name)
      : a.category.localeCompare(b.category),
  );

  return (
    <Shell title="Factory inventory">
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
      ) : factories.length === 0 ? (
        <div className="empty">No factories configured.</div>
      ) : (
        factories.map((f) => (
          <section key={f.id} className="card" style={{ marginBottom: 18 }}>
            <h2 className="t-h2" style={{ marginBottom: 12 }}>
              {f.name}
            </h2>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Product</th>
                    <th className="table__num">On hand</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedProducts.map((p) => {
                    const qty = stock[f.id]?.[p.id] ?? 0;
                    return (
                      <tr key={p.id}>
                        <td style={{ color: "var(--ink-soft)" }}>{p.category}</td>
                        <td>{p.name}</td>
                        <td className="table__num" style={{ fontWeight: 700 }}>
                          {qty}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}

      <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 14 }}>
        Read-only view. Only the owner can adjust stock — they do that from
        Owner → Inventory.
      </p>
    </Shell>
  );
}

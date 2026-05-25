import { useEffect, useMemo, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";

interface BranchStockRow {
  branch_id: string;
  product_id: string;
  balance: number;
}
interface Product {
  id: string;
  name: string;
  category: string;
}
interface Branch {
  id: string;
  name: string;
}
interface Factory {
  id: string;
  name: string;
}

export function InventoryPage(): JSX.Element {
  const [branchStock, setBranchStock] = useState<BranchStockRow[]>([]);
  const [factoryStock, setFactoryStock] = useState<Record<string, Record<string, number>>>({});
  const [products, setProducts] = useState<Product[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [factories, setFactories] = useState<Factory[]>([]);
  const [view, setView] = useState<"branch" | "factory">("branch");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [bs, p, b, f] = await Promise.all([
          api<{ data: BranchStockRow[] }>(`/reports/branch-stock`),
          api<{ data: Product[] }>(`/products`),
          api<{ data: Branch[] }>(`/branches`),
          api<{ data: Factory[] }>(`/factories`),
        ]);
        if (cancelled) return;
        setBranchStock(bs.data);
        setProducts(p.data);
        setBranches(b.data);
        setFactories(f.data);
        // Pull factory stock
        const fs = await Promise.all(
          f.data.map((row) =>
            api<{ data: Record<string, number> }>(`/stock/factory/${row.id}`).then((r) => ({
              id: row.id,
              data: r.data,
            })),
          ),
        );
        if (cancelled) return;
        const next: Record<string, Record<string, number>> = {};
        for (const x of fs) next[x.id] = x.data;
        setFactoryStock(next);
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

  // Branch heatmap: rows = products, cols = branches
  const branchHeat = useMemo(() => {
    const byBranchProduct = new Map<string, number>();
    for (const row of branchStock) {
      byBranchProduct.set(`${row.branch_id}|${row.product_id}`, row.balance);
    }
    return byBranchProduct;
  }, [branchStock]);

  function cellTone(qty: number): string {
    if (qty <= 0) return "var(--danger)";
    if (qty <= 10) return "var(--warning)";
    return "var(--ink)";
  }
  function cellBg(qty: number): string {
    if (qty <= 0) return "rgba(220,38,38,0.10)";
    if (qty <= 10) return "rgba(245,158,11,0.10)";
    if (qty <= 30) return "rgba(252,191,73,0.08)";
    return "transparent";
  }

  return (
    <Shell
      title="Inventory"
      actions={
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className={view === "branch" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
            onClick={() => setView("branch")}
          >
            Branches
          </button>
          <button
            type="button"
            className={view === "factory" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
            onClick={() => setView("factory")}
          >
            Factories
          </button>
        </div>
      }
    >
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
      ) : view === "branch" ? (
        branches.length === 0 ? (
          <div className="empty">No branches yet.</div>
        ) : (
          <div className="table-wrap" style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ position: "sticky", left: 0, background: "var(--surface-sunken)" }}>Product</th>
                  {branches.map((b) => (
                    <th key={b.id} className="table__num">
                      {b.name}
                    </th>
                  ))}
                  <th className="table__num">Total</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const cells = branches.map((b) => branchHeat.get(`${b.id}|${p.id}`) ?? 0);
                  const total = cells.reduce((sum, q) => sum + q, 0);
                  return (
                    <tr key={p.id}>
                      <td style={{ position: "sticky", left: 0, background: "var(--shell)", fontWeight: 600 }}>
                        {p.name}
                      </td>
                      {cells.map((q, idx) => (
                        <td
                          key={branches[idx]!.id}
                          className="table__num"
                          style={{
                            fontWeight: 700,
                            color: cellTone(q),
                            background: cellBg(q),
                          }}
                        >
                          {q}
                        </td>
                      ))}
                      <td className="table__num" style={{ fontWeight: 800, color: cellTone(total) }}>
                        {total}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : factories.length === 0 ? (
        <div className="empty">No factories configured.</div>
      ) : (
        <div className="table-wrap" style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, background: "var(--surface-sunken)" }}>Product</th>
                {factories.map((f) => (
                  <th key={f.id} className="table__num">
                    {f.name}
                  </th>
                ))}
                <th className="table__num">Total</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const cells = factories.map((f) => factoryStock[f.id]?.[p.id] ?? 0);
                const total = cells.reduce((sum, q) => sum + q, 0);
                return (
                  <tr key={p.id}>
                    <td style={{ position: "sticky", left: 0, background: "var(--shell)", fontWeight: 600 }}>
                      {p.name}
                    </td>
                    {cells.map((q, idx) => (
                      <td
                        key={factories[idx]!.id}
                        className="table__num"
                        style={{
                          fontWeight: 700,
                          color: cellTone(q),
                          background: cellBg(q),
                        }}
                      >
                        {q.toLocaleString()}
                      </td>
                    ))}
                    <td className="table__num" style={{ fontWeight: 800, color: cellTone(total) }}>
                      {total.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 12 }}>
        Red = out of stock · amber = low (≤10) · pale = caution (≤30).
      </p>
    </Shell>
  );
}

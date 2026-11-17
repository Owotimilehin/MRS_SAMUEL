import { Fragment, useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { StatHero } from "../../components/StatHero.js";
import type { StatChip } from "../../components/StatHero.js";
import { api, humanizeError } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import { useAuthUser } from "../../lib/auth.js";
import { hasCapability } from "@ms/shared";

interface Factory { id: string; name: string }
interface Product { id: string; name: string; category: string }

/** "regular" → "Regular", "made_to_order" → "Made to order". */
function categoryLabel(raw: string): string {
  const words = raw.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "—";
}

export function FactoryInventoryPage(): JSX.Element {
  const [factories, setFactories] = useState<Factory[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [stock, setStock] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(true);
  const canAdjust = hasCapability(useAuthUser().capabilities, "stock.adjust");

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

  const sortedProducts = [...products].sort((a, b) =>
    a.category === b.category
      ? a.name.localeCompare(b.name)
      : a.category.localeCompare(b.category),
  );

  // Chips: derive from already-loaded data only (no new API calls).
  // "Low" threshold not present in the loaded interface — chip omitted.
  const totalProducts = products.length;
  const totalOnHand = Object.values(stock).reduce(
    (sum, factoryMap) => sum + Object.values(factoryMap).reduce((s, n) => s + n, 0),
    0,
  );
  const inventoryChips: StatChip[] = [
    { label: "Products", value: totalProducts ?? 0 },
    { label: "On hand (bottles)", value: totalOnHand ?? 0 },
  ];

  return (
    <Shell title="Factory inventory">
      <StatHero
        eyebrow="Factory"
        title="Factory inventory"
        sub="Finished-goods balances across all factory locations."
        loading={loading}
        chips={inventoryChips}
      />

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
                {/* Category is a heading row above its products rather than a
                    column, so product names keep the full width on a phone. */}
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="table__num" style={{ width: "1%", whiteSpace: "nowrap" }}>On hand</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedProducts.map((p, i) => {
                    const qty = stock[f.id]?.[p.id] ?? 0;
                    const newCategory = i === 0 || sortedProducts[i - 1]!.category !== p.category;
                    return (
                      <Fragment key={p.id}>
                        {newCategory && (
                          <tr>
                            <th
                              colSpan={2}
                              scope="rowgroup"
                              style={{
                                textAlign: "left",
                                padding: "8px 18px",
                                fontSize: 12,
                                fontWeight: 700,
                                color: "var(--ink-soft)",
                                background: "var(--surface-sunken)",
                                borderBottom: "1px solid var(--line)",
                              }}
                            >
                              {categoryLabel(p.category)}
                            </th>
                          </tr>
                        )}
                        <tr>
                          <td>{p.name}</td>
                          <td className="table__num" style={{ fontWeight: 700 }}>
                            {qty}
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}

      {!canAdjust && (
        <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 14 }}>
          You can view these numbers but not change them. Only the owner can adjust stock, from
          Owner → Inventory.
        </p>
      )}
    </Shell>
  );
}

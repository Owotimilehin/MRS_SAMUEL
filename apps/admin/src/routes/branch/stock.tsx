import { useEffect, useState } from "react";
import { BranchShell } from "../../components/BranchShell.js";
import { local, localAvailableForProduct, type ProductRow } from "../../db/local.js";

interface BranchStockPageProps {
  branchId: string;
}

interface StockRow {
  product: ProductRow;
  available: number;
}

export function BranchStockPage({ branchId }: BranchStockPageProps): JSX.Element {
  const [rows, setRows] = useState<StockRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const products = await local.products.toArray();
      const enriched = await Promise.all(
        products.map(async (p) => ({
          product: p,
          available: await localAvailableForProduct(branchId, p.id),
        })),
      );
      if (!cancelled) {
        setRows(enriched.sort((a, b) => a.product.name.localeCompare(b.product.name)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  return (
    <BranchShell branchId={branchId} title="Stock on hand">
      <p className="mb-4" style={{ color: "var(--ms-ink-3)" }}>
        Based on your branch's local copy of the ledger. Updates after every sale.
      </p>
      <div
        className="overflow-hidden"
        style={{
          background: "var(--ms-surface)",
          border: "1px solid var(--ms-border)",
          borderRadius: 14,
        }}
      >
        <table className="w-full text-sm">
          <thead style={{ background: "var(--ms-surface-alt)" }}>
            <tr>
              <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                Flavor
              </th>
              <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                Category
              </th>
              <th className="text-right px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                Bottles available
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ product, available }) => (
              <tr key={product.id} style={{ borderTop: "1px solid var(--ms-divider)" }}>
                <td className="px-4 py-3 font-semibold">{product.name}</td>
                <td className="px-4 py-3 text-xs" style={{ color: "var(--ms-ink-3)" }}>
                  {product.category}
                </td>
                <td
                  className="px-4 py-3 text-right tabular-nums font-semibold"
                  style={{
                    color:
                      available <= 0
                        ? "var(--ms-danger)"
                        : available < 5
                          ? "var(--ms-warn)"
                          : "var(--ms-ink)",
                  }}
                >
                  {available}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </BranchShell>
  );
}

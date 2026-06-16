import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import type { StatChip } from "../../components/StatHero.js";
import { local, type ProductRow, type VariantRow } from "../../db/local.js";
import { api } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface ServerBalance {
  product_id: string;
  variant_id: string | null;
  balance: number;
}

const sizeLabel = (ml: number | null): string =>
  ml == null ? "Unsized" : ml >= 1000 ? `${ml / 1000}L` : `${ml}ml`;

export function BranchStockPage({ branchId }: { branchId: string }): JSX.Element {
  const products = useLiveQuery(() => local.products.toArray(), [], [] as ProductRow[]);
  const variants = useLiveQuery(() => local.variants.toArray(), [], [] as VariantRow[]);
  const [balances, setBalances] = useState<ServerBalance[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<{ data: ServerBalance[] }>(`/stock/branch/${branchId}`);
        if (!cancelled) setBalances(res.data);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  const productName = (id: string): string =>
    (products as ProductRow[]).find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const sizeForVariant = (variantId: string | null): number | null =>
    variantId == null ? null : (variants as VariantRow[]).find((v) => v.id === variantId)?.size_ml ?? null;

  // One row per (flavour × can size) — the per-size record the till keeps now.
  const rows = balances
    .map((b) => ({
      key: `${b.product_id}|${b.variant_id ?? "null"}`,
      product_id: b.product_id,
      name: productName(b.product_id),
      size_ml: sizeForVariant(b.variant_id),
      unsized: b.variant_id == null,
      balance: b.balance,
    }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        (a.size_ml ?? Number.MAX_SAFE_INTEGER) - (b.size_ml ?? Number.MAX_SAFE_INTEGER),
    );

  const oosCount = rows.filter((r) => r.balance <= 0).length;
  const lowCount = rows.filter((r) => r.balance > 0 && r.balance <= 5).length;
  const unsizedCount = rows.filter((r) => r.unsized && r.balance !== 0).length;

  const onHandTotal = rows.reduce((sum, r) => sum + (r.balance > 0 ? r.balance : 0), 0);

  const stockChips: StatChip[] = [
    { label: "On hand", value: onHandTotal ?? 0 },
    { label: "Size lines", value: rows.length ?? 0 },
  ];
  if (oosCount > 0) {
    stockChips.push({ label: "Out of stock", value: oosCount, tone: "danger" });
  } else {
    stockChips.push({ label: "Out of stock", value: oosCount, tone: "good" });
  }
  if (lowCount > 0) {
    stockChips.push({ label: "Low (≤5)", value: lowCount, tone: "warn" });
  } else {
    stockChips.push({ label: "Low (≤5)", value: lowCount });
  }

  return (
    <BranchShell branchId={branchId} title="Stock">
      <StatHero
        eyebrow="Branch"
        title="Stock"
        sub="Per-size on-hand quantities for this branch."
        loading={loading}
        chips={stockChips}
      />

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">No stock recorded yet for this branch.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Flavour</th>
                <th>Size</th>
                <th className="table__num">On hand</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tone =
                  r.balance <= 0 ? "danger" : r.balance <= 5 ? "warning" : r.balance <= 15 ? "default" : "success";
                return (
                  <tr key={r.key}>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td style={{ color: r.unsized ? "var(--warning)" : "var(--ink-soft)" }}>
                      {sizeLabel(r.size_ml)}
                    </td>
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
                      {r.balance}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {r.unsized && r.balance !== 0 ? (
                        <span className="pill pill--warning">Assign a size</span>
                      ) : tone === "danger" ? (
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
        Stock is now tracked per can size. An <strong>Unsized</strong> line is older stock not yet
        assigned to a size — reconcile it with an inventory adjustment so per-size counts are exact.
      </p>
    </BranchShell>
  );
}

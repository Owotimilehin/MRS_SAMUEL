import { useCallback, useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import type { StatChip } from "../../components/StatHero.js";
import { local, type ProductRow, type VariantRow } from "../../db/local.js";
import { api } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import { useAuthUser } from "../../lib/auth.js";
import { hasCapability } from "@ms/shared";
import { adjustBranchStockBulk, REASONS, type BulkAdjustItem } from "../../lib/stock-adjust.js";

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

  const user = useAuthUser();
  const canAdjust = hasCapability(user.capabilities, "stock.adjust");

  // Adjust mode: editable new-count drafts keyed by row key, a shared reason,
  // and a saving flag. Drafts start from the current balances when entering mode.
  const [adjusting, setAdjusting] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reasonCode, setReasonCode] = useState("physical_recount");
  const [reasonNote, setReasonNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api<{ data: ServerBalance[] }>(`/stock/branch/${branchId}`);
      setBalances(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  function enterAdjust(): void {
    const seed: Record<string, string> = {};
    for (const r of rows) seed[r.key] = String(r.balance);
    setDrafts(seed);
    setReasonCode("physical_recount");
    setReasonNote("");
    setAdjusting(true);
  }

  function cancelAdjust(): void {
    setAdjusting(false);
    setDrafts({});
  }

  async function saveAdjust(): Promise<void> {
    // Only rows whose draft differs from the current balance and parses to a
    // non-negative integer become adjustment items. Unsized rows (variant_id
    // null) are skipped — they're a reconciliation concern, not a recount here.
    const items: BulkAdjustItem[] = [];
    for (const r of rows) {
      if (r.unsized) continue;
      const raw = drafts[r.key];
      if (raw == null || raw.trim() === "") continue;
      const next = Number(raw);
      if (!Number.isInteger(next) || next < 0) {
        toast.error(`Enter a whole number ≥ 0 for ${r.name} ${sizeLabel(r.size_ml)}.`);
        return;
      }
      if (next === r.balance) continue;
      const variantId = balances.find(
        (b) => b.product_id === r.product_id && sizeForVariant(b.variant_id) === r.size_ml,
      )?.variant_id ?? null;
      if (variantId == null) continue;
      items.push({ productId: r.product_id, variantId, newQuantity: next });
    }
    if (items.length === 0) {
      toast.error("No counts changed.");
      return;
    }
    if (reasonCode === "other_with_note" && reasonNote.trim().length === 0) {
      toast.error("Add a note for 'Other'.");
      return;
    }
    setSaving(true);
    try {
      await adjustBranchStockBulk({
        branchId,
        reasonCode,
        ...(reasonNote.trim() ? { reasonNote: reasonNote.trim() } : {}),
        items,
      });
      toast.success(`Updated ${items.length} stock ${items.length === 1 ? "line" : "lines"}.`);
      setAdjusting(false);
      setDrafts({});
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(
        /would_go_negative|negative/i.test(msg) ? "A count would go below 0 — re-check and try again." : msg,
      );
    } finally {
      setSaving(false);
    }
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

      {canAdjust && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "14px 0" }}>
          {!adjusting ? (
            <button type="button" className="btn btn--subtle btn--sm" onClick={enterAdjust} disabled={loading || rows.length === 0}>
              Adjust stock
            </button>
          ) : (
            <>
              <select className="select" style={{ maxWidth: 220 }} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} disabled={saving}>
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              {reasonCode === "other_with_note" && (
                <input className="input" style={{ maxWidth: 240 }} placeholder="Describe what happened" value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} disabled={saving} />
              )}
              <button type="button" className="btn btn--primary btn--sm" onClick={() => void saveAdjust()} disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </button>
              <button type="button" className="btn btn--subtle btn--sm" onClick={cancelAdjust} disabled={saving}>
                Cancel
              </button>
              <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                Enter new on-hand per size. Selling continues from the new count.
              </span>
            </>
          )}
        </div>
      )}

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
                      {adjusting && !r.unsized ? (
                        <input
                          className="input"
                          type="number"
                          min={0}
                          inputMode="numeric"
                          value={drafts[r.key] ?? String(r.balance)}
                          onChange={(e) => setDrafts((d) => ({ ...d, [r.key]: e.target.value }))}
                          disabled={saving}
                          style={{ width: 84, textAlign: "right" }}
                        />
                      ) : (
                        r.balance
                      )}
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

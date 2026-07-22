import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { api, humanizeError } from "../lib/api.js";
import { toast } from "../lib/toast.js";
import { defaultStrawCount, defaultBagSize, pickBagMaterial } from "../lib/packaging-defaults.js";

interface BagStockRow { material_id: string; name: string; kind: "bag" | "straw"; balance: number }
export interface PackagingCardHandle { saveIfDirty: () => Promise<void> }

interface Props {
  branchId: string;
  orderId: string;
  items: Array<{ sizeMl: number | null; quantity: number }>;
  savedPackaging: Array<{ packaging_material_id: string; quantity: number }>;
  readOnly?: boolean;
  onSaved?: () => void;
}

/**
 * Lets whoever fulfils an online order record the straws + bags used to pack it.
 * Prefills sensible defaults (1 straw per bottle; bag size by bottle count) but every
 * field is editable. Saving PUTs to /sales/:id/packaging (diff-ledger). The parent
 * calls `saveIfDirty()` on the produce/advance CTA so packaging is flushed in one tap.
 */
export const PackagingCard = forwardRef<PackagingCardHandle, Props>(function PackagingCard(
  { branchId, orderId, items, savedPackaging, readOnly, onSaved },
  ref,
) {
  const [materials, setMaterials] = useState<BagStockRow[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  // The last-persisted quantities, keyed by material id — dirtiness is measured against this.
  const savedRef = useRef<Record<string, number>>({});

  const bottleCount = useMemo(() => defaultStrawCount(items), [items]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ data: BagStockRow[] }>(`/branches/${branchId}/sales/bags`);
        if (cancelled) return;
        setMaterials(res.data);

        const saved: Record<string, number> = {};
        for (const p of savedPackaging) saved[p.packaging_material_id] = p.quantity;
        savedRef.current = saved;

        if (savedPackaging.length > 0) {
          setQty(saved); // already packed — show what was saved
        } else {
          // Prefill defaults: 1 straw per bottle + 1 bag sized by count.
          const next: Record<string, number> = {};
          const straw = res.data.find((m) => m.kind === "straw");
          if (straw && bottleCount > 0) next[straw.material_id] = bottleCount;
          const bag = pickBagMaterial(res.data.filter((m) => m.kind === "bag"), defaultBagSize(bottleCount));
          if (bag) next[bag.material_id] = 1;
          setQty(next);
        }
      } catch {
        if (!cancelled) setMaterials([]); // offline/no access — card renders empty
      }
    })();
    return () => { cancelled = true; };
  }, [branchId, orderId, savedPackaging, bottleCount]);

  const isDirty = useMemo(() => {
    const ids = new Set([...Object.keys(qty), ...Object.keys(savedRef.current)]);
    for (const id of ids) {
      if ((qty[id] ?? 0) !== (savedRef.current[id] ?? 0)) return true;
    }
    return false;
  }, [qty]);

  const save = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      const packaging = Object.entries(qty)
        .filter(([, q]) => q > 0)
        .map(([packaging_material_id, quantity]) => ({ packaging_material_id, quantity }));
      await api(`/branches/${branchId}/sales/${orderId}/packaging`, {
        method: "PUT",
        body: JSON.stringify({ packaging }),
      });
      savedRef.current = { ...qty };
      onSaved?.();
      toast.success("Packaging saved");
    } catch (err) {
      toast.error(humanizeError(err));
      throw err; // let a CTA flush abort on failure
    } finally {
      setSaving(false);
    }
  }, [qty, branchId, orderId, onSaved]);

  useImperativeHandle(ref, () => ({
    saveIfDirty: async () => { if (isDirty) await save(); },
  }), [isDirty, save]);

  if (materials.length === 0) return null;

  function setQtyFor(id: string, value: number): void {
    setQty((q) => ({ ...q, [id]: Math.max(0, Math.floor(value || 0)) }));
  }

  return (
    <section className="card">
      <header style={{ marginBottom: 12 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700 }}>Packaging</h3>
        <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 2 }}>
          Straws + bag used to pack this order. Edit any count, then save.
        </p>
      </header>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {materials.map((m) => (
          <div
            key={m.material_id}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
          >
            <div>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</span>
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 12,
                  color: m.balance < 0 ? "var(--danger)" : "var(--ink-soft)",
                }}
              >
                {m.balance} in stock
              </span>
            </div>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              disabled={readOnly || saving}
              value={qty[m.material_id] ?? 0}
              onChange={(e) => setQtyFor(m.material_id, Number(e.target.value))}
              aria-label={`${m.name} quantity`}
              style={{ width: 80, textAlign: "right" }}
            />
          </div>
        ))}
      </div>
      {!readOnly && (
        <button
          type="button"
          className="btn btn--primary btn--sm"
          style={{ marginTop: 12 }}
          disabled={!isDirty || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save packaging"}
        </button>
      )}
    </section>
  );
});

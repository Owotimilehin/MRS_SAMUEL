import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDate } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { useAuthUser } from "../../lib/auth.js";

interface Material {
  id: string;
  name: string;
  unit_label: string;
  size_ml: number | null;
  is_active: boolean;
}

interface StockRow {
  material_id: string;
  name: string;
  unit_label: string;
  size_ml: number | null;
  balance: number;
  recent_unit_cost_ngn: number | null;
}

interface Purchase {
  id: string;
  factoryId: string;
  packagingMaterialId: string;
  quantity: number;
  unitCostNgn: number;
  totalCostNgn: number;
  supplierName: string | null;
  purchaseDate: string;
  businessExpenseId: string | null;
}

interface Factory { id: string; name: string }

function balanceTone(qty: number): string {
  if (qty < 100) return "var(--danger)";
  if (qty < 500) return "var(--warning)";
  return "var(--success)";
}

export function PackagingPage(): JSX.Element {
  const user = useAuthUser();
  const canWrite = user.capabilities.includes("packaging.write");
  const [tab, setTab] = useState<"stock" | "purchases" | "materials">("stock");
  const [factories, setFactories] = useState<Factory[]>([]);
  const [factoryId, setFactoryId] = useState<string>("");
  const [stock, setStock] = useState<StockRow[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddPurchase, setShowAddPurchase] = useState(false);
  const [showAddMaterial, setShowAddMaterial] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  async function loadFactories(): Promise<void> {
    const res = await api<{ data: Factory[] }>(`/factories`);
    setFactories(res.data);
    if (!factoryId && res.data[0]) setFactoryId(res.data[0].id);
  }

  async function loadAll(): Promise<void> {
    if (!factoryId) return;
    setLoading(true);
    try {
      const [s, m, p] = await Promise.all([
        api<{ data: StockRow[] }>(`/packaging/stock?factory_id=${factoryId}`),
        api<{ data: Material[] }>(`/packaging/materials`),
        api<{ data: Purchase[] }>(`/packaging/purchases?factory_id=${factoryId}`),
      ]);
      setStock(s.data);
      setMaterials(m.data);
      setPurchases(p.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadFactories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factoryId]);

  const materialById = useMemo(
    () => new Map(materials.map((m) => [m.id, m])),
    [materials],
  );

  return (
    <Shell
      title="Packaging"
      actions={
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className={tab === "stock" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
            onClick={() => setTab("stock")}
          >Stock</button>
          <button
            type="button"
            className={tab === "purchases" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
            onClick={() => setTab("purchases")}
          >Purchases</button>
          <button
            type="button"
            className={tab === "materials" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
            onClick={() => setTab("materials")}
          >Materials</button>
        </div>
      }
    >
      {error && (
        <div className="card" style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <label className="field__label" htmlFor="pkg-factory">Factory</label>
        <select
          id="pkg-factory"
          className="select"
          value={factoryId}
          onChange={(e) => setFactoryId(e.target.value)}
          style={{ width: 240 }}
        >
          {factories.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        {tab === "purchases" && canWrite && (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowAddPurchase(true)}>
            + Record purchase
          </button>
        )}
        {tab === "materials" && canWrite && (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowAddMaterial(true)}>
            + Add material
          </button>
        )}
      </div>

      {loading ? (
        <InlineLoader />
      ) : tab === "stock" ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Material</th>
                <th className="table__num">On hand</th>
                <th className="table__num">Recent unit cost</th>
              </tr>
            </thead>
            <tbody>
              {stock.length === 0 ? (
                <tr><td colSpan={3} style={{ color: "var(--ink-soft)", padding: 18 }}>No materials configured yet.</td></tr>
              ) : (
                stock.map((s) => (
                  <tr key={s.material_id}>
                    <td>{s.name}</td>
                    <td className="table__num" style={{ fontWeight: 700, color: balanceTone(s.balance) }}>
                      {s.balance.toLocaleString()}
                    </td>
                    <td className="table__num" style={{ color: "var(--ink-soft)" }}>
                      {s.recent_unit_cost_ngn != null ? ngn(s.recent_unit_cost_ngn) : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : tab === "purchases" ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Material</th>
                <th className="table__num">Qty</th>
                <th className="table__num">Unit cost</th>
                <th className="table__num">Total</th>
                <th>Supplier</th>
                <th>Linked expense</th>
              </tr>
            </thead>
            <tbody>
              {purchases.length === 0 ? (
                <tr><td colSpan={7} style={{ color: "var(--ink-soft)", padding: 18 }}>No purchases in range.</td></tr>
              ) : (
                purchases.map((p) => (
                  <tr key={p.id}>
                    <td>{formatDate(p.purchaseDate)}</td>
                    <td>{materialById.get(p.packagingMaterialId)?.name ?? p.packagingMaterialId.slice(0, 8)}</td>
                    <td className="table__num">{p.quantity.toLocaleString()}</td>
                    <td className="table__num">{ngn(p.unitCostNgn)}</td>
                    <td className="table__num" style={{ fontWeight: 700 }}>{ngn(p.totalCostNgn)}</td>
                    <td>{p.supplierName ?? "—"}</td>
                    <td>{p.businessExpenseId ? <span className="pill pill--success">📒</span> : <span style={{ color: "var(--ink-soft)" }}>—</span>}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Unit</th>
                <th>Size (ml)</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {materials.length === 0 ? (
                <tr><td colSpan={4} style={{ color: "var(--ink-soft)", padding: 18 }}>No materials yet. Add one to start tracking.</td></tr>
              ) : (
                materials.map((m) => (
                  <tr key={m.id}>
                    <td style={{ fontWeight: 600 }}>{m.name}</td>
                    <td>{m.unit_label}</td>
                    <td>{m.size_ml ?? "—"}</td>
                    <td>{m.is_active ? "Yes" : "No"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {flash && (
        <div className="card" style={{ borderColor: "rgba(16,185,129,0.35)", color: "var(--success)", position: "fixed", bottom: 20, right: 20, zIndex: 60 }}>
          {flash}
        </div>
      )}

      {showAddPurchase && (
        <PurchaseModal
          factoryId={factoryId}
          factories={factories}
          materials={materials.filter((m) => m.is_active)}
          onClose={() => setShowAddPurchase(false)}
          onSaved={async () => {
            setShowAddPurchase(false);
            setFlash("Purchase recorded");
            setTimeout(() => setFlash(null), 2500);
            await loadAll();
          }}
        />
      )}

      {showAddMaterial && (
        <MaterialModal
          onClose={() => setShowAddMaterial(false)}
          onSaved={async () => {
            setShowAddMaterial(false);
            setFlash("Material added");
            setTimeout(() => setFlash(null), 2500);
            await loadAll();
          }}
        />
      )}
    </Shell>
  );
}

function PurchaseModal({
  factoryId,
  factories,
  materials,
  onClose,
  onSaved,
}: {
  factoryId: string;
  factories: Factory[];
  materials: Material[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [selFactoryId, setSelFactoryId] = useState(factoryId);
  const [materialId, setMaterialId] = useState(materials[0]?.id ?? "");
  const [quantity, setQuantity] = useState<number>(0);
  const [unitCost, setUnitCost] = useState<number>(0);
  const [totalCost, setTotalCost] = useState<number>(0);
  const [supplier, setSupplier] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().slice(0, 10));
  const [feedBookkeeping, setFeedBookkeeping] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTotalCost(quantity * unitCost);
  }, [quantity, unitCost]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!materialId || !selFactoryId) {
      setError("Pick a material and factory");
      return;
    }
    if (quantity <= 0 || unitCost < 0) {
      setError("Quantity must be > 0 and unit cost ≥ 0");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api(`/packaging/purchases`, {
        method: "POST",
        body: JSON.stringify({
          factory_id: selFactoryId,
          packaging_material_id: materialId,
          quantity: Math.round(quantity),
          unit_cost_ngn: Math.round(unitCost),
          total_cost_ngn: Math.round(totalCost),
          supplier_name: supplier.trim() || undefined,
          purchase_date: purchaseDate,
          feed_bookkeeping: feedBookkeeping,
        }),
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      style={{ position: "fixed", inset: 0, background: "rgba(20,24,31,0.45)", display: "grid", placeItems: "center", zIndex: 50, padding: 16 }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: "100%", maxWidth: 520, background: "var(--shell)", boxShadow: "var(--shadow-float)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={{ marginBottom: 14 }}>
          <h2 className="t-h2">Record purchase</h2>
        </header>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="field">
            <label className="field__label" htmlFor="pkg-fac">Factory</label>
            <select id="pkg-fac" className="select" value={selFactoryId} onChange={(e) => setSelFactoryId(e.target.value)}>
              {factories.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="pkg-mat">Material</label>
            <select id="pkg-mat" className="select" value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
              {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <div className="field">
              <label className="field__label" htmlFor="pkg-qty">Quantity</label>
              <input id="pkg-qty" className="input" type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} style={{ textAlign: "right" }} required />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="pkg-unit">Unit cost (₦)</label>
              <input id="pkg-unit" className="input" type="number" min={0} value={unitCost} onChange={(e) => setUnitCost(Number(e.target.value))} style={{ textAlign: "right" }} required />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="pkg-total">Total (₦)</label>
              <input id="pkg-total" className="input" type="number" min={0} value={totalCost} onChange={(e) => setTotalCost(Number(e.target.value))} style={{ textAlign: "right" }} required />
            </div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="pkg-supplier">Supplier (optional)</label>
            <input id="pkg-supplier" className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. Glass Co. Lagos" />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="pkg-date">Purchase date</label>
            <input id="pkg-date" className="input" type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} required />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
            <input
              type="checkbox"
              checked={feedBookkeeping}
              onChange={(e) => setFeedBookkeeping(e.target.checked)}
            />
            Also record as expense in Bookkeeping (packaging category)
          </label>
          {error && <div className="field__error">{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="btn btn--subtle" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? "Recording…" : "Record purchase"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MaterialModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState("");
  const [unitLabel, setUnitLabel] = useState("bottle");
  const [sizeMl, setSizeMl] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || !unitLabel.trim()) {
      setError("Name and unit label are required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api(`/packaging/materials`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          unit_label: unitLabel.trim(),
          size_ml: sizeMl ? Number(sizeMl) : null,
        }),
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      style={{ position: "fixed", inset: 0, background: "rgba(20,24,31,0.45)", display: "grid", placeItems: "center", zIndex: 50, padding: 16 }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: "100%", maxWidth: 460, background: "var(--shell)", boxShadow: "var(--shadow-float)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={{ marginBottom: 14 }}>
          <h2 className="t-h2">Add material</h2>
        </header>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="field">
            <label className="field__label" htmlFor="m-name">Name</label>
            <input id="m-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required placeholder="e.g. 330ml glass bottle" />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="m-unit">Unit label</label>
            <input id="m-unit" className="input" value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} required placeholder="bottle, cap, label, …" />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="m-size">Size (ml) — optional</label>
            <input id="m-size" className="input" type="number" min={1} value={sizeMl} onChange={(e) => setSizeMl(e.target.value)} placeholder="330" />
          </div>
          {error && <div className="field__error">{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="btn btn--subtle" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? "Adding…" : "Add material"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { useAuthUser } from "../../lib/auth.js";

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
interface AdjustTarget {
  locationType: "factory" | "branch";
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  currentQty: number;
}

const REASONS: Array<{ value: string; label: string }> = [
  { value: "physical_recount", label: "Physical recount" },
  { value: "damaged", label: "Damaged" },
  { value: "spoilage", label: "Spoilage" },
  { value: "theft", label: "Theft / loss" },
  { value: "found", label: "Found extra" },
  { value: "opening_balance", label: "Opening balance" },
  { value: "other_with_note", label: "Other (specify)" },
];

export function InventoryPage(): JSX.Element {
  const user = useAuthUser();
  const isOwner = user.role === "owner";

  const [branchStock, setBranchStock] = useState<BranchStockRow[]>([]);
  const [factoryStock, setFactoryStock] = useState<Record<string, Record<string, number>>>({});
  const [products, setProducts] = useState<Product[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [factories, setFactories] = useState<Factory[]>([]);
  const [view, setView] = useState<"branch" | "factory">("branch");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<AdjustTarget | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

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

  async function runAdjust(payload: {
    newQuantity: number;
    reasonCode: string;
    reasonNote: string;
  }): Promise<void> {
    if (!adjustTarget) return;
    await api(`/inventory/adjust`, {
      method: "POST",
      body: JSON.stringify({
        location_type: adjustTarget.locationType,
        location_id: adjustTarget.locationId,
        reason_code: payload.reasonCode,
        reason_note: payload.reasonNote || undefined,
        items: [
          {
            product_id: adjustTarget.productId,
            new_quantity: payload.newQuantity,
          },
        ],
      }),
    });
    if (adjustTarget.locationType === "factory") {
      setFactoryStock((s) => ({
        ...s,
        [adjustTarget.locationId]: {
          ...(s[adjustTarget.locationId] ?? {}),
          [adjustTarget.productId]: payload.newQuantity,
        },
      }));
    } else {
      setBranchStock((rows) => {
        const targetExists = rows.some(
          (r) => r.branch_id === adjustTarget.locationId && r.product_id === adjustTarget.productId,
        );
        if (targetExists) {
          return rows.map((r) =>
            r.branch_id === adjustTarget.locationId && r.product_id === adjustTarget.productId
              ? { ...r, balance: payload.newQuantity }
              : r,
          );
        }
        return [
          ...rows,
          {
            branch_id: adjustTarget.locationId,
            product_id: adjustTarget.productId,
            balance: payload.newQuantity,
          },
        ];
      });
    }
    setFlash("Adjustment recorded");
    setAdjustTarget(null);
    setTimeout(() => setFlash(null), 2500);
  }

  function openAdjust(target: AdjustTarget): void {
    if (!isOwner) return;
    setAdjustTarget(target);
  }

  function renderCell(
    locationType: "factory" | "branch",
    locationId: string,
    locationName: string,
    productId: string,
    productName: string,
    qty: number,
    key: string,
  ): JSX.Element {
    const baseStyle = {
      fontWeight: 700 as const,
      color: cellTone(qty),
      background: cellBg(qty),
    };
    return (
      <td
        key={key}
        className="table__num"
        style={
          isOwner
            ? { ...baseStyle, cursor: "pointer" }
            : baseStyle
        }
        onClick={
          isOwner
            ? () =>
                openAdjust({
                  locationType,
                  locationId,
                  locationName,
                  productId,
                  productName,
                  currentQty: qty,
                })
            : undefined
        }
        title={isOwner ? "Click to adjust" : undefined}
      >
        {locationType === "factory" ? qty.toLocaleString() : qty}
      </td>
    );
  }

  return (
    <Shell
      title="Inventory"
      crumb="Owner"
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
          {isOwner && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setBulkOpen(true)}
              style={{ marginLeft: 6 }}
            >
              Bulk adjust
            </button>
          )}
        </div>
      }
    >
      <div className="page-head ed-rise">
        <div className="page-head__titles">
          <div className="page-head__eyebrow">Stock</div>
          <h1 className="page-head__title">Inventory</h1>
          <p className="page-head__sub">On-hand stock across branches and the factory.</p>
        </div>
      </div>

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
                      {cells.map((q, idx) =>
                        renderCell(
                          "branch",
                          branches[idx]!.id,
                          branches[idx]!.name,
                          p.id,
                          p.name,
                          q,
                          branches[idx]!.id,
                        ),
                      )}
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
                    {cells.map((q, idx) =>
                      renderCell(
                        "factory",
                        factories[idx]!.id,
                        factories[idx]!.name,
                        p.id,
                        p.name,
                        q,
                        factories[idx]!.id,
                      ),
                    )}
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
        {isOwner && " Click any cell to adjust the on-hand for that product at that location."}
      </p>

      {flash && (
        <div
          className="card"
          style={{
            borderColor: "rgba(16,185,129,0.35)",
            color: "var(--success)",
            position: "fixed",
            bottom: 20,
            right: 20,
            zIndex: 60,
          }}
        >
          {flash}
        </div>
      )}

      {adjustTarget && (
        <AdjustModal
          target={adjustTarget}
          onClose={() => setAdjustTarget(null)}
          onSubmit={runAdjust}
        />
      )}

      {bulkOpen && (
        <BulkAdjustModal
          factories={factories}
          branches={branches}
          products={products}
          factoryStock={factoryStock}
          branchHeat={branchHeat}
          onClose={() => setBulkOpen(false)}
          onSaved={async (locType, locId, items) => {
            // Apply locally so the heatmap updates without a refetch.
            if (locType === "factory") {
              setFactoryStock((s) => {
                const next = { ...(s[locId] ?? {}) };
                for (const it of items) next[it.productId] = it.newQty;
                return { ...s, [locId]: next };
              });
            } else {
              setBranchStock((rows) => {
                const map = new Map(rows.map((r) => [`${r.branch_id}|${r.product_id}`, r]));
                for (const it of items) {
                  const key = `${locId}|${it.productId}`;
                  const existing = map.get(key);
                  if (existing) existing.balance = it.newQty;
                  else map.set(key, { branch_id: locId, product_id: it.productId, balance: it.newQty });
                }
                return Array.from(map.values());
              });
            }
            setBulkOpen(false);
            setFlash(`Bulk adjustment recorded · ${items.length} line${items.length === 1 ? "" : "s"}`);
            setTimeout(() => setFlash(null), 3000);
          }}
        />
      )}
    </Shell>
  );
}

function BulkAdjustModal({
  factories,
  branches,
  products,
  factoryStock,
  branchHeat,
  onClose,
  onSaved,
}: {
  factories: Factory[];
  branches: Branch[];
  products: Product[];
  factoryStock: Record<string, Record<string, number>>;
  branchHeat: Map<string, number>;
  onClose: () => void;
  onSaved: (
    locType: "factory" | "branch",
    locId: string,
    items: Array<{ productId: string; newQty: number }>,
  ) => Promise<void>;
}): JSX.Element {
  const [locType, setLocType] = useState<"factory" | "branch">("factory");
  const [locId, setLocId] = useState<string>(
    factories[0]?.id ?? branches[0]?.id ?? "",
  );
  const [reasonCode, setReasonCode] = useState<string>("physical_recount");
  const [reasonNote, setReasonNote] = useState<string>("");
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset target when type flips.
  useEffect(() => {
    if (locType === "factory") setLocId(factories[0]?.id ?? "");
    else setLocId(branches[0]?.id ?? "");
    setOverrides({});
  }, [locType, factories, branches]);

  function currentQty(productId: string): number {
    if (locType === "factory") return factoryStock[locId]?.[productId] ?? 0;
    return branchHeat.get(`${locId}|${productId}`) ?? 0;
  }

  const locName =
    locType === "factory"
      ? factories.find((f) => f.id === locId)?.name ?? ""
      : branches.find((b) => b.id === locId)?.name ?? "";

  async function handleSubmit(): Promise<void> {
    if (!locId) {
      setError("Pick a location");
      return;
    }
    if (reasonCode === "other_with_note" && reasonNote.trim().length === 0) {
      setError("Add a note for 'Other'");
      return;
    }
    const items: Array<{ productId: string; newQty: number }> = [];
    for (const p of products) {
      const newQ = overrides[p.id];
      if (newQ === undefined) continue;
      if (newQ === currentQty(p.id)) continue;
      if (newQ < 0) {
        setError(`Quantity for ${p.name} can't be negative`);
        return;
      }
      items.push({ productId: p.id, newQty: newQ });
    }
    if (items.length === 0) {
      setError("Nothing changed — adjust at least one row");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api(`/inventory/adjust`, {
        method: "POST",
        body: JSON.stringify({
          location_type: locType,
          location_id: locId,
          reason_code: reasonCode,
          reason_note: reasonNote.trim() || undefined,
          items: items.map((i) => ({ product_id: i.productId, new_quantity: i.newQty })),
        }),
      });
      await onSaved(locType, locId, items);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20,24,31,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: 720,
          maxHeight: "90vh",
          overflow: "auto",
          background: "var(--shell)",
          boxShadow: "var(--shadow-float)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={{ marginBottom: 14 }}>
          <h2 className="t-h2">Bulk adjust</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: "4px 0 0" }}>
            Type the new on-hand for each row that changed. Unchanged rows are skipped.
          </p>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
          <div className="field">
            <label className="field__label" htmlFor="bulk-loc-type">Location type</label>
            <select
              id="bulk-loc-type"
              className="select"
              value={locType}
              onChange={(e) => setLocType(e.target.value as "factory" | "branch")}
            >
              <option value="factory">Factory</option>
              <option value="branch">Branch</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="bulk-loc-id">Location</label>
            <select
              id="bulk-loc-id"
              className="select"
              value={locId}
              onChange={(e) => setLocId(e.target.value)}
            >
              {(locType === "factory" ? factories : branches).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="bulk-reason">Reason (applies to all)</label>
            <select
              id="bulk-reason"
              className="select"
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
            >
              <option value="physical_recount">Physical recount</option>
              <option value="damaged">Damaged</option>
              <option value="spoilage">Spoilage</option>
              <option value="theft">Theft / loss</option>
              <option value="found">Found extra</option>
              <option value="opening_balance">Opening balance</option>
              <option value="other_with_note">Other (specify)</option>
            </select>
          </div>
        </div>

        {reasonCode === "other_with_note" && (
          <div className="field" style={{ marginBottom: 14 }}>
            <label className="field__label" htmlFor="bulk-note">Notes</label>
            <textarea
              id="bulk-note"
              className="textarea"
              rows={2}
              value={reasonNote}
              onChange={(e) => setReasonNote(e.target.value)}
              placeholder="Describe what happened"
            />
          </div>
        )}

        <div className="table-wrap" style={{ marginBottom: 14 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="table__num">Current</th>
                <th className="table__num">New on-hand</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const cur = currentQty(p.id);
                const newQ = overrides[p.id] ?? cur;
                const changed = newQ !== cur;
                return (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className="table__num" style={{ color: "var(--ink-soft)" }}>{cur}</td>
                    <td className="table__num">
                      <input
                        className="input"
                        type="number"
                        min={0}
                        value={newQ}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setOverrides((o) => ({ ...o, [p.id]: Number.isFinite(v) ? v : 0 }));
                        }}
                        style={{
                          width: 100,
                          textAlign: "right",
                          fontWeight: changed ? 700 : 400,
                          color: changed ? "var(--accent)" : "var(--ink)",
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {error && (
          <div className="field__error" style={{ marginBottom: 10 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn--subtle" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? "Submitting…" : `Adjust ${locName || ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function AdjustModal({
  target,
  onClose,
  onSubmit,
}: {
  target: AdjustTarget;
  onClose: () => void;
  onSubmit: (p: { newQuantity: number; reasonCode: string; reasonNote: string }) => Promise<void>;
}): JSX.Element {
  const [newQty, setNewQty] = useState<number>(target.currentQty);
  const [reasonCode, setReasonCode] = useState<string>("physical_recount");
  const [reasonNote, setReasonNote] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (reasonCode === "other_with_note" && reasonNote.trim().length === 0) {
      setError("Add a note for 'Other'");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ newQuantity: Number(newQty), reasonCode, reasonNote });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/would_go_negative|stock would go negative/i.test(msg)) {
        setError(
          `Can't go below 0 — ${target.locationName} currently shows ${target.currentQty}.`,
        );
      } else {
        setError(msg);
      }
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20,24,31,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: 460,
          background: "var(--shell)",
          boxShadow: "var(--shadow-float)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={{ marginBottom: 14 }}>
          <h2 className="t-h2">Adjust {target.productName}</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: "4px 0 0" }}>
            at {target.locationName}
          </p>
        </header>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="field">
            <label className="field__label">Currently</label>
            <div style={{ fontSize: 14, color: "var(--ink-soft)" }}>{target.currentQty} bottles</div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="new-on-hand">
              New on-hand
            </label>
            <input
              id="new-on-hand"
              className="input"
              type="number"
              min={0}
              autoFocus
              value={newQty}
              onChange={(e) => setNewQty(Number(e.target.value))}
              style={{ textAlign: "right" }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="adjust-reason">
              Reason
            </label>
            <select
              id="adjust-reason"
              className="select"
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          {reasonCode === "other_with_note" && (
            <div className="field">
              <label className="field__label" htmlFor="adjust-note">
                Notes
              </label>
              <textarea
                id="adjust-note"
                className="textarea"
                rows={2}
                value={reasonNote}
                onChange={(e) => setReasonNote(e.target.value)}
                placeholder="Describe what happened"
              />
            </div>
          )}

          {error && (
            <div className="field__error" style={{ marginTop: 4 }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button type="button" className="btn btn--subtle" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? "Submitting…" : "Submit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

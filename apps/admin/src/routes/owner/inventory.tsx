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
    </Shell>
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

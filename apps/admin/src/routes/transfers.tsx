import { useEffect, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../components/Shell.js";
import { api } from "../lib/api.js";
import { formatDateTime } from "../lib/format.js";
import { InlineLoader } from "../components/Spinner.js";

type TransferStatus =
  | "dispatched"
  | "in_transit"
  | "arrived"
  | "received"
  | "received_with_variance"
  | "rejected"
  | "completed"
  | "cancelled";

interface Transfer {
  id: string;
  transferNumber: string;
  factoryId: string;
  branchId: string;
  status: TransferStatus;
  vehicleInfo: string | null;
  driverName: string | null;
  createdAt: string;
  dispatchedAt: string | null;
  receivedAt: string | null;
}
interface Factory {
  id: string;
  name: string;
}
interface Branch {
  id: string;
  name: string;
}
interface Product {
  id: string;
  name: string;
}

interface BagMaterial {
  id: string;
  name: string;
  kind: string;
}

// One per-size on-hand row at the source factory.
interface FactoryStockRow {
  product_id: string;
  variant_id: string | null;
  size_ml: number | null;
  balance: number;
}

// A draft line is EITHER a product (juice) OR a bag (packaging material). The
// `kind` discriminates which fields are meaningful.
interface DraftItem {
  kind: "product" | "bag";
  product_id: string;
  variant_id: string;
  packaging_material_id: string;
  quantity_sent: number;
  unit_cost_ngn: number;
}

const sizeLabel = (ml: number | null): string => (ml ? `${ml}ml` : "No size");

function statusPill(s: TransferStatus): JSX.Element {
  const map: Record<TransferStatus, [string, string]> = {
    dispatched: ["pill pill--accent", "Dispatched"],
    in_transit: ["pill pill--accent", "In transit"],
    arrived: ["pill pill--warning", "Arrived"],
    received: ["pill pill--success", "Received"],
    received_with_variance: ["pill pill--warning", "Variance"],
    rejected: ["pill pill--danger", "Rejected"],
    completed: ["pill pill--success", "Completed"],
    cancelled: ["pill pill--ink", "Cancelled"],
  };
  const [cls, label] = map[s];
  return <span className={cls}>{label}</span>;
}

export function TransfersPage(): JSX.Element {
  const [rows, setRows] = useState<Transfer[]>([]);
  const [factories, setFactories] = useState<Factory[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [bags, setBags] = useState<BagMaterial[]>([]);
  const [filter, setFilter] = useState<TransferStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const qs = filter ? `?status=${filter}` : "";
      const [t, f, b, p, bag] = await Promise.all([
        api<{ data: Transfer[] }>(`/transfers${qs}`),
        api<{ data: Factory[] }>(`/factories`),
        api<{ data: Branch[] }>(`/branches`),
        api<{ data: Product[] }>(`/products`),
        api<{ data: BagMaterial[] }>(`/packaging/materials?kind=bag`),
      ]);
      setRows(t.data);
      setFactories(f.data);
      setBranches(b.data);
      setProducts(p.data);
      setBags(bag.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const factoryName = (id: string): string =>
    factories.find((f) => f.id === id)?.name ?? id.slice(0, 8);
  const branchName = (id: string): string =>
    branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  return (
    <Shell
      title="Transfers"
      actions={
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            className="select"
            style={{ width: 180, height: 36 }}
            value={filter}
            onChange={(e) => setFilter(e.target.value as TransferStatus | "")}
          >
            <option value="">All statuses</option>
            <option value="dispatched">Dispatched</option>
            <option value="arrived">Arrived</option>
            <option value="received_with_variance">Variance</option>
            <option value="completed">Completed</option>
            <option value="rejected">Rejected</option>
          </select>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowCreate(true)}>
            + Send transfer
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
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No transfers in view</div>
          Adjust the status filter or create a new transfer.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Factory → Branch</th>
                <th>Status</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link
                      to="/transfers/$transferId"
                      params={{ transferId: t.id }}
                      style={{ fontWeight: 600, color: "var(--ink)" }}
                    >
                      {t.transferNumber}
                    </Link>
                  </td>
                  <td>
                    <span>{factoryName(t.factoryId)}</span>
                    <span style={{ color: "var(--ink-soft)" }}> → </span>
                    <span>{branchName(t.branchId)}</span>
                  </td>
                  <td>{statusPill(t.status)}</td>
                  <td>{formatDateTime(t.createdAt)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <Link
                      to="/transfers/$transferId"
                      params={{ transferId: t.id }}
                      className="btn btn--subtle btn--sm"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateTransferModal
          factories={factories}
          branches={branches}
          products={products}
          bags={bags}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            void load();
          }}
        />
      )}
    </Shell>
  );
}

function CreateTransferModal({
  factories,
  branches,
  products,
  bags,
  onClose,
  onSaved,
}: {
  factories: Factory[];
  branches: Branch[];
  products: Product[];
  bags: BagMaterial[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [factoryId, setFactoryId] = useState(factories[0]?.id ?? "");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [vehicle, setVehicle] = useState("");
  const [driver, setDriver] = useState("");
  const [items, setItems] = useState<DraftItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-size on-hand at the selected factory. The picker only offers what's
  // actually in stock here, so you can't dispatch a flavour/size the factory
  // doesn't hold.
  const [stock, setStock] = useState<FactoryStockRow[]>([]);
  const [stockLoading, setStockLoading] = useState(false);

  // Reload the source factory's stock whenever it changes, and clear any
  // already-added lines (they referenced the previous factory's inventory).
  useEffect(() => {
    if (!factoryId) {
      setStock([]);
      return;
    }
    let cancelled = false;
    setStockLoading(true);
    setItems([]);
    void (async () => {
      try {
        const res = await api<{ data: FactoryStockRow[] }>(`/stock/factory/${factoryId}`);
        if (!cancelled) setStock(res.data.filter((s) => s.balance > 0));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setStockLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [factoryId]);

  // Sizes-with-stock for one flavour, sorted by size.
  const availableSizes = (productId: string): FactoryStockRow[] =>
    stock
      .filter((s) => s.product_id === productId)
      .sort((a, b) => (a.size_ml ?? 0) - (b.size_ml ?? 0));
  // Flavours that have any size in stock at this factory.
  const availableProducts = products.filter((p) => availableSizes(p.id).length > 0);
  const availableFor = (productId: string, variantId: string): number =>
    stock.find((s) => s.product_id === productId && (s.variant_id ?? "") === variantId)?.balance ?? 0;

  function addItem(): void {
    const next = availableProducts[0];
    if (!next) return;
    const first = availableSizes(next.id)[0];
    if (!first) return;
    setItems((it) => [
      ...it,
      {
        kind: "product",
        product_id: next.id,
        variant_id: first.variant_id ?? "",
        packaging_material_id: "",
        quantity_sent: Math.min(50, first.balance),
        unit_cost_ngn: 0,
      },
    ]);
  }
  function addBag(): void {
    const first = bags[0];
    if (!first) return;
    setItems((it) => [
      ...it,
      { kind: "bag", product_id: "", variant_id: "", packaging_material_id: first.id, quantity_sent: 50, unit_cost_ngn: 0 },
    ]);
  }
  function updateItem(idx: number, patch: Partial<DraftItem>): void {
    setItems((it) => it.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }
  function removeItem(idx: number): void {
    setItems((it) => it.filter((_, i) => i !== idx));
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (items.length === 0 || !factoryId || !branchId) return;
    const overSent = items.find(
      (it) => it.kind === "product" && it.quantity_sent > availableFor(it.product_id, it.variant_id),
    );
    if (overSent) {
      const pName = products.find((p) => p.id === overSent.product_id)?.name ?? "flavour";
      setError(`Only ${availableFor(overSent.product_id, overSent.variant_id)} of ${pName} in stock at this factory.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api(`/transfers`, {
        method: "POST",
        body: JSON.stringify({
          factory_id: factoryId,
          branch_id: branchId,
          vehicle_info: vehicle || undefined,
          driver_name: driver || undefined,
          items: items.map((it) =>
            it.kind === "bag"
              ? {
                  packaging_material_id: it.packaging_material_id,
                  quantity_sent: Number(it.quantity_sent),
                  unit_cost_ngn: it.unit_cost_ngn ? Number(it.unit_cost_ngn) : undefined,
                }
              : {
                  product_id: it.product_id,
                  variant_id: it.variant_id || undefined,
                  quantity_sent: Number(it.quantity_sent),
                  unit_cost_ngn: it.unit_cost_ngn ? Number(it.unit_cost_ngn) : undefined,
                },
          ),
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        style={{ width: "100%", maxWidth: 640, maxHeight: "calc(100vh - 32px)", overflow: "auto", boxShadow: "var(--shadow-float)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
          <h2 className="t-h2">Send transfer</h2>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: 0, fontSize: 22, cursor: "pointer", color: "var(--ink-soft)" }}
          >
            ×
          </button>
        </header>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field">
              <label className="field__label">Factory</label>
              <select className="select" value={factoryId} onChange={(e) => setFactoryId(e.target.value)}>
                {factories.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field__label">Branch</label>
              <select className="select" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field">
              <label className="field__label">Vehicle</label>
              <input
                className="input"
                value={vehicle}
                onChange={(e) => setVehicle(e.target.value)}
                placeholder="optional"
              />
            </div>
            <div className="field">
              <label className="field__label">Driver</label>
              <input
                className="input"
                value={driver}
                onChange={(e) => setDriver(e.target.value)}
                placeholder="optional"
              />
            </div>
          </div>

          <div className="field">
            <label className="field__label">Items</label>
            {items.length === 0 ? (
              <div className="empty" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
                {stockLoading ? (
                  <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>Loading stock…</span>
                ) : availableProducts.length === 0 && bags.length === 0 ? (
                  <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                    This factory has no stock to transfer.
                  </span>
                ) : (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      onClick={addItem}
                      disabled={availableProducts.length === 0}
                    >
                      + Add product
                    </button>
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      onClick={addBag}
                      disabled={bags.length === 0}
                    >
                      + Add bag
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Size</th>
                      <th className="table__num">Quantity</th>
                      <th className="table__num">Unit cost (₦)</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={idx}>
                        <td>
                          {it.kind === "bag" ? (
                            <select
                              className="select"
                              value={it.packaging_material_id}
                              onChange={(e) => updateItem(idx, { packaging_material_id: e.target.value })}
                            >
                              {bags.map((bag) => (
                                <option key={bag.id} value={bag.id}>
                                  🛍 {bag.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <select
                              className="select"
                              value={it.product_id}
                              onChange={(e) => {
                                const pid = e.target.value;
                                const first = availableSizes(pid)[0];
                                updateItem(idx, {
                                  product_id: pid,
                                  variant_id: first?.variant_id ?? "",
                                  quantity_sent: first ? Math.min(it.quantity_sent || 50, first.balance) : it.quantity_sent,
                                });
                              }}
                            >
                              {availableProducts.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td>
                          {it.kind === "bag" ? (
                            <span style={{ color: "var(--ink-soft)" }}>Bag</span>
                          ) : (
                            <select
                              className="select"
                              value={it.variant_id}
                              onChange={(e) => {
                                const vid = e.target.value;
                                const avail = availableFor(it.product_id, vid);
                                updateItem(idx, {
                                  variant_id: vid,
                                  quantity_sent: Math.min(it.quantity_sent || 50, avail),
                                });
                              }}
                            >
                              {availableSizes(it.product_id).map((s) => (
                                <option key={s.variant_id ?? "null"} value={s.variant_id ?? ""}>
                                  {sizeLabel(s.size_ml)} · {s.balance} in stock
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            min={1}
                            max={it.kind === "product" ? availableFor(it.product_id, it.variant_id) : undefined}
                            style={{
                              textAlign: "right",
                              ...(it.kind === "product" &&
                              it.quantity_sent > availableFor(it.product_id, it.variant_id)
                                ? { borderColor: "var(--danger)", color: "var(--danger)" }
                                : {}),
                            }}
                            value={it.quantity_sent}
                            onChange={(e) =>
                              updateItem(idx, { quantity_sent: Number(e.target.value) })
                            }
                          />
                          {it.kind === "product" && (
                            <div style={{ fontSize: 11, color: "var(--ink-soft)", textAlign: "right", marginTop: 2 }}>
                              {availableFor(it.product_id, it.variant_id)} available
                            </div>
                          )}
                        </td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            style={{ textAlign: "right" }}
                            value={it.unit_cost_ngn}
                            onChange={(e) =>
                              updateItem(idx, { unit_cost_ngn: Number(e.target.value) })
                            }
                          />
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            type="button"
                            onClick={() => removeItem(idx)}
                            style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--ink-soft)", fontSize: 18 }}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ padding: 10, borderTop: "1px solid var(--line)", display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn--subtle btn--sm"
                    onClick={addItem}
                    disabled={availableProducts.length === 0}
                  >
                    + Add product
                  </button>
                  <button
                    type="button"
                    className="btn btn--subtle btn--sm"
                    onClick={addBag}
                    disabled={bags.length === 0}
                  >
                    + Add bag
                  </button>
                </div>
              </div>
            )}
          </div>

          {error && <div className="field__error">{error}</div>}
          <button type="submit" className="btn btn--primary btn--block" disabled={submitting || items.length === 0}>
            {submitting ? "Sending…" : "Send transfer"}
          </button>
        </form>
      </div>
    </div>
  );
}

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

interface DraftItem {
  product_id: string;
  quantity_sent: number;
  unit_cost_ngn: number;
}

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
  const [filter, setFilter] = useState<TransferStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const qs = filter ? `?status=${filter}` : "";
      const [t, f, b, p] = await Promise.all([
        api<{ data: Transfer[] }>(`/transfers${qs}`),
        api<{ data: Factory[] }>(`/factories`),
        api<{ data: Branch[] }>(`/branches`),
        api<{ data: Product[] }>(`/products`),
      ]);
      setRows(t.data);
      setFactories(f.data);
      setBranches(b.data);
      setProducts(p.data);
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
  onClose,
  onSaved,
}: {
  factories: Factory[];
  branches: Branch[];
  products: Product[];
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

  function addItem(): void {
    const used = new Set(items.map((i) => i.product_id));
    const next = products.find((p) => !used.has(p.id));
    if (!next) return;
    setItems((it) => [...it, { product_id: next.id, quantity_sent: 50, unit_cost_ngn: 0 }]);
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
          items: items.map((it) => ({
            product_id: it.product_id,
            quantity_sent: Number(it.quantity_sent),
            unit_cost_ngn: it.unit_cost_ngn ? Number(it.unit_cost_ngn) : undefined,
          })),
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
        style={{ width: "100%", maxWidth: 640, boxShadow: "var(--shadow-float)" }}
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
              <div className="empty" style={{ padding: 18 }}>
                <button type="button" className="btn btn--subtle btn--sm" onClick={addItem}>
                  + Add product
                </button>
              </div>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="table__num">Quantity</th>
                      <th className="table__num">Unit cost (₦)</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={idx}>
                        <td>
                          <select
                            className="select"
                            value={it.product_id}
                            onChange={(e) => updateItem(idx, { product_id: e.target.value })}
                          >
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            style={{ textAlign: "right" }}
                            value={it.quantity_sent}
                            onChange={(e) =>
                              updateItem(idx, { quantity_sent: Number(e.target.value) })
                            }
                          />
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
                <div style={{ padding: 10, borderTop: "1px solid var(--line)" }}>
                  <button
                    type="button"
                    className="btn btn--subtle btn--sm"
                    onClick={addItem}
                    disabled={items.length >= products.length}
                  >
                    + Add product
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

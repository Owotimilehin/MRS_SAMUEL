import { useEffect, useState } from "react";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import { api, humanizeError } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import type { StatChip } from "../../components/StatHero.js";

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
  status: TransferStatus;
  driverName: string | null;
  vehicleInfo: string | null;
  createdAt: string;
  dispatchedAt: string | null;
}
// NOTE: the detail endpoint (GET /transfers/:id) returns item fields in
// snake_case (product_id, quantity_sent, …) — unlike the list endpoint's
// camelCase Transfer rows. Mirror the wire shape exactly.
interface TransferItem {
  id: string;
  product_id: string;
  variant_id?: string | null;
  size_ml?: number | null;
  material_name?: string | null;
  quantity_sent: number;
  quantity_received: number | null;
  variance_reason: string | null;
}
interface Product {
  id: string;
  name: string;
}

const VARIANCE_REASONS = [
  { value: "short_shipped", label: "Short shipped" },
  { value: "damaged_in_transit", label: "Damaged in transit" },
  { value: "wrong_item", label: "Wrong item" },
  { value: "extra_received", label: "Extra received" },
  { value: "count_error_at_branch", label: "Count error" },
  { value: "other_with_note", label: "Other" },
];

function statusPill(s: TransferStatus): JSX.Element {
  if (s === "completed" || s === "received") return <span className="pill pill--success">{s}</span>;
  if (s === "arrived" || s === "dispatched" || s === "in_transit")
    return <span className="pill pill--warning">{s}</span>;
  if (s === "received_with_variance") return <span className="pill pill--warning">Variance</span>;
  if (s === "rejected") return <span className="pill pill--danger">Rejected</span>;
  return <span className="pill">{s}</span>;
}

export function BranchTransfersPage({ branchId }: { branchId: string }): JSX.Element {
  const [rows, setRows] = useState<Transfer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    transfer: Transfer;
    items: TransferItem[];
  } | null>(null);
  const [acting, setActing] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [t, p] = await Promise.all([
        api<{ data: Transfer[] }>(`/transfers?branch_id=${branchId}`),
        api<{ data: Product[] }>(`/products`),
      ]);
      setRows(t.data);
      setProducts(p.data);
      setError(null);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  async function openDetail(t: Transfer): Promise<void> {
    try {
      const res = await api<{ data: Transfer & { items: TransferItem[] } }>(
        `/transfers/${t.id}`,
      );
      setSelected({ transfer: res.data, items: res.data.items });
    } catch (err) {
      setError(humanizeError(err));
    }
  }

  async function markArrived(id: string): Promise<void> {
    setActing(true);
    try {
      await api(`/transfers/${id}/arrive`, { method: "PATCH" });
      setSelected(null);
      await load();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setActing(false);
    }
  }

  const productName = (id: string | null | undefined): string =>
    id ? (products.find((p) => p.id === id)?.name ?? id.slice(0, 8)) : "—";

  const toReceive = rows.filter(
    (r) => r.status === "dispatched" || r.status === "in_transit" || r.status === "arrived",
  ).length;
  const received = rows.filter(
    (r) => r.status === "received" || r.status === "received_with_variance" || r.status === "completed",
  ).length;

  const transferChips: StatChip[] = [
    { label: "Incoming", value: rows.length },
  ];
  if (toReceive > 0) {
    transferChips.push({ label: "To receive", value: toReceive, tone: "warn" });
  } else {
    transferChips.push({ label: "To receive", value: toReceive, tone: "good" });
  }
  transferChips.push({ label: "Received", value: received });

  return (
    <BranchShell branchId={branchId} title="Incoming transfers">
      <StatHero
        eyebrow="Branch"
        title="Transfers"
        sub="Shipments dispatched from the factory to this branch."
        loading={loading}
        chips={transferChips}
      />

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
          <div className="empty__title">No incoming transfers</div>
          New shipments from the factory will appear here.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Driver</th>
                <th>Vehicle</th>
                <th>Status</th>
                <th>Dispatched</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 600 }}>{t.transferNumber}</td>
                  <td>{t.driverName ?? "—"}</td>
                  <td style={{ color: "var(--ink-soft)" }}>{t.vehicleInfo ?? "—"}</td>
                  <td>{statusPill(t.status)}</td>
                  <td>{t.dispatchedAt ? formatDateTime(t.dispatchedAt) : "—"}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {t.status === "dispatched" || t.status === "in_transit" ? (
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={acting}
                        onClick={() => void markArrived(t.id)}
                      >
                        Mark arrived
                      </button>
                    ) : t.status === "arrived" ? (
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => void openDetail(t)}
                      >
                        Receive
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--subtle btn--sm"
                        onClick={() => void openDetail(t)}
                      >
                        Open
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ReceiveModal
          transfer={selected.transfer}
          items={selected.items}
          productName={productName}
          onClose={() => setSelected(null)}
          onReceived={async () => {
            setSelected(null);
            await load();
          }}
        />
      )}
    </BranchShell>
  );
}

function ReceiveModal({
  transfer,
  items,
  productName,
  onClose,
  onReceived,
}: {
  transfer: Transfer;
  items: TransferItem[];
  productName: (id: string) => string;
  onClose: () => void;
  onReceived: () => Promise<void>;
}): JSX.Element {
  const editable = transfer.status === "arrived";
  const [draft, setDraft] = useState(() =>
    items.map((i) => ({
      item_id: i.id,
      quantity_received: i.quantity_received ?? i.quantity_sent,
      variance_reason: i.variance_reason ?? "",
      variance_note: "",
      notes: "",
      sent: i.quantity_sent,
    })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const missingReason = draft.find(
        (d) => d.quantity_received !== d.sent && !d.variance_reason,
      );
      if (missingReason) {
        throw new Error("Pick a variance reason for every line that doesn't match");
      }
      const missingNote = draft.find(
        (d) =>
          d.quantity_received !== d.sent &&
          d.variance_reason === "other_with_note" &&
          !d.variance_note.trim(),
      );
      if (missingNote) {
        throw new Error("Add a note for every line marked 'Other'");
      }
      await api(`/transfers/${transfer.id}/receive`, {
        method: "PATCH",
        body: JSON.stringify({
          items: draft.map((d) => ({
            item_id: d.item_id,
            quantity_received: Number(d.quantity_received),
            variance_reason:
              d.quantity_received === d.sent ? undefined : d.variance_reason,
            variance_note:
              d.quantity_received !== d.sent && d.variance_reason === "other_with_note"
                ? d.variance_note.trim()
                : undefined,
            notes: d.notes || undefined,
          })),
        }),
      });
      await onReceived();
    } catch (err) {
      setError(humanizeError(err));
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
          maxWidth: 700,
          maxHeight: "calc(100vh - 32px)",
          overflow: "auto",
          boxShadow: "var(--shadow-float)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}
        >
          <div>
            <h2 className="t-h2">Receive {transfer.transferNumber}</h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: "4px 0 0" }}>
              Count each line. Picking a different number requires a variance reason.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: 0, fontSize: 22, cursor: "pointer", color: "var(--ink-soft)" }}
          >
            ×
          </button>
        </header>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="table__num">Sent</th>
                <th className="table__num">Received</th>
                <th>Variance reason</th>
              </tr>
            </thead>
            <tbody>
              {draft.map((d, idx) => {
                const variance = d.quantity_received !== d.sent;
                return (
                  <tr key={d.item_id}>
                    <td>
                      {items[idx]?.material_name
                        ? `🛍 ${items[idx]!.material_name}`
                        : productName(items[idx]?.product_id ?? "")}
                      {items[idx]?.size_ml != null && (
                        <span style={{ color: "var(--ink-soft)", fontSize: 12, marginLeft: 4 }}>
                          · {items[idx]!.size_ml}ml
                        </span>
                      )}
                    </td>
                    <td className="table__num">{d.sent}</td>
                    <td>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        style={{ width: 90, textAlign: "right" }}
                        value={d.quantity_received}
                        disabled={!editable}
                        onChange={(e) =>
                          setDraft((s) =>
                            s.map((row, i) =>
                              i === idx ? { ...row, quantity_received: Number(e.target.value) } : row,
                            ),
                          )
                        }
                      />
                    </td>
                    <td>
                      {variance ? (
                        <>
                          <select
                            className="select"
                            value={d.variance_reason}
                            disabled={!editable}
                            onChange={(e) =>
                              setDraft((s) =>
                                s.map((row, i) =>
                                  i === idx ? { ...row, variance_reason: e.target.value } : row,
                                ),
                              )
                            }
                          >
                            <option value="">Pick a reason…</option>
                            {VARIANCE_REASONS.map((r) => (
                              <option key={r.value} value={r.value}>
                                {r.label}
                              </option>
                            ))}
                          </select>
                          {d.variance_reason === "other_with_note" && (
                            <textarea
                              className="textarea"
                              rows={2}
                              placeholder="Describe what happened (required)"
                              value={d.variance_note}
                              disabled={!editable}
                              style={{ marginTop: 6, width: "100%" }}
                              onChange={(e) =>
                                setDraft((s) =>
                                  s.map((row, i) =>
                                    i === idx ? { ...row, variance_note: e.target.value } : row,
                                  ),
                                )
                              }
                            />
                          )}
                        </>
                      ) : (
                        <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>matches</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {error && <div className="field__error" style={{ marginTop: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button type="button" className="btn btn--subtle" onClick={onClose}>
            Close
          </button>
          {editable && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={submitting}
              onClick={() => void submit()}
            >
              {submitting ? "Submitting…" : "Submit receipt"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

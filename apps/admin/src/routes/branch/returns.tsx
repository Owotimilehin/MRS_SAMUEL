import { useEffect, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { BranchShell } from "../../components/BranchShell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

interface ReturnRow {
  id: string;
  returnNumber: string;
  originalSaleOrderId: string;
  originalSaleOrderNumber: string | null;
  status: "draft" | "pending_approval" | "completed" | "cancelled";
  reasonCategory: string;
  refundMethod: string;
  refundAmountNgn: number;
  createdAt: string;
}
interface SaleDetail {
  id: string;
  orderNumber: string;
  channel: string;
  status: string;
  totalNgn: number;
  createdAtLocal: string;
  items: Array<{
    id: string;
    productId: string;
    quantity: number;
    unitPriceNgn: number;
    lineTotalNgn: number;
  }>;
}
interface Product {
  id: string;
  name: string;
}

const REASONS = [
  { value: "changed_mind", label: "Changed mind" },
  { value: "wrong_flavor", label: "Wrong flavor" },
  { value: "wrong_item", label: "Wrong item delivered" },
  { value: "quality_issue", label: "Quality issue" },
  { value: "damaged_on_arrival", label: "Damaged on arrival" },
  { value: "delivery_failed", label: "Delivery failed" },
  { value: "other_with_note", label: "Other" },
];
const REFUND_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "transfer", label: "Bank transfer" },
  { value: "card_reversal", label: "Card reversal" },
  { value: "store_credit", label: "Store credit" },
  { value: "replacement", label: "Replacement" },
  { value: "none", label: "No refund" },
];

function statusPill(s: ReturnRow["status"]): JSX.Element {
  if (s === "completed") return <span className="pill pill--success">Completed</span>;
  if (s === "pending_approval") return <span className="pill pill--warning">Awaiting owner</span>;
  if (s === "cancelled") return <span className="pill pill--ink">Cancelled</span>;
  return <span className="pill">{s}</span>;
}

export function BranchReturnsPage({ branchId }: { branchId: string }): JSX.Element {
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [r, p] = await Promise.all([
        api<{ data: ReturnRow[] }>(`/branches/${branchId}/returns`),
        api<{ data: Product[] }>(`/products`),
      ]);
      setRows(r.data);
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
  }, [branchId]);

  return (
    <BranchShell
      branchId={branchId}
      title="Returns"
      actions={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowCreate(true)}>
          + Record return
        </button>
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
          <div className="empty__title">No returns yet</div>
          Record a return when a customer brings a bottle back.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Original order</th>
                <th>Reason</th>
                <th>Refund</th>
                <th>Status</th>
                <th className="table__num">Amount</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link
                      to="/branch/returns/$returnId"
                      params={{ returnId: r.id }}
                      style={{ fontWeight: 600, color: "var(--ink)" }}
                    >
                      {r.returnNumber}
                    </Link>
                  </td>
                  <td style={{ fontWeight: 600 }}>
                    {r.originalSaleOrderNumber ?? "—"}
                  </td>
                  <td style={{ textTransform: "capitalize" }}>
                    {r.reasonCategory.replace(/_/g, " ")}
                  </td>
                  <td style={{ textTransform: "capitalize" }}>{r.refundMethod.replace(/_/g, " ")}</td>
                  <td>{statusPill(r.status)}</td>
                  <td className="table__num" style={{ fontWeight: 700 }}>
                    {ngn(r.refundAmountNgn)}
                  </td>
                  <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                    {formatDateTime(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateReturn
          branchId={branchId}
          products={products}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            void load();
          }}
        />
      )}
    </BranchShell>
  );
}

function CreateReturn({
  branchId,
  products,
  onClose,
  onSaved,
}: {
  branchId: string;
  products: Product[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [orderNumber, setOrderNumber] = useState("");
  const [sale, setSale] = useState<SaleDetail | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [reason, setReason] = useState("quality_issue");
  const [reasonNote, setReasonNote] = useState("");
  const [refundMethod, setRefundMethod] = useState("cash");
  const [lines, setLines] = useState<
    Record<string, { qty: number; disposition: "restocked" | "wasted" | "replaced" }>
  >({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const productName = (id: string): string => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  async function findSale(): Promise<void> {
    setSearching(true);
    setSearchErr(null);
    setSale(null);
    try {
      const list = await api<{ data: Array<{ id: string; orderNumber: string }> }>(
        `/branches/${branchId}/sales`,
      );
      const match = list.data.find(
        (s) => s.orderNumber === orderNumber || s.orderNumber === orderNumber.toUpperCase(),
      );
      if (!match) {
        setSearchErr("No order with that number found in this branch.");
        return;
      }
      const detail = await api<{ data: SaleDetail }>(
        `/branches/${branchId}/sales/${match.id}`,
      );
      setSale(detail.data);
      const init: typeof lines = {};
      for (const item of detail.data.items) {
        init[item.id] = { qty: 0, disposition: "restocked" };
      }
      setLines(init);
    } catch (err) {
      setSearchErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  function setLine(id: string, patch: Partial<{ qty: number; disposition: "restocked" | "wasted" | "replaced" }>): void {
    setLines((l) => ({ ...l, [id]: { ...l[id]!, ...patch } }));
  }

  const refundAmount = sale
    ? sale.items.reduce((sum, it) => sum + it.unitPriceNgn * (lines[it.id]?.qty ?? 0), 0)
    : 0;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!sale) return;
    const items = sale.items
      .filter((it) => (lines[it.id]?.qty ?? 0) > 0)
      .map((it) => ({
        sale_order_item_id: it.id,
        quantity_returned: lines[it.id]!.qty,
        disposition: lines[it.id]!.disposition,
      }));
    if (items.length === 0) {
      setError("Pick at least one line to return.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api(`/branches/${branchId}/returns`, {
        method: "POST",
        body: JSON.stringify({
          original_sale_order_id: sale.id,
          reason_category: reason,
          reason_note: reasonNote || undefined,
          refund_method: refundMethod,
          items,
          photo_urls: [],
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
        style={{
          width: "100%",
          maxWidth: 720,
          maxHeight: "calc(100vh - 32px)",
          overflow: "auto",
          boxShadow: "var(--shadow-float)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
          <h2 className="t-h2">Record return</h2>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: 0, fontSize: 22, cursor: "pointer", color: "var(--ink-soft)" }}
          >
            ×
          </button>
        </header>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="field">
            <label className="field__label">Original order number</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="input"
                placeholder="ORD-…"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value.trim())}
              />
              <button
                type="button"
                className="btn btn--subtle"
                onClick={() => void findSale()}
                disabled={!orderNumber || searching}
              >
                {searching ? "Looking…" : "Find"}
              </button>
            </div>
            {searchErr && <div className="field__error">{searchErr}</div>}
          </div>

          {sale && (
            <>
              <div className="card card--soft" style={{ padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontWeight: 700 }}>{sale.orderNumber}</span>
                  <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                    {formatDateTime(sale.createdAtLocal)} · {sale.channel}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                  Total {ngn(sale.totalNgn)} · {sale.items.length} lines
                </div>
              </div>

              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="table__num">Sold</th>
                      <th className="table__num">Return qty</th>
                      <th>Disposition</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sale.items.map((it) => (
                      <tr key={it.id}>
                        <td>{productName(it.productId)}</td>
                        <td className="table__num">{it.quantity}</td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            min={0}
                            max={it.quantity}
                            style={{ width: 80, textAlign: "right" }}
                            value={lines[it.id]?.qty ?? 0}
                            onChange={(e) => setLine(it.id, { qty: Number(e.target.value) })}
                          />
                        </td>
                        <td>
                          <select
                            className="select"
                            value={lines[it.id]?.disposition ?? "restocked"}
                            onChange={(e) =>
                              setLine(it.id, {
                                disposition: e.target.value as "restocked" | "wasted" | "replaced",
                              })
                            }
                          >
                            <option value="restocked">Restocked</option>
                            <option value="wasted">Wasted</option>
                            <option value="replaced">Replaced</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="field">
                  <label className="field__label">Reason</label>
                  <select className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
                    {REASONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field__label">Refund method</label>
                  <select
                    className="select"
                    value={refundMethod}
                    onChange={(e) => setRefundMethod(e.target.value)}
                  >
                    {REFUND_METHODS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {reason === "other_with_note" && (
                <div className="field">
                  <label className="field__label">Note</label>
                  <textarea
                    className="textarea"
                    rows={2}
                    value={reasonNote}
                    onChange={(e) => setReasonNote(e.target.value)}
                  />
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "10px 0",
                  borderTop: "1px solid var(--line)",
                }}
              >
                <span style={{ fontWeight: 600 }}>Refund amount</span>
                <span className="tabular-nums" style={{ fontWeight: 800, fontSize: 20 }}>
                  {ngn(refundAmount)}
                </span>
              </div>

              {error && <div className="field__error">{error}</div>}
              <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
                {submitting ? "Recording…" : `Record return · ${ngn(refundAmount)}`}
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}

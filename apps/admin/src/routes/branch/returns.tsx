import { useState } from "react";
import { BranchShell } from "../../components/BranchShell.js";
import { api, ApiError } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";

interface BranchReturnsPageProps {
  branchId: string;
}

interface SaleLine {
  id: string;
  productId: string;
  quantity: number;
  unitPriceNgn: number;
}
interface Sale {
  id: string;
  orderNumber: string;
  status: string;
  totalNgn: number;
  items: SaleLine[];
}

interface SelectedLine {
  qty: number;
  disposition: "restocked" | "wasted" | "replaced";
}

type Reason =
  | "changed_mind"
  | "wrong_flavor"
  | "wrong_item"
  | "quality_issue"
  | "damaged_on_arrival"
  | "delivery_failed"
  | "other_with_note";

type RefundMethod =
  | "cash"
  | "card_reversal"
  | "transfer"
  | "store_credit"
  | "replacement"
  | "glovo_external"
  | "chowdeck_external"
  | "none";

export function BranchReturnsPage({ branchId }: BranchReturnsPageProps): JSX.Element {
  const [orderNumber, setOrderNumber] = useState("");
  const [sale, setSale] = useState<Sale | null>(null);
  const [selected, setSelected] = useState<Record<string, SelectedLine>>({});
  const [reason, setReason] = useState<Reason>("wrong_flavor");
  const [refundMethod, setRefundMethod] = useState<RefundMethod>("cash");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: string; returnNumber: string } | null>(null);

  async function lookup(): Promise<void> {
    setError(null);
    setSale(null);
    setSelected({});
    setResult(null);
    try {
      const list = await api<{ data: Array<Sale & { order_number?: string }> }>(
        `/branches/${branchId}/sales`,
      );
      const hit = list.data.find(
        (s) => s.orderNumber === orderNumber || s.order_number === orderNumber,
      );
      if (!hit) throw new Error(`No sale with number ${orderNumber}`);
      const detail = await api<{ data: Sale }>(
        `/branches/${branchId}/sales/${hit.id}`,
      );
      setSale(detail.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleLine(line: SaleLine): void {
    setSelected((prev) => {
      if (prev[line.id]) {
        const { [line.id]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [line.id]: { qty: line.quantity, disposition: "restocked" } };
    });
  }

  function updateLine(id: string, patch: Partial<SelectedLine>): void {
    setSelected((prev) => ({ ...prev, [id]: { ...prev[id]!, ...patch } }));
  }

  const refundTotal = sale
    ? sale.items.reduce((sum, line) => {
        const sel = selected[line.id];
        return sel ? sum + line.unitPriceNgn * sel.qty : sum;
      }, 0)
    : 0;

  async function submit(): Promise<void> {
    if (!sale) return;
    setBusy(true);
    setError(null);
    try {
      const items = Object.entries(selected).map(([id, sel]) => ({
        sale_order_item_id: id,
        quantity_returned: sel.qty,
        disposition: sel.disposition,
      }));
      if (items.length === 0) throw new Error("Pick at least one item");
      const res = await api<{ data: { status: string; returnNumber: string } }>(
        `/branches/${branchId}/returns`,
        {
          method: "POST",
          body: JSON.stringify({
            original_sale_order_id: sale.id,
            reason_category: reason,
            reason_note: note || undefined,
            refund_method: refundMethod,
            items,
          }),
        },
      );
      setResult(res.data);
      setSale(null);
      setSelected({});
      setOrderNumber("");
      setNote("");
    } catch (err) {
      if (err instanceof ApiError) setError(`${err.code}: ${err.message}`);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BranchShell branchId={branchId} title="Process a return">
      <div className="max-w-2xl flex flex-col gap-6">
        <section
          className="p-5 rounded-xl flex flex-col gap-3"
          style={{ background: "var(--ms-surface)", border: "1px solid var(--ms-border)" }}
        >
          <label className="text-sm font-semibold">Order number</label>
          <div className="flex gap-2">
            <input
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              placeholder="SO-2026-00042"
              className="flex-1 px-3 py-2 rounded-md border text-sm font-mono"
              style={{ borderColor: "var(--ms-border)" }}
            />
            <button
              type="button"
              onClick={() => void lookup()}
              className="px-4 py-2 rounded-md text-sm font-semibold"
              style={{ background: "var(--ms-green-500)", color: "white" }}
            >
              Look up
            </button>
          </div>
        </section>

        {error && (
          <div
            className="p-3 rounded-md text-sm"
            style={{ background: "rgba(198,58,46,0.12)", color: "var(--ms-danger)" }}
          >
            {error}
          </div>
        )}

        {result && (
          <div
            className="p-4 rounded-md text-sm"
            style={{
              background:
                result.status === "completed"
                  ? "var(--ms-green-100)"
                  : "rgba(255,196,52,0.22)",
              color:
                result.status === "completed" ? "var(--ms-green-900)" : "#7a5a0a",
            }}
          >
            <strong>{result.returnNumber}</strong> ·{" "}
            {result.status === "completed"
              ? "Auto-approved and processed."
              : "Sent to owner for review."}
          </div>
        )}

        {sale && (
          <section
            className="p-5 rounded-xl flex flex-col gap-4"
            style={{ background: "var(--ms-surface)", border: "1px solid var(--ms-border)" }}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-sm">{sale.orderNumber}</div>
                <div className="text-xs" style={{ color: "var(--ms-ink-3)" }}>
                  {sale.status} · {ngn(sale.totalNgn)}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {sale.items.map((line) => {
                const sel = selected[line.id];
                return (
                  <div
                    key={line.id}
                    className="p-3 rounded-md"
                    style={{ border: "1px solid var(--ms-border)" }}
                  >
                    <label className="flex items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={!!sel}
                        onChange={() => toggleLine(line)}
                      />
                      <span className="flex-1">
                        {line.quantity} × {ngn(line.unitPriceNgn)}
                      </span>
                      <span className="text-xs font-mono" style={{ color: "var(--ms-ink-3)" }}>
                        {line.productId.slice(0, 8)}
                      </span>
                    </label>
                    {sel && (
                      <div className="mt-3 flex gap-3 items-center pl-7">
                        <label className="text-xs flex items-center gap-2">
                          Qty:
                          <input
                            type="number"
                            min={1}
                            max={line.quantity}
                            value={sel.qty}
                            onChange={(e) =>
                              updateLine(line.id, { qty: Number(e.target.value) })
                            }
                            className="w-16 px-2 py-1 rounded border text-sm"
                            style={{ borderColor: "var(--ms-border)" }}
                          />
                        </label>
                        <label className="text-xs flex items-center gap-2">
                          Disposition:
                          <select
                            value={sel.disposition}
                            onChange={(e) =>
                              updateLine(line.id, {
                                disposition: e.target.value as SelectedLine["disposition"],
                              })
                            }
                            className="px-2 py-1 rounded border text-sm"
                            style={{ borderColor: "var(--ms-border)" }}
                          >
                            <option value="restocked">Restock</option>
                            <option value="wasted">Waste</option>
                            <option value="replaced">Replace</option>
                          </select>
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs flex flex-col gap-1">
                Reason
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value as Reason)}
                  className="px-3 py-2 rounded-md border text-sm"
                  style={{ borderColor: "var(--ms-border)" }}
                >
                  <option value="changed_mind">Changed mind</option>
                  <option value="wrong_flavor">Wrong flavor</option>
                  <option value="wrong_item">Wrong item</option>
                  <option value="quality_issue">Quality issue</option>
                  <option value="damaged_on_arrival">Damaged on arrival</option>
                  <option value="delivery_failed">Delivery failed</option>
                  <option value="other_with_note">Other</option>
                </select>
              </label>
              <label className="text-xs flex flex-col gap-1">
                Refund method
                <select
                  value={refundMethod}
                  onChange={(e) => setRefundMethod(e.target.value as RefundMethod)}
                  className="px-3 py-2 rounded-md border text-sm"
                  style={{ borderColor: "var(--ms-border)" }}
                >
                  <option value="cash">Cash</option>
                  <option value="card_reversal">Card reversal</option>
                  <option value="transfer">Bank transfer</option>
                  <option value="store_credit">Store credit</option>
                  <option value="replacement">Replacement (free re-send)</option>
                  <option value="glovo_external">Glovo (external)</option>
                  <option value="chowdeck_external">Chowdeck (external)</option>
                  <option value="none">None</option>
                </select>
              </label>
            </div>

            <label className="text-xs flex flex-col gap-1">
              Note (optional)
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="px-3 py-2 rounded-md border text-sm"
                style={{ borderColor: "var(--ms-border)" }}
              />
            </label>

            <div className="flex items-center justify-between pt-2">
              <div className="text-sm">
                Refund total:{" "}
                <strong className="tabular-nums">{ngn(refundTotal)}</strong>
              </div>
              <button
                type="button"
                disabled={busy || Object.keys(selected).length === 0}
                onClick={() => void submit()}
                className="px-5 py-2 rounded-md text-sm font-semibold disabled:opacity-50"
                style={{ background: "var(--ms-green-500)", color: "white" }}
              >
                {busy ? "Submitting…" : "Process return"}
              </button>
            </div>
          </section>
        )}
      </div>
    </BranchShell>
  );
}

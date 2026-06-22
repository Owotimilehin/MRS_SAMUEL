import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import type { StatChip } from "../../components/StatHero.js";
import { useAuthUser } from "../../lib/auth.js";
import { buildReturnSlip } from "../../lib/receipt-data.js";
import { getReceiptStyle } from "../../lib/receipt-settings.js";
import { fetchBranchInfo, printAndToast } from "../../lib/reprint.js";

interface ReturnItem {
  id: string;
  saleOrderItemId: string;
  productId: string;
  quantityReturned: number;
  unitRefundNgn: number;
  disposition: "restocked" | "wasted" | "replaced";
  photoUrls: string[];
}
interface ReturnDetail {
  id: string;
  returnNumber: string;
  originalSaleOrderId: string;
  originalSaleOrderNumber: string | null;
  branchId: string;
  channel: string;
  status: "draft" | "pending_approval" | "completed" | "cancelled";
  reasonCategory: string;
  reasonNote: string | null;
  refundMethod: string;
  refundAmountNgn: number;
  approvedAt: string | null;
  createdAt: string;
  notes: string | null;
  items: ReturnItem[];
}
interface Product {
  id: string;
  name: string;
}

function statusPill(s: ReturnDetail["status"]): JSX.Element {
  if (s === "completed") return <span className="pill pill--success">Completed</span>;
  if (s === "pending_approval") return <span className="pill pill--warning">Awaiting owner</span>;
  if (s === "cancelled") return <span className="pill pill--ink">Cancelled</span>;
  return <span className="pill">Draft</span>;
}

function dispositionPill(d: ReturnItem["disposition"]): JSX.Element {
  if (d === "restocked") return <span className="pill pill--success">Restocked</span>;
  if (d === "wasted") return <span className="pill pill--danger">Wasted</span>;
  return <span className="pill pill--accent">Replaced</span>;
}

export function ReturnDetailPage({
  branchId,
  returnId,
}: {
  branchId: string;
  returnId: string;
}): JSX.Element {
  const [ret, setRet] = useState<ReturnDetail | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [r, p] = await Promise.all([
        api<{ data: ReturnDetail }>(`/branches/${branchId}/returns/${returnId}`),
        api<{ data: Product[] }>(`/products`),
      ]);
      setRet(r.data);
      setProducts(p.data);
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, returnId]);

  async function cancel(): Promise<void> {
    if (!window.confirm("Cancel this return? It will be marked cancelled.")) return;
    setActing(true);
    try {
      await api(`/branches/${branchId}/returns/${returnId}/cancel`, { method: "PATCH" });
      toast.success("Return cancelled");
      await load();
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setActing(false);
    }
  }

  const productName = (id: string): string => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  const authUser = useAuthUser();
  const [printing, setPrinting] = useState(false);
  async function printReturnSlip(): Promise<void> {
    if (!ret) return;
    setPrinting(true);
    try {
      const branch = await fetchBranchInfo(branchId);
      const reason = [ret.reasonCategory.replace(/_/g, " "), ret.reasonNote].filter(Boolean).join(" — ");
      const data = buildReturnSlip({
        style: getReceiptStyle(),
        returnNumber: ret.returnNumber,
        createdAtIso: ret.createdAt,
        branch,
        servedBy: (authUser.email.split("@")[0] || authUser.role).replace(/[._]/g, " "),
        items: ret.items.map((it) => ({
          name: productName(it.productId),
          sizeMl: null,
          quantity: it.quantityReturned,
          unitPriceNgn: it.unitRefundNgn,
          lineTotalNgn: it.unitRefundNgn * it.quantityReturned,
        })),
        refundNgn: ret.refundAmountNgn,
        reason,
      });
      await printAndToast(data);
    } finally {
      setPrinting(false);
    }
  }

  const detailChips: StatChip[] = [
    { label: "Items", value: ret?.items.length ?? "—" },
    { label: "Refund ₦", value: ret ? ngn(ret.refundAmountNgn) : "—" },
    { label: "Status", value: ret ? ret.status.replace(/_/g, " ") : "—" },
  ];

  return (
    <BranchShell
      branchId={branchId}
      title={ret?.returnNumber ?? "Return"}
      actions={
        <>
          {ret && (
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              disabled={printing}
              onClick={() => void printReturnSlip()}
            >
              {printing ? "Printing…" : "🖨 Print slip"}
            </button>
          )}
          <Link to="/branch/returns" className="btn btn--subtle btn--sm">
            ← All returns
          </Link>
        </>
      }
    >
      <StatHero
        eyebrow="Branch"
        title={ret?.returnNumber ?? "Return"}
        sub="Review items, refund amount and approval status for this return."
        loading={loading}
        chips={detailChips}
      />

      {loading || !ret ? (
        <InlineLoader />
      ) : (
        <>
          <section className="card" style={{ marginBottom: 18 }}>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <div>
                <h2 className="t-h2">{ret.returnNumber}</h2>
                <div style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 4 }}>
                  Filed {formatDateTime(ret.createdAt)} · channel: {ret.channel}
                </div>
                <div style={{ fontSize: 13, marginTop: 6 }}>
                  Against order:{" "}
                  <Link
                    to="/branch/sales/$saleId"
                    params={{ saleId: ret.originalSaleOrderId }}
                    style={{ color: "var(--accent)", fontWeight: 600 }}
                  >
                    {ret.originalSaleOrderNumber ?? "View order"} →
                  </Link>
                </div>
              </div>
              {statusPill(ret.status)}
            </header>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
              <Field label="Refund amount" value={ngn(ret.refundAmountNgn)} strong />
              <Field label="Refund method" value={ret.refundMethod.replace(/_/g, " ")} />
              <Field label="Reason" value={ret.reasonCategory.replace(/_/g, " ")} />
              <Field
                label="Approved"
                value={ret.approvedAt ? formatDateTime(ret.approvedAt) : "—"}
              />
            </div>

            {ret.reasonNote && (
              <div className="card card--soft" style={{ marginTop: 14, padding: 12, whiteSpace: "pre-wrap", fontSize: 14 }}>
                <strong>Reason note:</strong> {ret.reasonNote}
              </div>
            )}
            {ret.notes && (
              <div className="card card--soft" style={{ marginTop: 14, padding: 12, whiteSpace: "pre-wrap", fontSize: 14 }}>
                <strong>Notes:</strong> {ret.notes}
              </div>
            )}

            {(ret.status === "draft" || ret.status === "pending_approval") && (
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
                <button
                  type="button"
                  className="btn btn--subtle"
                  disabled={acting}
                  onClick={() => void cancel()}
                >
                  Cancel return
                </button>
              </div>
            )}
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 12 }}>Items returned</h2>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="table__num">Qty</th>
                    <th className="table__num">Unit refund</th>
                    <th className="table__num">Line refund</th>
                    <th>Disposition</th>
                    <th>Photos</th>
                  </tr>
                </thead>
                <tbody>
                  {ret.items.map((it) => (
                    <tr key={it.id}>
                      <td>{productName(it.productId)}</td>
                      <td className="table__num">{it.quantityReturned}</td>
                      <td className="table__num">{ngn(it.unitRefundNgn)}</td>
                      <td className="table__num" style={{ fontWeight: 700 }}>
                        {ngn(it.unitRefundNgn * it.quantityReturned)}
                      </td>
                      <td>{dispositionPill(it.disposition)}</td>
                      <td style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                        {it.photoUrls.length > 0 ? `${it.photoUrls.length} photo${it.photoUrls.length === 1 ? "" : "s"}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 12 }}>
              Restocked bottles return to branch stock. Wasted bottles write two ledger rows (in + out) for honest accounting. Replaced bottles trigger a zero-value replacement order.
            </p>
          </section>
        </>
      )}
    </BranchShell>
  );
}

function Field({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}): JSX.Element {
  return (
    <div className="card card--soft" style={{ padding: 12 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-soft)",
        }}
      >
        {label}
      </div>
      <div
        className="tabular-nums"
        style={{
          fontWeight: strong ? 800 : 600,
          fontSize: strong ? 22 : 14,
          marginTop: 4,
          textTransform: strong ? "none" : "capitalize",
        }}
      >
        {value}
      </div>
    </div>
  );
}

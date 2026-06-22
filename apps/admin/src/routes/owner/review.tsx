import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { StatHero } from "../../components/StatHero.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface TransferVariance {
  id: string;
  transferNumber: string;
  branchId: string;
  factoryId: string;
  status: string;
  updatedAt: string;
}
interface ReturnApproval {
  id: string;
  originalSaleOrderId: string;
  originalSaleOrderNumber: string | null;
  reason: string;
  refundAmountNgn: number;
  createdAt: string;
  branchId: string;
}
interface PaymentAttentionItem {
  id: string;
  order_number: string;
  status: string;
  total_ngn: number;
  refund_owed_ngn: number | null;
  reported_ngn: number | null;
}
interface ReviewResp {
  data: {
    transfer_variances: TransferVariance[];
    return_approvals: ReturnApproval[];
    payment_attention?: PaymentAttentionItem[];
  };
}

export function ReviewPage(): JSX.Element {
  const [data, setData] = useState<ReviewResp["data"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<ReviewResp>(`/review`);
      setData(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function approveTransfer(id: string): Promise<void> {
    setActing(id);
    try {
      await api(`/transfers/${id}/approve`, { method: "PATCH" });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  }

  async function approveReturn(id: string): Promise<void> {
    setActing(id);
    try {
      await api(`/returns/${id}/approve`, { method: "PATCH" });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  }

  async function rejectReturn(id: string): Promise<void> {
    const reason = window.prompt("Reason for rejection?");
    if (!reason) return;
    setActing(id);
    try {
      await api(`/returns/${id}/reject`, {
        method: "PATCH",
        body: JSON.stringify({ reason }),
      });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  }

  const paymentAttentionCount = data?.payment_attention?.length ?? 0;
  const transferVarianceCount = data?.transfer_variances.length ?? 0;
  const returnApprovalCount = data?.return_approvals.length ?? 0;
  const total = transferVarianceCount + returnApprovalCount + paymentAttentionCount;

  return (
    <Shell
      title="Needs review"
      actions={
        <span className={total > 0 ? "pill pill--warning" : "pill pill--success"}>
          {total} open
        </span>
      }
    >
      <StatHero
        eyebrow="Overview"
        title="Needs review"
        sub="Items awaiting owner action — variances and return approvals."
        loading={loading}
        chips={[
          { label: "Items to review", value: total, tone: total > 0 ? "danger" : "good" },
          { label: "Payment attention", value: paymentAttentionCount, tone: paymentAttentionCount > 0 ? "danger" : "good" },
          { label: "Transfer variances", value: transferVarianceCount, tone: transferVarianceCount > 0 ? "warn" : "good" },
          { label: "Return approvals", value: returnApprovalCount, tone: returnApprovalCount > 0 ? "warn" : "good" },
        ]}
      />


      {/* Payment attention bucket */}
      <section style={{ marginBottom: 24 }}>
        <header style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
          <h2 className="t-h2">Payment attention</h2>
          <span className={paymentAttentionCount > 0 ? "pill pill--danger" : "pill pill--ink"}>{paymentAttentionCount}</span>
        </header>
        {loading ? (
          <InlineLoader />
        ) : !data || paymentAttentionCount === 0 ? (
          <div className="empty">
            <div className="empty__title">No payment issues</div>
            All online order payments are reconciled.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Status</th>
                  <th className="table__num">Expected</th>
                  <th className="table__num">Payaza reported</th>
                  <th className="table__num">Refund owed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(data.payment_attention ?? []).map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600 }}>{p.order_number}</td>
                    <td>
                      {p.status === "reconcile_needed" ? (
                        <span className="pill pill--danger">Reconcile needed</span>
                      ) : p.status === "cancelled" ? (
                        <span className="pill pill--ink">Cancelled</span>
                      ) : (
                        <span className="pill">{p.status}</span>
                      )}
                    </td>
                    <td className="table__num">{ngn(p.total_ngn)}</td>
                    <td className="table__num">
                      {p.reported_ngn != null ? (
                        <span style={p.reported_ngn !== p.total_ngn ? { color: "var(--danger)", fontWeight: 700 } : undefined}>
                          {ngn(p.reported_ngn)}
                        </span>
                      ) : (
                        <span style={{ color: "var(--ink-soft)" }}>—</span>
                      )}
                    </td>
                    <td className="table__num">
                      {p.refund_owed_ngn != null && p.refund_owed_ngn > 0 ? (
                        <span style={{ color: "var(--danger)", fontWeight: 700 }}>
                          {ngn(p.refund_owed_ngn)}
                        </span>
                      ) : (
                        <span style={{ color: "var(--ink-soft)" }}>—</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link
                        to="/owner/orders/$saleId"
                        params={{ saleId: p.id }}
                        className="pill pill--ink"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ marginBottom: 24 }}>
        <header style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
          <h2 className="t-h2">Transfer variances</h2>
          <span className="pill pill--ink">{data?.transfer_variances.length ?? 0}</span>
        </header>
        {loading ? (
          <InlineLoader />
        ) : !data || data.transfer_variances.length === 0 ? (
          <div className="empty">
            <div className="empty__title">No variances</div>
            All branches received transfers cleanly.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Transfer</th>
                  <th>Branch</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.transfer_variances.map((t) => (
                  <tr key={t.id}>
                    <td style={{ fontWeight: 600 }}>{t.transferNumber}</td>
                    <td>{t.branchId.slice(0, 8)}</td>
                    <td>{formatDateTime(t.updatedAt)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={acting === t.id}
                        onClick={() => void approveTransfer(t.id)}
                      >
                        {acting === t.id ? "Approving…" : "Approve variance"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <header style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
          <h2 className="t-h2">Return approvals</h2>
          <span className="pill pill--ink">{data?.return_approvals.length ?? 0}</span>
        </header>
        {loading ? (
          <InlineLoader />
        ) : !data || data.return_approvals.length === 0 ? (
          <div className="empty">
            <div className="empty__title">No pending returns</div>
            Refund requests will appear here when raised.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Reason</th>
                  <th className="table__num">Refund</th>
                  <th>Raised</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.return_approvals.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>
                      {r.originalSaleOrderNumber ?? "—"}
                    </td>
                    <td>{r.reason}</td>
                    <td className="table__num" style={{ fontWeight: 700 }}>
                      {ngn(r.refundAmountNgn)}
                    </td>
                    <td>{formatDateTime(r.createdAt)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        className="btn btn--subtle btn--sm"
                        style={{ marginRight: 8 }}
                        disabled={acting === r.id}
                        onClick={() => void rejectReturn(r.id)}
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={acting === r.id}
                        onClick={() => void approveReturn(r.id)}
                      >
                        {acting === r.id ? "…" : "Approve refund"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}

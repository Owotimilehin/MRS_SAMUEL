import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { StatHero } from "../../components/StatHero.js";
import { api, humanizeError } from "../../lib/api.js";
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
  net_ngn: number | null;
  shortfall_ngn: number | null;
}
interface PendingClose {
  id: string;
  branch_id: string;
  branch_name: string | null;
  business_date: string;
  variance_ngn: number;
  cash_counted_ngn: number;
  transfers_counted_ngn: number;
  system_cash_total_ngn: number;
  submitted_at: string | null;
  shift_number: number | null;
}
interface ReviewResp {
  data: {
    pending_closes?: PendingClose[];
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
      toast.error(humanizeError(err));
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
      toast.error(humanizeError(err));
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
      toast.error(humanizeError(err));
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
      toast.error(humanizeError(err));
    } finally {
      setActing(null);
    }
  }

  const pendingCloseCount = data?.pending_closes?.length ?? 0;
  const paymentAttentionCount = data?.payment_attention?.length ?? 0;
  const transferVarianceCount = data?.transfer_variances.length ?? 0;
  const returnApprovalCount = data?.return_approvals.length ?? 0;
  const total =
    pendingCloseCount + transferVarianceCount + returnApprovalCount + paymentAttentionCount;

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
          { label: "Shift closes", value: pendingCloseCount, tone: pendingCloseCount > 0 ? "danger" : "good" },
          { label: "Payment attention", value: paymentAttentionCount, tone: paymentAttentionCount > 0 ? "danger" : "good" },
          { label: "Transfer variances", value: transferVarianceCount, tone: transferVarianceCount > 0 ? "warn" : "good" },
          { label: "Return approvals", value: returnApprovalCount, tone: returnApprovalCount > 0 ? "warn" : "good" },
        ]}
      />

      {/* Shift closes awaiting approval — first, because unreviewed cash/transfer
          reconciliations are the highest-value backlog. */}
      <section style={{ marginBottom: 24 }}>
        <header style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
          <h2 className="t-h2">Shift closes awaiting approval</h2>
          <span className={pendingCloseCount > 0 ? "pill pill--danger" : "pill pill--ink"}>{pendingCloseCount}</span>
        </header>
        {loading ? (
          <InlineLoader />
        ) : pendingCloseCount === 0 ? (
          <div className="empty">
            <div className="empty__title">No shift closes waiting</div>
            Submitted end-of-shift reconciliations will appear here to approve or dispute.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Branch</th>
                  <th>Shift</th>
                  <th className="table__num">Counted</th>
                  <th className="table__num">Expected</th>
                  <th className="table__num">Variance</th>
                  <th>Submitted</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(data?.pending_closes ?? []).map((cl) => {
                  const counted = cl.cash_counted_ngn + cl.transfers_counted_ngn;
                  return (
                    <tr key={cl.id}>
                      <td style={{ fontWeight: 600 }}>{cl.business_date}</td>
                      <td>{cl.branch_name ?? cl.branch_id.slice(0, 8)}</td>
                      <td>{cl.shift_number != null ? `#${cl.shift_number}` : "—"}</td>
                      <td className="table__num">{ngn(counted)}</td>
                      <td className="table__num">{ngn(cl.system_cash_total_ngn)}</td>
                      <td className="table__num" style={{ fontWeight: 700, color: cl.variance_ngn === 0 ? undefined : "var(--danger)" }}>
                        {cl.variance_ngn > 0 ? `+${ngn(cl.variance_ngn)}` : ngn(cl.variance_ngn)}
                      </td>
                      <td>{cl.submitted_at ? formatDateTime(cl.submitted_at) : "—"}</td>
                      <td style={{ textAlign: "right" }}>
                        <Link
                          to="/closes/$branchId/$closeId"
                          params={{ branchId: cl.branch_id, closeId: cl.id }}
                          className="pill pill--ink"
                        >
                          Review →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>


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
                  <th className="table__num">Net settled</th>
                  <th className="table__num">Shortfall</th>
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
                      {p.net_ngn != null ? ngn(p.net_ngn) : <span style={{ color: "var(--ink-soft)" }}>—</span>}
                    </td>
                    <td className="table__num">
                      {p.shortfall_ngn != null && p.shortfall_ngn > 0 ? (
                        <span style={{ color: "var(--danger)", fontWeight: 700 }}>{ngn(p.shortfall_ngn)}</span>
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

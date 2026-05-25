import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

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
  reason: string;
  refundAmountNgn: number;
  createdAt: string;
  branchId: string;
}
interface ReviewResp {
  data: {
    transfer_variances: TransferVariance[];
    return_approvals: ReturnApproval[];
  };
}

export function ReviewPage(): JSX.Element {
  const [data, setData] = useState<ReviewResp["data"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await api<ReviewResp>(`/review`);
      setData(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  }

  const total =
    (data?.transfer_variances.length ?? 0) + (data?.return_approvals.length ?? 0);

  return (
    <Shell
      title="Needs review"
      actions={
        <span className={total > 0 ? "pill pill--warning" : "pill pill--success"}>
          {total} open
        </span>
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
                    <td style={{ fontFamily: "monospace", fontSize: 13 }}>
                      {r.originalSaleOrderId.slice(0, 8)}
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

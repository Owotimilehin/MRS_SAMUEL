import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BranchShell } from "../../components/BranchShell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface CloseRow {
  id: string;
  businessDate: string;
  status: "draft" | "submitted" | "approved" | "disputed";
  cashCountedNgn: number;
  transfersCountedNgn: number;
  systemCashTotalNgn: number;
  varianceNgn: number;
  submittedAt: string | null;
  approvedAt: string | null;
}

function statusPill(s: CloseRow["status"]): JSX.Element {
  if (s === "approved") return <span className="pill pill--success">Approved</span>;
  if (s === "disputed") return <span className="pill pill--danger">Disputed</span>;
  if (s === "submitted") return <span className="pill pill--warning">Submitted</span>;
  return <span className="pill">Draft</span>;
}

export function BranchClosesPage({ branchId }: { branchId: string }): JSX.Element {
  const [rows, setRows] = useState<CloseRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<{ data: CloseRow[] }>(`/branches/${branchId}/daily-close`);
        if (!cancelled) {
          // Sort newest first
          const sorted = [...res.data].sort((a, b) =>
            a.businessDate < b.businessDate ? 1 : -1,
          );
          setRows(sorted);
        }
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  const approved = rows.filter((r) => r.status === "approved").length;
  const disputed = rows.filter((r) => r.status === "disputed").length;
  const submitted = rows.filter((r) => r.status === "submitted").length;

  return (
    <BranchShell
      branchId={branchId}
      title="Close history"
      actions={
        <Link to="/branch/close" className="btn btn--primary btn--sm">
          + New close
        </Link>
      }
    >
      

      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <span className="pill pill--success">Approved · {approved}</span>
        <span className="pill pill--warning">Submitted · {submitted}</span>
        {disputed > 0 && <span className="pill pill--danger">Disputed · {disputed}</span>}
        <span className="pill">{rows.length} total</span>
      </div>

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No past closes</div>
          File your first daily close from the "Daily close" tab.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Status</th>
                <th className="table__num">Counted</th>
                <th className="table__num">Expected</th>
                <th className="table__num">Variance</th>
                <th>Submitted</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.businessDate}</td>
                  <td>{statusPill(r.status)}</td>
                  <td className="table__num">
                    {ngn(r.cashCountedNgn + r.transfersCountedNgn)}
                  </td>
                  <td className="table__num" style={{ color: "var(--ink-soft)" }}>
                    {ngn(r.systemCashTotalNgn)}
                  </td>
                  <td
                    className="table__num"
                    style={{
                      fontWeight: 700,
                      color:
                        r.varianceNgn < 0
                          ? "var(--danger)"
                          : r.varianceNgn > 0
                            ? "var(--warning)"
                            : "var(--ink-soft)",
                    }}
                  >
                    {r.varianceNgn > 0 ? "+" : ""}
                    {ngn(r.varianceNgn)}
                  </td>
                  <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                    {r.submittedAt ? formatDateTime(r.submittedAt) : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Link
                      to="/closes/$branchId/$closeId"
                      params={{ branchId, closeId: r.id }}
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
    </BranchShell>
  );
}

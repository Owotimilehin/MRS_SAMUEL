import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import { BranchTabs } from "../../components/BranchTabs.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import type { StatChip } from "../../components/StatHero.js";

interface CloseRow {
  id: string;
  businessDate: string;
  // shift_number is present when the server returns multiple closes per day.
  shiftNumber?: number | null;
  openedAt?: string | null;
  closedAt?: string | null;
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
  // null = loading; boolean once resolved — drives contextual tab strip
  const [shiftOpen, setShiftOpen] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelledShift = false;
    void (async () => {
      const { hasOpenShift } = await import("../../sync/local-shift-open.js");
      const isOpen = await hasOpenShift(branchId);
      if (!cancelledShift) setShiftOpen(isOpen);
    })();
    return () => { cancelledShift = true; };
  }, [branchId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<{ data: CloseRow[] }>(`/branches/${branchId}/daily-close`);
        if (!cancelled) {
          // Sort newest first
          // Sort newest date first; within the same date, highest shift number
        // (or latest submittedAt) first — handles multiple shifts per day.
        const sorted = [...res.data].sort((a, b) => {
            if (a.businessDate !== b.businessDate) {
              return a.businessDate < b.businessDate ? 1 : -1;
            }
            const aShift = a.shiftNumber ?? 0;
            const bShift = b.shiftNumber ?? 0;
            if (aShift !== bShift) return bShift - aShift;
            const aTime = a.submittedAt ?? "";
            const bTime = b.submittedAt ?? "";
            return bTime < aTime ? -1 : 1;
          });
          setRows(sorted);
        }
      } catch (err) {
        if (!cancelled) toast.error(humanizeError(err));
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

  const withVariance = rows.filter((r) => r.varianceNgn !== 0).length;
  const lastRow = rows[0]; // already sorted newest first

  const chips: StatChip[] = [
    { label: "Total reports", value: rows.length },
  ];
  if (withVariance > 0) {
    chips.push({ label: "With variance", value: withVariance, tone: "warn" });
  } else {
    chips.push({ label: "With variance", value: withVariance, tone: "good" });
  }
  if (lastRow) {
    chips.push({ label: "Last variance ₦", value: ngn(lastRow.varianceNgn) });
  }

  const shiftTabs = shiftOpen
    ? [
        { to: "/branch/close" as const, label: "End", cap: "daily_close.submit" as const },
        { to: "/branch/closes" as const, label: "History" },
      ]
    : [
        { to: "/branch/shift-start" as const, label: "Start", cap: "shift_open.submit" as const },
        { to: "/branch/closes" as const, label: "History" },
      ];

  return (
    <BranchShell
      branchId={branchId}
      title="Shift-end history"
      actions={
        <Link to="/branch/close" className="btn btn--primary btn--sm">
          + New shift end
        </Link>
      }
    >
      <StatHero
        eyebrow="Branch"
        title="Shift-end reports"
        sub="Cash reconciliation records for this branch."
        loading={loading}
        chips={chips}
      />
      <BranchTabs items={shiftTabs} />

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
          <div className="empty__title">No past shift-end reports</div>
          File your first shift-end report from the "Shift end" tab.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Shift</th>
                <th>Status</th>
                <th className="table__num">Counted</th>
                <th className="table__num">Expected</th>
                <th className="table__num">Variance</th>
                <th>Opened → Closed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.businessDate}</td>
                  <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                    {r.shiftNumber != null ? `#${r.shiftNumber}` : "—"}
                  </td>
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
                  <td style={{ color: "var(--ink-soft)", fontSize: 12 }}>
                    {r.openedAt ? formatDateTime(r.openedAt) : "—"}
                    {" → "}
                    {r.closedAt ? formatDateTime(r.closedAt) : r.submittedAt ? formatDateTime(r.submittedAt) : "—"}
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

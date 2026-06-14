import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { api, ApiError } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface ReturnRow {
  id: string;
  returnNumber: string;
  originalSaleOrderId: string;
  status: "draft" | "pending_approval" | "completed" | "cancelled";
  reasonCategory: string;
  refundMethod: string;
  refundAmountNgn: number;
  createdAt: string;
  branchId: string;
}
interface Branch {
  id: string;
  name: string;
}

function statusPill(s: ReturnRow["status"]): JSX.Element {
  if (s === "completed") return <span className="pill pill--success">Completed</span>;
  if (s === "pending_approval")
    return <span className="pill pill--warning">Awaiting owner</span>;
  if (s === "cancelled") return <span className="pill pill--ink">Cancelled</span>;
  return <span className="pill">{s}</span>;
}

export function OwnerReturnsPage(): JSX.Element {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "pending" | "completed" | "threshold">("all");

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const br = await api<{ data: Branch[] }>("/branches");
      const all = await Promise.all(
        br.data.map((b) =>
          api<{ data: Omit<ReturnRow, "branchId">[] }>(
            `/branches/${b.id}/returns`,
          ).then((r) => r.data.map((row) => ({ ...row, branchId: b.id }))),
        ),
      );
      setBranches(br.data);
      setRows(
        all.flat().sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1)),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const branchName = (id: string): string =>
    branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filter === "pending" && r.status !== "pending_approval") return false;
      if (filter === "completed" && r.status !== "completed") return false;
      if (filter === "threshold" && r.refundAmountNgn <= 5000) return false;
      return true;
    });
  }, [rows, filter]);

  async function approve(branchId: string, returnId: string): Promise<void> {
    if (!window.confirm("Approve this return refund?")) return;
    try {
      await api(`/branches/${branchId}/returns/${returnId}/approve`, {
        method: "PATCH",
      });
      await load();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <Shell title="Returns">
      <section className="card">
        <header
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          {(["all", "pending", "completed", "threshold"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={filter === f ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
              onClick={() => setFilter(f)}
            >
              {f === "all"
                ? "All"
                : f === "pending"
                ? "Pending"
                : f === "completed"
                ? "Completed"
                : "Over ₦5,000"}
            </button>
          ))}
          <span
            style={{ color: "var(--ink-soft)", fontSize: 13, marginLeft: "auto" }}
          >
            {filtered.length} of {rows.length}
          </span>
        </header>

        

        {loading ? (
          <InlineLoader />
        ) : filtered.length === 0 ? (
          <div className="empty">
            <div className="empty__title">Nothing to show</div>
            Returns appear here when customers bring bottles back.
          </div>
        ) : (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Return #</th>
                  <th>Date</th>
                  <th>Branch</th>
                  <th>Reason</th>
                  <th>Method</th>
                  <th className="table__num">Refund</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const isOverThreshold = r.refundAmountNgn > 5000;
                  return (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>{r.returnNumber}</td>
                      <td>{formatDateTime(r.createdAt)}</td>
                      <td>{branchName(r.branchId)}</td>
                      <td style={{ color: "var(--ink-soft)" }}>{r.reasonCategory}</td>
                      <td style={{ color: "var(--ink-soft)" }}>{r.refundMethod}</td>
                      <td
                        className="table__num"
                        style={{
                          fontWeight: 700,
                          color: isOverThreshold ? "var(--danger)" : undefined,
                        }}
                      >
                        {ngn(r.refundAmountNgn)}
                        {isOverThreshold && " ⚑"}
                      </td>
                      <td>{statusPill(r.status)}</td>
                      <td className="table__num" style={{ display: "flex", gap: 6 }}>
                        <Link
                          to="/owner/returns/$branchId/$returnId"
                          params={{ branchId: r.branchId, returnId: r.id }}
                          className="pill pill--ink"
                        >
                          Open
                        </Link>
                        {r.status === "pending_approval" && (
                          <button
                            type="button"
                            className="pill pill--success"
                            style={{ cursor: "pointer", border: 0 }}
                            onClick={() => approve(r.branchId, r.id)}
                          >
                            Approve
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}

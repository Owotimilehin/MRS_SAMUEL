import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api, ApiError } from "../../lib/api.js";
import { ngn, formatDate } from "../../lib/format.js";

interface Branch {
  id: string;
  name: string;
}
interface CloseRow {
  id: string;
  branchId: string;
  businessDate: string;
  status: string;
  cashCountedNgn: number;
  transfersCountedNgn: number;
  systemCashTotalNgn: number;
  varianceNgn: number;
  notes: string | null;
}
interface StockCount {
  productId: string;
  systemQuantity: number;
  countedQuantity: number;
  variance: number;
  varianceReason: string | null;
}
interface CloseDetail extends CloseRow {
  stock_counts: StockCount[];
}

export function OwnerClosesPage(): JSX.Element {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [closes, setCloses] = useState<CloseRow[]>([]);
  const [detail, setDetail] = useState<CloseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const branchRes = await api<{ data: Branch[] }>("/branches");
      setBranches(branchRes.data);
      const all: CloseRow[] = [];
      for (const b of branchRes.data) {
        const r = await api<{ data: CloseRow[] }>(`/branches/${b.id}/daily-close`);
        for (const row of r.data) all.push(row);
      }
      setCloses(
        all.sort((a, b) => b.businessDate.localeCompare(a.businessDate)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function open(close: CloseRow): Promise<void> {
    try {
      const res = await api<{ data: CloseDetail }>(
        `/branches/${close.branchId}/daily-close/${close.id}`,
      );
      setDetail(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function approve(): Promise<void> {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await api(
        `/branches/${detail.branchId}/daily-close/${detail.id}/approve`,
        { method: "PATCH" },
      );
      setDetail(null);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) setError(`${err.code}: ${err.message}`);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function dispute(): Promise<void> {
    if (!detail) return;
    const reason = window.prompt("Why are you disputing this close?");
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      await api(
        `/branches/${detail.branchId}/daily-close/${detail.id}/dispute`,
        { method: "PATCH", body: JSON.stringify({ reason }) },
      );
      setDetail(null);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) setError(`${err.code}: ${err.message}`);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const branchName = (id: string): string =>
    branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  return (
    <Shell title="Daily closes">
      <div className="flex flex-col gap-6">
        {error && (
          <div
            className="p-3 rounded-md text-sm"
            style={{ background: "rgba(198,58,46,0.12)", color: "var(--ms-danger)" }}
          >
            {error}
          </div>
        )}

        <div
          className="rounded-xl overflow-hidden"
          style={{ background: "var(--ms-surface)", border: "1px solid var(--ms-border)" }}
        >
          <table className="w-full text-sm">
            <thead style={{ background: "var(--ms-surface-alt)" }}>
              <tr>
                <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                  Date
                </th>
                <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                  Branch
                </th>
                <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                  Status
                </th>
                <th className="text-right px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                  Counted cash
                </th>
                <th className="text-right px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                  Variance
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {closes.map((c) => (
                <tr key={c.id} style={{ borderTop: "1px solid var(--ms-divider)" }}>
                  <td className="px-4 py-3">{formatDate(c.businessDate)}</td>
                  <td className="px-4 py-3">{branchName(c.branchId)}</td>
                  <td className="px-4 py-3">
                    <span
                      className="text-xs font-semibold px-2 py-1 rounded-full"
                      style={{
                        background:
                          c.status === "approved"
                            ? "var(--ms-green-100)"
                            : c.status === "disputed"
                              ? "rgba(198,58,46,0.15)"
                              : "rgba(255,196,52,0.22)",
                        color:
                          c.status === "approved"
                            ? "var(--ms-green-900)"
                            : c.status === "disputed"
                              ? "var(--ms-danger)"
                              : "#7a5a0a",
                      }}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {ngn(c.cashCountedNgn)}
                  </td>
                  <td
                    className="px-4 py-3 text-right tabular-nums"
                    style={{
                      color:
                        c.varianceNgn === 0
                          ? "var(--ms-ink-2)"
                          : "var(--ms-danger)",
                    }}
                  >
                    {ngn(c.varianceNgn)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => void open(c)}
                      className="text-xs font-semibold underline"
                      style={{ color: "var(--ms-green-900)" }}
                    >
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {detail && (
          <div
            className="rounded-xl p-5 flex flex-col gap-4"
            style={{ background: "var(--ms-surface)", border: "1px solid var(--ms-border)" }}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="font-display text-lg font-bold">
                {branchName(detail.branchId)} · {formatDate(detail.businessDate)}
              </h2>
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="text-xs"
                style={{ color: "var(--ms-ink-3)" }}
              >
                Close
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide" style={{ color: "var(--ms-ink-3)" }}>
                  Expected cash
                </div>
                <div className="tabular-nums font-semibold">
                  {ngn(detail.systemCashTotalNgn)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide" style={{ color: "var(--ms-ink-3)" }}>
                  Counted
                </div>
                <div className="tabular-nums font-semibold">
                  {ngn(detail.cashCountedNgn + detail.transfersCountedNgn)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide" style={{ color: "var(--ms-ink-3)" }}>
                  Variance
                </div>
                <div
                  className="tabular-nums font-semibold"
                  style={{
                    color:
                      detail.varianceNgn === 0
                        ? "var(--ms-green-900)"
                        : "var(--ms-danger)",
                  }}
                >
                  {ngn(detail.varianceNgn)}
                </div>
              </div>
            </div>

            <table className="w-full text-sm">
              <thead style={{ background: "var(--ms-surface-alt)" }}>
                <tr>
                  <th className="text-left px-3 py-2 text-xs">Product</th>
                  <th className="text-right px-3 py-2 text-xs">Expected</th>
                  <th className="text-right px-3 py-2 text-xs">Counted</th>
                  <th className="text-right px-3 py-2 text-xs">Variance</th>
                  <th className="text-left px-3 py-2 text-xs">Reason</th>
                </tr>
              </thead>
              <tbody>
                {detail.stock_counts.map((sc) => (
                  <tr key={sc.productId} style={{ borderTop: "1px solid var(--ms-divider)" }}>
                    <td className="px-3 py-2 font-mono text-xs">
                      {sc.productId.slice(0, 8)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {sc.systemQuantity}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {sc.countedQuantity}
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums"
                      style={{
                        color: sc.variance === 0 ? "var(--ms-ink-2)" : "var(--ms-danger)",
                      }}
                    >
                      {sc.variance > 0 ? `+${sc.variance}` : sc.variance}
                    </td>
                    <td className="px-3 py-2 text-xs" style={{ color: "var(--ms-ink-2)" }}>
                      {sc.varianceReason ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {detail.notes && (
              <div
                className="text-sm p-3 rounded"
                style={{ background: "var(--ms-surface-alt)" }}
              >
                {detail.notes}
              </div>
            )}

            {detail.status === "submitted" && (
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void dispute()}
                  className="px-4 py-2 rounded-md text-sm font-semibold disabled:opacity-50"
                  style={{ background: "var(--ms-surface-alt)", color: "var(--ms-danger)" }}
                >
                  Dispute
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void approve()}
                  className="px-5 py-2 rounded-md text-sm font-semibold disabled:opacity-50"
                  style={{ background: "var(--ms-green-500)", color: "white" }}
                >
                  Approve
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}

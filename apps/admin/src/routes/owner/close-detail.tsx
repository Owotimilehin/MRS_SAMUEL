import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

interface StockCount {
  id: string;
  productId: string;
  systemQuantity: number;
  countedQuantity: number;
  variance: number;
  varianceReason: string | null;
}
interface CloseDetail {
  id: string;
  branchId: string;
  businessDate: string;
  status: "draft" | "submitted" | "approved" | "disputed";
  cashCountedNgn: number;
  transfersCountedNgn: number;
  systemCashTotalNgn: number;
  varianceNgn: number;
  submittedAt: string | null;
  approvedAt: string | null;
  notes: string | null;
  stock_counts: StockCount[];
}
interface Product {
  id: string;
  name: string;
}
interface Branch {
  id: string;
  name: string;
}

function statusPill(s: CloseDetail["status"]): JSX.Element {
  if (s === "approved") return <span className="pill pill--success">Approved</span>;
  if (s === "disputed") return <span className="pill pill--danger">Disputed</span>;
  if (s === "submitted") return <span className="pill pill--warning">Submitted</span>;
  return <span className="pill">Draft</span>;
}

export function CloseDetailPage({
  branchId,
  closeId,
}: {
  branchId: string;
  closeId: string;
}): JSX.Element {
  const [data, setData] = useState<CloseDetail | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [d, p, b] = await Promise.all([
        api<{ data: CloseDetail }>(`/branches/${branchId}/daily-close/${closeId}`),
        api<{ data: Product[] }>(`/products`),
        api<{ data: Branch[] }>(`/branches`),
      ]);
      setData(d.data);
      setProducts(p.data);
      setBranches(b.data);
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
  }, [branchId, closeId]);

  async function approve(): Promise<void> {
    setActing(true);
    try {
      await api(`/branches/${branchId}/daily-close/${closeId}/approve`, { method: "PATCH" });
      setFlash("Close approved");
      setTimeout(() => setFlash(null), 2500);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }
  async function dispute(): Promise<void> {
    const reason = window.prompt("Reason for dispute?");
    if (!reason) return;
    setActing(true);
    try {
      await api(`/branches/${branchId}/daily-close/${closeId}/dispute`, {
        method: "PATCH",
        body: JSON.stringify({ reason }),
      });
      setFlash("Close disputed");
      setTimeout(() => setFlash(null), 2500);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  const productName = (id: string): string => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const branchName = (id: string): string => branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  return (
    <Shell
      title={data ? `Close · ${data.businessDate}` : "Daily close"}
      actions={
        <Link to="/owner/closes" className="btn btn--subtle btn--sm">
          ← All closes
        </Link>
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
      {flash && (
        <div
          className="card"
          style={{
            background: "rgba(16,185,129,0.10)",
            borderColor: "rgba(16,185,129,0.25)",
            color: "#047857",
            marginBottom: 16,
          }}
        >
          {flash}
        </div>
      )}

      {loading || !data ? (
        <InlineLoader />
      ) : (
        <>
          <section className="card" style={{ marginBottom: 18 }}>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div>
                <h2 className="t-h2">{branchName(data.branchId)}</h2>
                <div style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 4 }}>
                  Submitted {data.submittedAt ? formatDateTime(data.submittedAt) : "—"}
                  {data.approvedAt && ` · approved ${formatDateTime(data.approvedAt)}`}
                </div>
              </div>
              {statusPill(data.status)}
            </header>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                gap: 12,
              }}
            >
              <CashBox label="System expected" value={ngn(data.systemCashTotalNgn)} />
              <CashBox label="Cash counted" value={ngn(data.cashCountedNgn)} />
              <CashBox label="Transfers counted" value={ngn(data.transfersCountedNgn)} />
              <CashBox
                label="Variance"
                value={`${data.varianceNgn > 0 ? "+" : ""}${ngn(data.varianceNgn)}`}
                tone={data.varianceNgn < 0 ? "danger" : data.varianceNgn > 0 ? "warning" : "default"}
              />
            </div>

            {data.notes && (
              <div className="card card--soft" style={{ marginTop: 14, padding: 12, whiteSpace: "pre-wrap", fontSize: 14 }}>
                {data.notes}
              </div>
            )}

            {data.status === "submitted" && (
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
                <button type="button" className="btn btn--subtle" disabled={acting} onClick={() => void dispute()}>
                  Dispute
                </button>
                <button type="button" className="btn btn--primary" disabled={acting} onClick={() => void approve()}>
                  {acting ? "…" : "Approve close"}
                </button>
              </div>
            )}
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 12 }}>Stock counts</h2>
            {data.stock_counts.length === 0 ? (
              <div className="empty">No stock counts recorded.</div>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="table__num">System</th>
                      <th className="table__num">Counted</th>
                      <th className="table__num">Variance</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stock_counts.map((sc) => (
                      <tr key={sc.id}>
                        <td>{productName(sc.productId)}</td>
                        <td className="table__num">{sc.systemQuantity}</td>
                        <td className="table__num" style={{ fontWeight: 700 }}>
                          {sc.countedQuantity}
                        </td>
                        <td
                          className="table__num"
                          style={{
                            fontWeight: 700,
                            color:
                              sc.variance < 0
                                ? "var(--danger)"
                                : sc.variance > 0
                                  ? "var(--warning)"
                                  : "var(--ink-soft)",
                          }}
                        >
                          {sc.variance > 0 ? "+" : ""}
                          {sc.variance}
                        </td>
                        <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                          {sc.varianceReason ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </Shell>
  );
}

function CashBox({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warning" | "danger";
}): JSX.Element {
  const color = tone === "danger" ? "var(--danger)" : tone === "warning" ? "var(--warning)" : "var(--ink)";
  return (
    <div className="card card--soft" style={{ padding: 14 }}>
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
      <div className="tabular-nums" style={{ fontWeight: 800, fontSize: 22, color, marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}

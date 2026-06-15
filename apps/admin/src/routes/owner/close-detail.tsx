import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface StockCount {
  id: string;
  productId: string;
  systemQuantity: number;
  countedQuantity: number;
  variance: number;
  varianceReason: string | null;
}
interface CashSale {
  order_number: string;
  channel: string;
  status: string;
  total_ngn: number;
  created_at_local: string;
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
  cash_sales: CashSale[];
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
  const [acting, setActing] = useState(false);

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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
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
      toast.success("Close approved");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
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
      toast.success("Close disputed");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
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

            {/* Plain-English verdict on the cash drawer, with the math spelled out. */}
            {(() => {
              const v = data.varianceNgn;
              const tone = v < 0 ? "danger" : v > 0 ? "warning" : "success";
              const color =
                tone === "danger" ? "var(--danger)" : tone === "warning" ? "var(--warning)" : "var(--success)";
              const verdict =
                v === 0
                  ? "Drawer balances"
                  : v < 0
                    ? `Drawer is ${ngn(-v)} short`
                    : `Drawer is ${ngn(v)} over`;
              return (
                <div
                  className="card card--soft"
                  style={{ padding: 16, marginBottom: 14, borderLeft: `4px solid ${color}` }}
                >
                  <div style={{ fontWeight: 800, fontSize: 18, color }}>{verdict}</div>
                  <div className="tabular-nums" style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 4 }}>
                    Cash counted {ngn(data.cashCountedNgn)} − recorded cash sales {ngn(data.systemCashTotalNgn)} ={" "}
                    {v > 0 ? "+" : ""}
                    {ngn(v)}
                  </div>
                </div>
              );
            })()}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                gap: 12,
              }}
            >
              <CashBox label="Recorded cash sales" value={ngn(data.systemCashTotalNgn)} />
              <CashBox label="Cash counted in drawer" value={ngn(data.cashCountedNgn)} />
              <CashBox
                label="Difference"
                value={`${data.varianceNgn > 0 ? "+" : ""}${ngn(data.varianceNgn)}`}
                tone={data.varianceNgn < 0 ? "danger" : data.varianceNgn > 0 ? "warning" : "default"}
              />
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-soft)" }}>
              Bank transfers counted:{" "}
              <strong className="tabular-nums">{ngn(data.transfersCountedNgn)}</strong> — recorded separately;
              not part of the cash-drawer check above.
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

          <section className="card" style={{ marginBottom: 18 }}>
            <h2 className="t-h2" style={{ marginBottom: 4 }}>
              Cash sales behind &ldquo;recorded cash sales&rdquo;
            </h2>
            <div style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 12 }}>
              The {data.cash_sales.length} cash {data.cash_sales.length === 1 ? "sale" : "sales"} on{" "}
              {data.businessDate} that add up to {ngn(data.systemCashTotalNgn)}.
            </div>
            {data.cash_sales.length === 0 ? (
              <div className="empty">No cash sales recorded for this day.</div>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Time</th>
                      <th>Channel</th>
                      <th className="table__num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cash_sales.map((s) => (
                      <tr key={s.order_number}>
                        <td>{s.order_number}</td>
                        <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                          {formatDateTime(s.created_at_local)}
                        </td>
                        <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>{s.channel}</td>
                        <td className="table__num tabular-nums">{ngn(s.total_ngn)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3} style={{ textAlign: "right", fontWeight: 700 }}>
                        Total
                      </td>
                      <td className="table__num tabular-nums" style={{ fontWeight: 800 }}>
                        {ngn(data.systemCashTotalNgn)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
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

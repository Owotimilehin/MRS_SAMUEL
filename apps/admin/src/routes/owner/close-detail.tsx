import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { StatHero, type StatChip } from "../../components/StatHero.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface StockCount {
  id: string;
  productId: string;
  variantId: string | null;
  sizeMl: number | null;
  systemQuantity: number;
  countedQuantity: number;
  variance: number;
  varianceReason: string | null;
}
interface OpeningCount {
  productId: string;
  variantId: string | null;
  countedQuantity: number;
  variance: number;
}
interface ShiftOpen {
  id: string;
  opened_by: string | null;
  stock_counts: OpeningCount[];
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
  submitted_by: string | null;
  approved_by: string | null;
  notes: string | null;
  stock_counts: StockCount[];
  cash_sales: CashSale[];
  shift_open: ShiftOpen | null;
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
      toast.error(humanizeError(err));
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
      toast.success("Shift-end report approved");
      await load();
    } catch (err) {
      toast.error(humanizeError(err));
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
      toast.success("Shift-end report disputed");
      await load();
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setActing(false);
    }
  }

  async function reopen(): Promise<void> {
    if (
      !window.confirm(
        "Reopen this shift? This reverses the close's stock corrections and any losses it booked, and puts the shift back to open so it can be re-counted and filed again.",
      )
    )
      return;
    setActing(true);
    try {
      await api(`/branches/${branchId}/daily-close/${closeId}/reopen`, { method: "PATCH" });
      toast.success("Shift reopened — re-count and file again");
      // The close no longer exists, so return to the list rather than reload it.
      window.location.assign("/owner/closes");
    } catch (err) {
      toast.error(humanizeError(err));
      setActing(false);
    }
  }

  const productName = (id: string): string => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const branchName = (id: string): string => branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  return (
    <Shell
      title={data ? `Shift end · ${data.businessDate}` : "Shift end"}
      actions={
        <Link to="/owner/closes" className="btn btn--subtle btn--sm">
          ← All reports
        </Link>
      }
    >
      {(() => {
        const chips: StatChip[] = [];
        chips.push({ label: "Expected", value: data ? ngn(data.systemCashTotalNgn) : "—" });
        chips.push({ label: "Counted", value: data ? ngn(data.cashCountedNgn) : "—" });
        const variance = data?.varianceNgn ?? 0;
        if (data && variance !== 0) {
          chips.push({
            label: "Variance",
            value: `${variance > 0 ? "+" : ""}${ngn(variance)}`,
            tone: "warn",
          });
        } else {
          chips.push({
            label: "Variance",
            value: data ? `${variance > 0 ? "+" : ""}${ngn(variance)}` : "—",
          });
        }
        chips.push({ label: "Status", value: data?.status ?? "—" });
        chips.push({ label: "Filed by", value: data?.submitted_by ?? "—" });
        if (data?.approved_by) chips.push({ label: "Approved by", value: data.approved_by });
        return (
          <StatHero
            eyebrow="Finance"
            title={data ? `Shift end · ${data.businessDate}` : "Shift end"}
            sub={data ? `Branch shift end · ${data.businessDate}` : "Loading…"}
            loading={loading}
            chips={chips}
          />
        );
      })()}

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

            {/* Plain-English verdict on the transfers, with the math spelled out. */}
            {(() => {
              const v = data.varianceNgn;
              const tone = v < 0 ? "danger" : v > 0 ? "warning" : "success";
              const color =
                tone === "danger" ? "var(--danger)" : tone === "warning" ? "var(--warning)" : "var(--success)";
              const verdict =
                v === 0
                  ? "Transfers balance"
                  : v < 0
                    ? `Transfers are ${ngn(-v)} short`
                    : `Transfers are ${ngn(v)} over`;
              return (
                <div
                  className="card card--soft"
                  style={{ padding: 16, marginBottom: 14, borderLeft: `4px solid ${color}` }}
                >
                  <div style={{ fontWeight: 800, fontSize: 18, color }}>{verdict}</div>
                  <div className="tabular-nums" style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 4 }}>
                    Transfers received {ngn(data.transfersCountedNgn)} − recorded transfer sales{" "}
                    {ngn(data.systemCashTotalNgn)} = {v > 0 ? "+" : ""}
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
              <CashBox label="Recorded transfer sales" value={ngn(data.systemCashTotalNgn)} />
              <CashBox label="Transfers received" value={ngn(data.transfersCountedNgn)} />
              <CashBox
                label="Difference"
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
                <button type="button" className="btn btn--subtle" disabled={acting} onClick={() => void reopen()}>
                  Reopen
                </button>
                <button type="button" className="btn btn--subtle" disabled={acting} onClick={() => void dispute()}>
                  Dispute
                </button>
                <button type="button" className="btn btn--primary" disabled={acting} onClick={() => void approve()}>
                  {acting ? "…" : "Approve close"}
                </button>
              </div>
            )}
            {data.status === "disputed" && (
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
                <button type="button" className="btn btn--primary" disabled={acting} onClick={() => void reopen()}>
                  {acting ? "…" : "Reopen & re-file"}
                </button>
              </div>
            )}
          </section>

          <section className="card" style={{ marginBottom: 18 }}>
            <h2 className="t-h2" style={{ marginBottom: 4 }}>
              Transfer sales behind &ldquo;recorded transfer sales&rdquo;
            </h2>
            <div style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 12 }}>
              The {data.cash_sales.length} transfer {data.cash_sales.length === 1 ? "sale" : "sales"} on{" "}
              {data.businessDate} that add up to {ngn(data.systemCashTotalNgn)}.
            </div>
            {data.cash_sales.length === 0 ? (
              <div className="empty">No transfer sales recorded for this day.</div>
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
                      <th className="table__num">Opening</th>
                      <th className="table__num">Counted</th>
                      <th className="table__num">Variance</th>
                      <th className="table__num">Shift Δ</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const vkey = (pid: string, vid: string | null): string => `${pid}::${vid ?? ""}`;
                      const openingByProduct = new Map<string, { countedQuantity: number; variance: number }>(
                        (data.shift_open?.stock_counts ?? []).map((s) => [vkey(s.productId, s.variantId), { countedQuantity: s.countedQuantity, variance: s.variance }]),
                      );
                      return data.stock_counts.map((sc) => {
                        const opening = openingByProduct.get(vkey(sc.productId, sc.variantId));
                        // Shift-attributable shrinkage = closing variance − opening variance
                        // Uses stored variances so sales are netted out correctly.
                        const shiftDelta = opening !== undefined ? sc.variance - opening.variance : null;
                        return (
                          <tr key={sc.id}>
                            <td>{productName(sc.productId)}{sc.sizeMl ? ` · ${sc.sizeMl}ml` : ""}</td>
                            <td className="table__num">{sc.systemQuantity}</td>
                            <td className="table__num" style={{ color: "var(--ink-soft)" }}>
                              {opening !== undefined ? opening.countedQuantity : "—"}
                            </td>
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
                            <td
                              className="table__num"
                              style={{
                                fontWeight: 700,
                                color:
                                  shiftDelta === null
                                    ? "var(--ink-soft)"
                                    : shiftDelta < 0
                                      ? "var(--danger)"
                                      : shiftDelta > 0
                                        ? "var(--warning)"
                                        : "var(--ink-soft)",
                              }}
                            >
                              {shiftDelta === null
                                ? "—"
                                : `${shiftDelta > 0 ? "+" : ""}${shiftDelta}`}
                            </td>
                            <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                              {sc.varianceReason ?? "—"}
                            </td>
                          </tr>
                        );
                      });
                    })()}
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

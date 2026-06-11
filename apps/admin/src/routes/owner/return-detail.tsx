import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { api, ApiError } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

interface ReturnItem {
  id: string;
  productId: string;
  quantity: number;
  unitPriceNgn: number;
  disposition: string;
  reason: string | null;
}
interface ReturnDetail {
  id: string;
  returnNumber: string;
  originalSaleOrderId: string;
  status: "draft" | "pending_approval" | "completed" | "cancelled";
  reasonCategory: string;
  refundMethod: string;
  refundAmountNgn: number;
  notes: string | null;
  createdAt: string;
  items: ReturnItem[];
}
interface Product {
  id: string;
  name: string;
}

function statusPill(s: ReturnDetail["status"]): JSX.Element {
  if (s === "completed") return <span className="pill pill--success">Completed</span>;
  if (s === "pending_approval")
    return <span className="pill pill--warning">Awaiting owner</span>;
  if (s === "cancelled") return <span className="pill pill--ink">Cancelled</span>;
  return <span className="pill">{s}</span>;
}

export function OwnerReturnDetailPage({
  branchId,
  returnId,
}: {
  branchId: string;
  returnId: string;
}): JSX.Element {
  const [data, setData] = useState<ReturnDetail | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [branchName, setBranchName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const productName = (id: string): string =>
    products.find((p) => p.id === id)?.name ?? "Unknown product";

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [r, br, p] = await Promise.all([
        api<{ data: ReturnDetail }>(`/branches/${branchId}/returns/${returnId}`),
        api<{ data: Array<{ id: string; name: string }> }>("/branches"),
        api<{ data: Product[] }>("/products"),
      ]);
      setData(r.data);
      setProducts(p.data);
      setBranchName(br.data.find((b) => b.id === branchId)?.name ?? "");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [branchId, returnId]);

  async function approve(): Promise<void> {
    if (!window.confirm("Approve this refund?")) return;
    setActing(true);
    try {
      await api(`/branches/${branchId}/returns/${returnId}/approve`, {
        method: "PATCH",
      });
      await load();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  return (
    <Shell
      title={data ? `Return ${data.returnNumber}` : "Return"}
      actions={
        <Link to="/owner/returns" className="btn btn--subtle btn--sm">
          ← All returns
        </Link>
      }
    >
      {loading ? (
        <InlineLoader />
      ) : error || !data ? (
        <section className="card">
          <p style={{ color: "var(--danger)" }}>{error ?? "Return not found."}</p>
        </section>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
          <section className="card">
            <header
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: 14,
              }}
            >
              <div>
                <div className="t-eyebrow">{branchName}</div>
                <h2 className="t-h2">{data.returnNumber}</h2>
                <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}>
                  Created {formatDateTime(data.createdAt)}
                </div>
              </div>
              {statusPill(data.status)}
            </header>

            <h3 style={{ fontSize: 14, fontWeight: 700, margin: "16px 0 8px" }}>Items</h3>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="table__num">Qty</th>
                    <th className="table__num">Unit</th>
                    <th>Disposition</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((it) => (
                    <tr key={it.id}>
                      <td>{productName(it.productId)}</td>
                      <td className="table__num">{it.quantity}</td>
                      <td className="table__num">{ngn(it.unitPriceNgn)}</td>
                      <td style={{ color: "var(--ink-soft)" }}>{it.disposition}</td>
                      <td style={{ color: "var(--ink-soft)" }}>{it.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data.notes && (
              <div style={{ marginTop: 18 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                  Branch notes
                </h3>
                <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>{data.notes}</p>
              </div>
            )}
          </section>

          <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <section className="card">
              <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Refund</h3>
              <div
                style={{
                  fontSize: 24,
                  fontWeight: 800,
                  color:
                    data.refundAmountNgn > 5000 ? "var(--danger)" : "var(--ink)",
                }}
                className="tabular-nums"
              >
                {ngn(data.refundAmountNgn)}
                {data.refundAmountNgn > 5000 && (
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--danger)",
                      display: "block",
                      fontWeight: 600,
                      marginTop: 4,
                    }}
                  >
                    ⚑ Over ₦5,000 threshold
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, marginTop: 8, color: "var(--ink-soft)" }}>
                Method: {data.refundMethod}
              </div>
              <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                Reason: {data.reasonCategory}
              </div>
            </section>

            {data.status === "pending_approval" && (
              <button
                type="button"
                className="btn btn--primary"
                disabled={acting}
                onClick={approve}
                style={{ width: "100%" }}
              >
                {acting ? "Working…" : "Approve refund"}
              </button>
            )}
          </aside>
        </div>
      )}
    </Shell>
  );
}

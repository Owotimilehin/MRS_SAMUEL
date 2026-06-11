import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

interface SaleItem {
  id: string;
  productId: string;
  quantity: number;
  unitPriceNgn: number;
  lineTotalNgn: number;
}
interface Sale {
  id: string;
  orderNumber: string;
  branchId: string;
  channel: string;
  status: string;
  scheduledDeliveryAt?: string | null;
  deliveryState?: string | null;
  paymentMethod: string;
  subtotalNgn: number;
  deliveryFeeNgn: number;
  totalNgn: number;
  customerId: string | null;
  deliveryAddress: string | null;
  notes: string | null;
  createdAtLocal: string;
  items: SaleItem[];
  delivery?: {
    provider: "bolt" | "manual";
    status: string;
    riderName: string | null;
    riderPhone: string | null;
    riderVehicle: string | null;
    etaMinutes: number | null;
    trackingUrl: string | null;
  } | null;
}

function statusPill(status: string): JSX.Element {
  if (status === "paid") return <span className="pill pill--success">Paid</span>;
  if (status === "delivered") return <span className="pill pill--success">Delivered</span>;
  if (status === "confirmed") return <span className="pill pill--warning">Pending pay</span>;
  if (status === "cancelled") return <span className="pill pill--ink">Cancelled</span>;
  return <span className="pill">{status}</span>;
}

export function OrderDetailPage({ saleId }: { saleId: string }): JSX.Element {
  const [data, setData] = useState<Sale | null>(null);
  const [branchName, setBranchName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        // We don't know the branch yet — fan out: list branches, try each for the sale.
        const br = await api<{ data: Array<{ id: string; name: string }> }>("/branches");
        let sale: Sale | null = null;
        let owningBranch: { id: string; name: string } | null = null;
        for (const b of br.data) {
          try {
            const res = await api<{ data: Sale }>(`/branches/${b.id}/sales/${saleId}`);
            sale = res.data;
            owningBranch = b;
            break;
          } catch {
            /* keep searching */
          }
        }
        if (cancelled) return;
        if (!sale) {
          setError("Order not found in any branch.");
          return;
        }
        setData(sale);
        setBranchName(owningBranch?.name ?? "");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [saleId]);

  return (
    <Shell
      title={data ? `Order ${data.orderNumber}` : "Order"}
      crumb="Owner"
      actions={
        <Link to="/owner/orders" className="btn btn--subtle btn--sm">
          ← All orders
        </Link>
      }
    >
      {loading ? (
        <InlineLoader />
      ) : error || !data ? (
        <section className="card">
          <p style={{ color: "var(--danger)" }}>{error ?? "Order not found."}</p>
          <Link to="/owner/orders" className="btn btn--ghost btn--sm" style={{ marginTop: 12 }}>
            Back to orders
          </Link>
        </section>
      ) : (
        <div
          className="ed-rise"
          style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 18, alignItems: "start" }}
        >
          <section className="card">
            <header className="card__head" style={{ alignItems: "flex-start" }}>
              <div>
                <div className="t-eyebrow" style={{ marginBottom: 4 }}>
                  {data.channel} · {branchName}
                </div>
                <h2 className="t-h2">{data.orderNumber}</h2>
                <div style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}>
                  Placed {formatDateTime(data.createdAtLocal)}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                {statusPill(data.status)}
                {(data.scheduledDeliveryAt ||
                  (data.deliveryState && data.deliveryState !== "Lagos")) && (
                  <div style={{ marginTop: 6, fontSize: 13, color: "var(--warning)" }}>
                    Manual fulfilment — Bolt not dispatched.
                    {data.scheduledDeliveryAt && (
                      <>
                        {" "}Scheduled for{" "}
                        {new Date(data.scheduledDeliveryAt).toLocaleString("en-NG", {
                          weekday: "short",
                          day: "numeric",
                          month: "short",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                        .
                      </>
                    )}
                    {data.deliveryState && data.deliveryState !== "Lagos" && (
                      <> Outside Lagos: {data.deliveryState}.</>
                    )}{" "}
                    Arrange delivery manually, then mark delivered.
                  </div>
                )}
              </div>
            </header>

            <h3 style={{ fontSize: 14, fontWeight: 700, margin: "16px 0 8px" }}>Items</h3>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="table__num">Qty</th>
                    <th className="table__num">Unit</th>
                    <th className="table__num">Line</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((it) => (
                    <tr key={it.id}>
                      <td>{it.productId.slice(0, 8)}…</td>
                      <td className="table__num">{it.quantity}</td>
                      <td className="table__num">{ngn(it.unitPriceNgn)}</td>
                      <td className="table__num" style={{ fontWeight: 700 }}>
                        {ngn(it.lineTotalNgn)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div
              style={{
                marginTop: 18,
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                maxWidth: 320,
                marginLeft: "auto",
              }}
            >
              <span style={{ color: "var(--ink-soft)" }}>Subtotal</span>
              <span className="tabular-nums" style={{ textAlign: "right" }}>
                {ngn(data.subtotalNgn)}
              </span>
              <span style={{ color: "var(--ink-soft)" }}>Delivery</span>
              <span className="tabular-nums" style={{ textAlign: "right" }}>
                {ngn(data.deliveryFeeNgn)}
              </span>
              <span style={{ fontWeight: 700 }}>Total</span>
              <span
                className="tabular-nums"
                style={{ textAlign: "right", fontWeight: 800, fontSize: 18 }}
              >
                {ngn(data.totalNgn)}
              </span>
            </div>

            {data.notes && (
              <div style={{ marginTop: 18 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Notes</h3>
                <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>{data.notes}</p>
              </div>
            )}
          </section>

          <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <section className="card">
              <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Payment</h3>
              <div style={{ fontSize: 14 }}>Method: {data.paymentMethod}</div>
            </section>

            {data.deliveryAddress && (
              <section className="card">
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Delivery</h3>
                <div style={{ fontSize: 14 }}>{data.deliveryAddress}</div>
                {data.delivery && (
                  <div style={{ marginTop: 10, fontSize: 13, color: "var(--ink-soft)" }}>
                    {data.delivery.provider === "bolt" ? "Bolt" : "Manual"} ·{" "}
                    {data.delivery.status}
                    {data.delivery.riderName && (
                      <div>Rider: {data.delivery.riderName}</div>
                    )}
                    {data.delivery.trackingUrl && (
                      <a
                        href={data.delivery.trackingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn--subtle btn--sm"
                        style={{ marginTop: 8 }}
                      >
                        Track on Bolt →
                      </a>
                    )}
                  </div>
                )}
              </section>
            )}
          </aside>
        </div>
      )}
    </Shell>
  );
}

import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BranchShell } from "../../components/BranchShell.js";
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
interface DeliveryInfo {
  id: string;
  provider: "bolt" | "manual";
  externalRef: string | null;
  status:
    | "searching_rider"
    | "assigned"
    | "picked_up"
    | "in_transit"
    | "delivered"
    | "failed"
    | "cancelled";
  pickupAddress: string;
  dropoffAddress: string;
  quotedFeeNgn: number;
  etaMinutes: number | null;
  riderName: string | null;
  riderPhone: string | null;
  riderVehicle: string | null;
  trackingUrl: string | null;
  failReason: string | null;
  retryCount: number;
  requestedAt: string;
  assignedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
}

interface Sale {
  id: string;
  orderNumber: string;
  branchId: string;
  channel: "walkup" | "online" | "phone" | "whatsapp" | "chowdeck_pickup";
  customerId: string | null;
  status:
    | "draft"
    | "confirmed"
    | "paid"
    | "handed_over"
    | "out_for_delivery"
    | "delivered"
    | "failed"
    | "cancelled";
  subtotalNgn: number;
  deliveryFeeNgn: number;
  totalNgn: number;
  paymentMethod: string;
  paymentStatus: string;
  externalReference: string | null;
  notes: string | null;
  cancelReason: string | null;
  createdAtLocal: string;
  items: SaleItem[];
  delivery: DeliveryInfo | null;
}
interface Product {
  id: string;
  name: string;
}

const CANCEL_REASONS = [
  { value: "customer_changed_mind", label: "Customer changed mind" },
  { value: "out_of_stock_realized_late", label: "Out of stock realised late" },
  { value: "payment_failed_persistently", label: "Payment failed persistently" },
  { value: "rider_unavailable", label: "Rider unavailable" },
  { value: "duplicate_order", label: "Duplicate order" },
  { value: "other_with_note", label: "Other" },
];

function statusPill(s: Sale["status"]): JSX.Element {
  if (s === "paid" || s === "handed_over" || s === "delivered")
    return <span className="pill pill--success">{s.replace(/_/g, " ")}</span>;
  if (s === "out_for_delivery")
    return <span className="pill pill--accent">Out for delivery</span>;
  if (s === "confirmed") return <span className="pill pill--warning">Pending pay</span>;
  if (s === "cancelled" || s === "failed") return <span className={s === "failed" ? "pill pill--danger" : "pill pill--ink"}>{s}</span>;
  return <span className="pill">{s}</span>;
}

function deliveryStatusPill(s: NonNullable<Sale["delivery"]>["status"]): JSX.Element {
  if (s === "delivered") return <span className="pill pill--success">Delivered</span>;
  if (s === "in_transit" || s === "picked_up")
    return <span className="pill pill--accent">{s.replace(/_/g, " ")}</span>;
  if (s === "assigned") return <span className="pill pill--accent">Rider assigned</span>;
  if (s === "searching_rider")
    return <span className="pill pill--warning">Finding rider…</span>;
  if (s === "failed") return <span className="pill pill--danger">Failed</span>;
  return <span className="pill pill--ink">{s}</span>;
}

export function SaleDetailPage({ branchId, saleId }: { branchId: string; saleId: string }): JSX.Element {
  const [sale, setSale] = useState<Sale | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([
        api<{ data: Sale }>(`/branches/${branchId}/sales/${saleId}`),
        api<{ data: Product[] }>(`/products`),
      ]);
      setSale(s.data);
      setProducts(p.data);
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
  }, [branchId, saleId]);

  async function action(path: string, body?: unknown, successMsg?: string): Promise<void> {
    setActing(true);
    setError(null);
    try {
      const init: RequestInit = { method: "PATCH" };
      if (body !== undefined) init.body = JSON.stringify(body);
      await api(path, init);
      if (successMsg) {
        setFlash(successMsg);
        setTimeout(() => setFlash(null), 2500);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  async function cancelOrder(): Promise<void> {
    const reason = window.prompt(
      `Cancellation reason\n\n${CANCEL_REASONS.map((r, i) => `${i + 1}. ${r.label}`).join("\n")}\n\nEnter number 1-${CANCEL_REASONS.length}:`,
      "1",
    );
    if (!reason) return;
    const idx = Number(reason) - 1;
    const picked = CANCEL_REASONS[idx];
    if (!picked) {
      setError("Invalid cancellation reason");
      return;
    }
    await action(`/branches/${branchId}/sales/${saleId}/cancel`, { reason: picked.value }, "Order cancelled");
  }

  const productName = (id: string): string => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  const canPay = sale?.status === "confirmed" && sale.channel !== "online";
  const canHandOver = sale?.status === "paid" && ["walkup", "whatsapp", "chowdeck_pickup"].includes(sale.channel);
  const canDeliver = sale?.status === "paid" && ["online", "phone"].includes(sale.channel);
  const canCancel = sale && ["confirmed", "paid"].includes(sale.status);

  return (
    <BranchShell
      branchId={branchId}
      title={sale?.orderNumber ?? "Order"}
      actions={
        <Link to="/branch/sales" className="btn btn--subtle btn--sm">
          ← All sales
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

      {loading || !sale ? (
        <InlineLoader />
      ) : (
        <>
          <section className="card" style={{ marginBottom: 18 }}>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <div>
                <h2 className="t-h2">{sale.orderNumber}</h2>
                <div style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 4 }}>
                  Placed {formatDateTime(sale.createdAtLocal)} · {sale.channel.replace(/_/g, " ")}
                </div>
              </div>
              {statusPill(sale.status)}
            </header>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
              <Field label="Subtotal" value={ngn(sale.subtotalNgn)} />
              <Field label="Delivery" value={ngn(sale.deliveryFeeNgn)} />
              <Field label="Total" value={ngn(sale.totalNgn)} strong />
              <Field label="Payment" value={`${sale.paymentMethod} · ${sale.paymentStatus}`} />
            </div>

            {sale.notes && (
              <div className="card card--soft" style={{ marginTop: 14, padding: 12, whiteSpace: "pre-wrap", fontSize: 14 }}>
                <strong>Notes:</strong> {sale.notes}
              </div>
            )}
            {sale.cancelReason && (
              <div
                className="card"
                style={{
                  marginTop: 14,
                  background: "rgba(220,38,38,0.06)",
                  borderColor: "rgba(220,38,38,0.25)",
                  color: "var(--danger)",
                }}
              >
                <strong>Cancelled:</strong> {sale.cancelReason}
              </div>
            )}
            {sale.externalReference && (
              <div style={{ marginTop: 14, fontSize: 12, color: "var(--ink-soft)" }}>
                External reference: <code style={{ fontFamily: "monospace" }}>{sale.externalReference}</code>
              </div>
            )}

            {sale.delivery && (
              <div
                className="card card--soft"
                style={{ marginTop: 14, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <strong style={{ fontSize: 13, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                    {sale.delivery.provider === "bolt" ? "Bolt delivery" : "Delivery"}
                  </strong>
                  {deliveryStatusPill(sale.delivery.status)}
                </div>
                {sale.delivery.riderName ? (
                  <div style={{ fontSize: 14 }}>
                    <strong>{sale.delivery.riderName}</strong>
                    {sale.delivery.riderVehicle && (
                      <span style={{ color: "var(--ink-soft)" }}> · {sale.delivery.riderVehicle}</span>
                    )}
                    {sale.delivery.riderPhone && (
                      <>
                        {" · "}
                        <a href={`tel:${sale.delivery.riderPhone}`} style={{ color: "var(--accent)" }}>
                          {sale.delivery.riderPhone}
                        </a>
                      </>
                    )}
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                    Waiting for a rider — Bolt usually finds one in &lt; 5 min.
                  </div>
                )}
                <div style={{ display: "flex", gap: 14, fontSize: 12, color: "var(--ink-soft)", flexWrap: "wrap" }}>
                  <span>Quoted fee: {ngn(sale.delivery.quotedFeeNgn)}</span>
                  {sale.delivery.etaMinutes != null && (
                    <span>ETA: ~{sale.delivery.etaMinutes} min</span>
                  )}
                  {sale.delivery.retryCount > 0 && (
                    <span style={{ color: "var(--warning)" }}>Retries: {sale.delivery.retryCount}</span>
                  )}
                </div>
                {sale.delivery.failReason && (
                  <div
                    style={{
                      fontSize: 13,
                      color: "var(--danger)",
                      background: "rgba(220,38,38,0.06)",
                      padding: "8px 12px",
                      borderRadius: 8,
                    }}
                  >
                    {sale.delivery.failReason}
                  </div>
                )}
                {sale.delivery.trackingUrl && (
                  <a
                    href={sale.delivery.trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn--subtle btn--sm"
                    style={{ alignSelf: "flex-start" }}
                  >
                    Open in Bolt →
                  </a>
                )}
              </div>
            )}

            {(canPay || canHandOver || canDeliver || canCancel) && (
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14, flexWrap: "wrap" }}>
                {canCancel && (
                  <button
                    type="button"
                    className="btn btn--subtle"
                    disabled={acting}
                    onClick={() => void cancelOrder()}
                  >
                    Cancel order
                  </button>
                )}
                {canPay && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={acting}
                    onClick={() =>
                      void action(`/branches/${branchId}/sales/${saleId}/pay`, undefined, "Payment recorded")
                    }
                  >
                    {acting ? "…" : "Mark paid"}
                  </button>
                )}
                {canHandOver && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={acting}
                    onClick={() =>
                      void action(
                        `/branches/${branchId}/sales/${saleId}/hand-over`,
                        undefined,
                        "Order handed over",
                      )
                    }
                  >
                    {acting ? "…" : "Hand over"}
                  </button>
                )}
                {canDeliver && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={acting}
                    onClick={() =>
                      void action(
                        `/branches/${branchId}/sales/${saleId}/mark-delivered`,
                        undefined,
                        "Marked delivered",
                      )
                    }
                  >
                    {acting ? "…" : "Mark delivered"}
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 12 }}>Items</h2>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="table__num">Qty</th>
                    <th className="table__num">Unit</th>
                    <th className="table__num">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {sale.items.map((it) => (
                    <tr key={it.id}>
                      <td>{productName(it.productId)}</td>
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
          </section>
        </>
      )}
    </BranchShell>
  );
}

function Field({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}): JSX.Element {
  return (
    <div className="card card--soft" style={{ padding: 12 }}>
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
      <div
        className="tabular-nums"
        style={{ fontWeight: strong ? 800 : 600, fontSize: strong ? 22 : 16, marginTop: 4 }}
      >
        {value}
      </div>
    </div>
  );
}

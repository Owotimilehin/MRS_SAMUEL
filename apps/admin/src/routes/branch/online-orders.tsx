import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BranchShell } from "../../components/BranchShell.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import { BranchTabs } from "../../components/BranchTabs.js";

// Shape returned by GET /online-orders/active — snake_case, matching the API.
interface ActiveOrder {
  id: string;
  order_number: string;
  branch_id: string;
  status: string;
  channel: string;
  total_ngn: number;
  created_at_local: string;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_state: string | null;
  scheduled_delivery_at: string | null;
  is_preorder: boolean;
  is_delivery: boolean;
  delivery_status: string | null;
  produced_at: string | null;
  stage: "awaiting_production" | "ready" | "out_for_delivery";
}

function statusPill(status: string): JSX.Element {
  if (status === "paid") return <span className="pill pill--success">Paid</span>;
  if (status === "out_for_delivery") return <span className="pill pill--accent">Out for delivery</span>;
  if (status === "handed_over") return <span className="pill pill--success">Handed over</span>;
  if (status === "delivered") return <span className="pill pill--success">Delivered</span>;
  if (status === "confirmed") return <span className="pill pill--warning">Pending pay</span>;
  if (status === "reconcile_needed") return <span className="pill pill--danger">Payment needs checking</span>;
  return <span className="pill">{status.replace(/_/g, " ")}</span>;
}

function deliveryChip(deliveryStatus: string | null, isDelivery: boolean): JSX.Element | null {
  if (!isDelivery) return null;
  if (!deliveryStatus) return <span className="pill pill--ink">Delivery · unbooked</span>;
  if (deliveryStatus === "delivered") return <span className="pill pill--success">Delivered</span>;
  if (deliveryStatus === "in_transit" || deliveryStatus === "picked_up")
    return <span className="pill pill--accent">{deliveryStatus.replace(/_/g, " ")}</span>;
  if (deliveryStatus === "assigned") return <span className="pill pill--accent">Rider assigned</span>;
  if (deliveryStatus === "searching_rider") return <span className="pill pill--warning">Finding rider…</span>;
  if (deliveryStatus === "failed" || deliveryStatus === "cancelled")
    return <span className="pill pill--danger">{deliveryStatus}</span>;
  return <span className="pill">{deliveryStatus.replace(/_/g, " ")}</span>;
}

export function BranchOnlineOrdersPage({ branchId }: { branchId: string }): JSX.Element {
  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<{ data: ActiveOrder[] }>("/online-orders/active");
        if (!cancelled) setOrders(res.data);
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

  const awaitingPayment = orders.filter(
    (o) => o.status === "confirmed" || o.status === "reconcile_needed",
  );
  const ready = orders.filter(
    (o) => o.status === "paid" || o.status === "out_for_delivery",
  );

  return (
    <BranchShell branchId={branchId} title="Online orders">
      <div style={{ marginBottom: 16 }}>
        <h2 className="t-h2" style={{ marginBottom: 4 }}>Online orders</h2>
        <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>
          Online orders at this branch — newest first. Awaiting-payment orders are shown so you
          can follow up; only paid orders can be handed over or delivered.
        </p>
      </div>
      <BranchTabs items={[
        { to: "/branch/online-orders", label: "Online", cap: "sales.view" },
        { to: "/branch/preorders", label: "Preorders", cap: "pos.preorder" },
      ]} />

      {loading ? (
        <InlineLoader />
      ) : orders.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No online orders right now.</div>
          New orders will appear here as they come in.
        </div>
      ) : (
        <>
          {awaitingPayment.length > 0 && (
            <section style={{ marginBottom: 20 }}>
              <h3 className="t-h3" style={{ marginBottom: 8, color: "var(--danger)" }}>
                Awaiting payment ({awaitingPayment.length})
              </h3>
              <p style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 8 }}>
                Not paid yet — open an order to re-check the payment, record a transfer/cash
                payment, or cancel it as unpaid. These can’t be made or handed over until paid.
              </p>
              <OrdersTable rows={awaitingPayment} />
            </section>
          )}
          {ready.length > 0 && (
            <section>
              <h3 className="t-h3" style={{ marginBottom: 8 }}>
                Ready to make / deliver ({ready.length})
              </h3>
              <OrdersTable rows={ready} />
            </section>
          )}
        </>
      )}
    </BranchShell>
  );
}

function OrdersTable({ rows }: { rows: ActiveOrder[] }): JSX.Element {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Customer</th>
            <th>Channel</th>
            <th>Status</th>
            <th>Delivery</th>
            <th className="table__num">Total</th>
            <th>Placed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td>
                <Link
                  to="/branch/online-orders/$orderId"
                  params={{ orderId: o.id }}
                  style={{ fontWeight: 600, color: "var(--ink)" }}
                >
                  {o.order_number}
                </Link>
              </td>
              <td>
                {o.customer_name || o.customer_phone ? (
                  <span style={{ display: "grid" }}>
                    <span>{o.customer_name ?? "—"}</span>
                    {o.customer_phone && (
                      <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>{o.customer_phone}</span>
                    )}
                  </span>
                ) : (
                  <span style={{ color: "var(--ink-soft)" }}>—</span>
                )}
              </td>
              <td style={{ textTransform: "capitalize" }}>{o.channel.replace(/_/g, " ")}</td>
              <td>
                {o.status === "confirmed" || o.status === "reconcile_needed" ? (
                  statusPill(o.status)
                ) : o.stage === "awaiting_production" ? (
                  <span className="pill pill--warning">📅 Awaiting production</span>
                ) : o.stage === "ready" ? (
                  <span className="pill pill--success">Ready · hand over / deliver</span>
                ) : (
                  statusPill(o.status)
                )}
                {o.scheduled_delivery_at && (
                  <span className="pill pill--warning" style={{ marginLeft: 6 }}>Scheduled</span>
                )}
              </td>
              <td>{deliveryChip(o.delivery_status, o.is_delivery)}</td>
              <td className="table__num" style={{ fontWeight: 700 }}>
                {ngn(o.total_ngn)}
              </td>
              <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                {formatDateTime(o.created_at_local)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

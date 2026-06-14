import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface CustomerOrder {
  id: string;
  orderNumber: string;
  channel: string;
  status: string;
  paymentStatus: string;
  totalNgn: number;
  createdAtLocal: string;
}
interface CustomerDetail {
  customer: {
    id: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    defaultAddress: string | null;
    createdAt: string;
  };
  orders: CustomerOrder[];
  lifetimeNgn: number;
}

function statusPill(status: string): JSX.Element {
  if (status === "paid") return <span className="pill pill--success">Paid</span>;
  if (status === "handed_over") return <span className="pill pill--success">Handed over</span>;
  if (status === "delivered") return <span className="pill pill--success">Delivered</span>;
  if (status === "confirmed") return <span className="pill pill--warning">Pending pay</span>;
  if (status === "cancelled") return <span className="pill pill--ink">Cancelled</span>;
  if (status === "failed") return <span className="pill pill--danger">Failed</span>;
  return <span className="pill">{status}</span>;
}

export function CustomerDetailPage({ customerId }: { customerId: string }): JSX.Element {
  const [data, setData] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<{ data: CustomerDetail }>(`/customers/${customerId}`);
        if (cancelled) return;
        setData(res.data);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  const title = data?.customer.name ?? data?.customer.phone ?? "Customer";

  return (
    <Shell title={title} crumb="Owner">
      <div className="page-head ed-rise">
        <div className="page-head__titles">
          <Link
            to="/owner/customers"
            className="page-head__eyebrow"
            style={{ color: "var(--accent)" }}
          >
            ← Back to customers
          </Link>
          <h1 className="page-head__title">{title}</h1>
        </div>
      </div>

      

      {loading ? (
        <InlineLoader />
      ) : !data ? (
        <div className="empty">
          <div className="empty__title">Customer not found</div>
        </div>
      ) : (
        <>
          <section className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
              <Stat label="Phone" value={data.customer.phone ?? "—"} mono />
              <Stat label="Email" value={data.customer.email ?? "—"} />
              <Stat label="Orders" value={String(data.orders.length)} />
              <Stat label="Lifetime spend" value={ngn(data.lifetimeNgn)} strong />
              <Stat label="Since" value={formatDateTime(data.customer.createdAt)} />
            </div>
            {data.customer.defaultAddress && (
              <p style={{ marginTop: 12, color: "var(--ink-soft)", fontSize: 13 }}>
                {data.customer.defaultAddress}
              </p>
            )}
          </section>

          <section className="card">
            <div className="card__head"><h2 className="t-h2">Order history</h2></div>
            {data.orders.length === 0 ? (
              <div className="empty">No orders yet.</div>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Order #</th>
                      <th>Date</th>
                      <th>Channel</th>
                      <th className="table__num">Total</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.orders.map((o) => (
                      <tr key={o.id}>
                        <td style={{ fontWeight: 600 }}>{o.orderNumber}</td>
                        <td>{formatDateTime(o.createdAtLocal)}</td>
                        <td style={{ color: "var(--ink-soft)" }}>{o.channel}</td>
                        <td className="table__num" style={{ fontWeight: 700 }}>
                          {ngn(o.totalNgn)}
                        </td>
                        <td>{statusPill(o.status)}</td>
                        <td className="table__num">
                          <Link
                            to="/owner/orders/$saleId"
                            params={{ saleId: o.id }}
                            className="pill pill--ink"
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
          </section>
        </>
      )}
    </Shell>
  );
}

function Stat({
  label,
  value,
  strong,
  mono,
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
}): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 2 }}>{label}</div>
      <div
        style={{
          fontWeight: strong ? 800 : 600,
          fontSize: strong ? 20 : 15,
          fontFamily: mono ? "ui-monospace, monospace" : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

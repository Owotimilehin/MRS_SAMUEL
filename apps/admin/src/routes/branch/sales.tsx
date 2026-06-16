import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BranchShell } from "../../components/BranchShell.js";
import { Stat } from "../../components/Stat.js";
import { StatHero } from "../../components/StatHero.js";
import type { StatChip } from "../../components/StatHero.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface Sale {
  id: string;
  orderNumber: string;
  channel: string;
  status: string;
  paymentMethod: string;
  totalNgn: number;
  createdAtLocal: string;
  notes: string | null;
  isPreorder?: boolean;
  fulfilledAt?: string | null;
  scheduledDeliveryAt?: string | null;
}

// Order type: an immediate walk-up sale vs a made-to-order preorder (and whether
// that preorder is still awaiting fulfilment).
function typePill(s: Sale): JSX.Element {
  if (!s.isPreorder) return <span className="pill pill--ink">Sale</span>;
  return s.fulfilledAt ? (
    <span className="pill pill--success">📅 Preorder · fulfilled</span>
  ) : (
    <span className="pill pill--warning">📅 Preorder · pending</span>
  );
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

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function BranchSalesPage({ branchId }: { branchId: string }): JSX.Element {
  const [sales, setSales] = useState<Sale[]>([]);
  const [filter, setFilter] = useState<"today" | "all">("today");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<{ data: Sale[] }>(`/branches/${branchId}/sales`);
        if (!cancelled) {
          setSales(res.data);
        }
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  const today = todayDate();
  const todaysSales = sales.filter((s) => s.createdAtLocal.slice(0, 10) === today);
  const list = filter === "today" ? todaysSales : sales;

  const completed = todaysSales.filter((s) =>
    ["paid", "handed_over", "delivered"].includes(s.status),
  );
  const revenue = completed.reduce((sum, s) => sum + s.totalNgn, 0);
  const cash = completed.filter((s) => s.paymentMethod === "cash").reduce((sum, s) => sum + s.totalNgn, 0);
  const transfer = completed.filter((s) => s.paymentMethod === "transfer").reduce((sum, s) => sum + s.totalNgn, 0);
  const card = completed.filter((s) => s.paymentMethod === "card").reduce((sum, s) => sum + s.totalNgn, 0);

  const avgTicket = completed.length > 0 ? Math.round(revenue / completed.length) : 0;
  const pendingCount = todaysSales.filter((s) => s.status === "confirmed").length;

  const chips: StatChip[] = [
    { label: "Revenue today", value: ngn(revenue) },
    { label: "Orders", value: completed.length ?? 0 },
    { label: "Avg ticket", value: ngn(avgTicket) },
  ];
  if (pendingCount > 0) {
    chips.push({ label: "Pending pay", value: pendingCount, tone: "danger" });
  } else {
    chips.push({ label: "Pending pay", value: pendingCount, tone: "good" });
  }

  return (
    <BranchShell branchId={branchId} title="Today's sales">
      <StatHero
        eyebrow="Branch"
        title="Sales"
        sub="Today's completed and pending orders at this branch."
        loading={loading}
        chips={chips}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 14,
          marginBottom: 20,
        }}
      >
        <Stat label="Revenue today" value={ngn(revenue)} hint={`${completed.length} orders`} tone="accent" />
        <Stat label="Cash" value={ngn(cash)} />
        <Stat label="Transfer" value={ngn(transfer)} />
        <Stat label="Card" value={ngn(card)} />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <button
          type="button"
          className={filter === "today" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
          onClick={() => setFilter("today")}
        >
          Today
        </button>
        <button
          type="button"
          className={filter === "all" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
          onClick={() => setFilter("all")}
        >
          All recent
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>{list.length} orders</span>
      </div>

      {loading ? (
        <InlineLoader />
      ) : list.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No sales yet</div>
          New sales will appear here as they're recorded.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Type</th>
                <th>Channel</th>
                <th>Payment</th>
                <th>Status</th>
                <th className="table__num">Total</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link
                      to="/branch/sales/$saleId"
                      params={{ saleId: s.id }}
                      style={{ fontWeight: 600, color: "var(--ink)" }}
                    >
                      {s.orderNumber}
                    </Link>
                  </td>
                  <td>{typePill(s)}</td>
                  <td style={{ textTransform: "capitalize" }}>{s.channel.replace(/_/g, " ")}</td>
                  <td style={{ textTransform: "capitalize" }}>{s.paymentMethod}</td>
                  <td>{statusPill(s.status)}</td>
                  <td className="table__num" style={{ fontWeight: 700 }}>
                    {ngn(s.totalNgn)}
                  </td>
                  <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                    {formatDateTime(s.createdAtLocal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </BranchShell>
  );
}

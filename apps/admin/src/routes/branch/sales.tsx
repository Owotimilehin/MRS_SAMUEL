import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import type { StatChip } from "../../components/StatHero.js";
import { api, humanizeError } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import { BranchTabs } from "../../components/BranchTabs.js";

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
  producedAt?: string | null;
  fulfilledAt?: string | null;
  scheduledDeliveryAt?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
}

// Order type: an immediate walk-up sale vs a made-to-order preorder (and whether
// that preorder has been produced yet).
function typePill(s: Sale): JSX.Element {
  if (!s.isPreorder) return <span className="pill pill--ink">Sale</span>;
  return s.producedAt ? (
    <span className="pill pill--success">📅 Preorder · produced</span>
  ) : (
    <span className="pill pill--warning">📅 Preorder · awaiting production</span>
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
  const [filter, setFilter] = useState<"today" | "all" | "awaiting">("today");
  const [loading, setLoading] = useState(true);

  // An online order that's paid but not yet handed over / delivered is waiting
  // on staff to fulfil it. Walk-up till sales end at "paid", so the channel
  // guard keeps them out of the queue.
  const awaitsFulfilment = (s: Sale): boolean => s.channel === "online" && s.status === "paid";

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
        if (!cancelled) toast.error(humanizeError(err));
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
  const awaitingList = sales.filter(awaitsFulfilment);
  const list = filter === "today" ? todaysSales : filter === "awaiting" ? awaitingList : sales;

  const completed = todaysSales.filter((s) =>
    ["paid", "handed_over", "delivered"].includes(s.status),
  );
  const pendingCount = todaysSales.filter((s) => s.status === "confirmed").length;

  // Money is intentionally omitted from the branch/till view — the page shows
  // counts only. Takings are reconciled and shown in the end-of-shift close.
  const chips: StatChip[] = [
    { label: "Orders", value: completed.length ?? 0 },
  ];
  if (pendingCount > 0) {
    chips.push({ label: "Pending pay", value: pendingCount, tone: "danger" });
  } else {
    chips.push({ label: "Pending pay", value: pendingCount, tone: "good" });
  }
  chips.push({
    label: "Awaiting fulfilment",
    value: awaitingList.length,
    tone: awaitingList.length > 0 ? "danger" : "good",
  });

  return (
    <BranchShell branchId={branchId} title="Today's sales">
      <StatHero
        eyebrow="Branch"
        title="Today's sales"
        sub="Today's completed and pending orders at this branch."
        loading={loading}
        chips={chips}
      />
      <BranchTabs items={[
        { to: "/branch", label: "Overview", cap: "sales.view" },
        { to: "/branch/sales", label: "Today's sales", cap: "sales.view" },
      ]} />

      {/* A boxed "Show" bar with outlined choices, so it does not read as a
          second row of page tabs. It wraps on a phone instead of squeezing. */}
      <div className="toolbar" style={{ marginBottom: 12, gap: 8 }} role="group" aria-label="Which orders to show">
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-soft)" }}>Show</span>
        {(
          [
            ["today", "Today"],
            ["all", "All recent"],
            ["awaiting", `Awaiting fulfilment${awaitingList.length > 0 ? ` (${awaitingList.length})` : ""}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            className={filter === key ? "btn btn--ghost btn--sm" : "btn btn--subtle btn--sm"}
            style={{ flex: "none", background: filter === key ? "rgba(27,87,51,0.08)" : undefined }}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
        <span style={{ flex: "1 1 auto" }} />
        <span style={{ fontSize: 13, color: "var(--ink-soft)", whiteSpace: "nowrap" }}>
          {list.length} {list.length === 1 ? "order" : "orders"}
        </span>
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
                <th>Customer</th>
                <th>Type</th>
                <th>Channel</th>
                <th>Payment</th>
                <th>Status</th>
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
                  <td>
                    {s.customerName || s.customerPhone ? (
                      <span style={{ display: "grid" }}>
                        <span>{s.customerName ?? "—"}</span>
                        {s.customerPhone && (
                          <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
                            {s.customerPhone}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span style={{ color: "var(--ink-soft)" }}>—</span>
                    )}
                  </td>
                  <td>{typePill(s)}</td>
                  <td style={{ textTransform: "capitalize" }}>{s.channel.replace(/_/g, " ")}</td>
                  <td style={{ textTransform: "capitalize" }}>{s.paymentMethod}</td>
                  <td>{statusPill(s.status)}</td>
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

import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { ngn, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { downloadCsv } from "../../lib/csv.js";
import { toast } from "../../lib/toast.js";
import { StatHero } from "../../components/StatHero.js";

interface Branch {
  id: string;
  name: string;
  code: string;
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
  totalNgn: number;
  createdAtLocal: string;
  notes: string | null;
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

export function OrdersPage(): JSX.Element {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [onlyAwaiting, setOnlyAwaiting] = useState(false);
  const [q, setQ] = useState("");

  // An online order that's been paid but not yet handed over / delivered is
  // waiting on staff to fulfil it. Walk-up till sales end at "paid" and aren't
  // a fulfilment queue, so the channel guard keeps them out.
  const awaitsFulfilment = (s: Sale): boolean => s.channel === "online" && s.status === "paid";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const br = await api<{ data: Branch[] }>("/branches");
        if (cancelled) return;
        setBranches(br.data);
        // Fan out one /sales fetch per branch in parallel.
        const perBranch = await Promise.all(
          br.data.map(async (b) => {
            const r = await api<{ data: Omit<Sale, "branchId">[] }>(
              `/branches/${b.id}/sales`,
            );
            return r.data.map((s) => ({ ...s, branchId: b.id }));
          }),
        );
        if (cancelled) return;
        const flat = perBranch.flat().sort((a, b) =>
          a.createdAtLocal > b.createdAtLocal ? -1 : 1,
        );
        setSales(flat);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const branchName = (id: string): string =>
    branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  const filtered = useMemo(() => {
    return sales.filter((s) => {
      if (branchFilter !== "all" && s.branchId !== branchFilter) return false;
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      if (channelFilter !== "all" && s.channel !== channelFilter) return false;
      if (onlyAwaiting && !awaitsFulfilment(s)) return false;
      if (q.trim()) {
        const term = q.trim().toLowerCase();
        if (!s.orderNumber.toLowerCase().includes(term)) return false;
      }
      return true;
    });
  }, [sales, branchFilter, statusFilter, channelFilter, onlyAwaiting, q]);

  const channels = useMemo(() => {
    const s = new Set<string>();
    for (const o of sales) s.add(o.channel);
    return Array.from(s).sort();
  }, [sales]);

  return (
    <Shell
      title="Orders"
      crumb="Owner"
      actions={
        <button
          type="button"
          className="btn btn--subtle btn--sm"
          disabled={filtered.length === 0}
          onClick={() =>
            downloadCsv(
              `orders-${new Date().toISOString().slice(0, 10)}`,
              filtered.map((s) => ({
                order_number: s.orderNumber,
                branch: branchName(s.branchId),
                channel: s.channel,
                status: s.status,
                total_ngn: s.totalNgn,
                created_at: s.createdAtLocal,
              })),
            )
          }
        >
          Export CSV
        </button>
      }
    >
      <StatHero
        eyebrow="Sales"
        title="Orders"
        sub="Every order across branches and channels."
        loading={loading}
        chips={[
          {
            label: "Awaiting fulfilment",
            value: sales.filter(awaitsFulfilment).length,
            tone: sales.filter(awaitsFulfilment).length > 0 ? "danger" : "good",
          },
          {
            label: "Pending pay",
            value: sales.filter((s) => s.status === "confirmed").length,
            tone: sales.filter((s) => s.status === "confirmed").length > 0 ? "danger" : "good",
          },
          {
            label: "Paid",
            value: sales.filter((s) => s.status === "paid").length,
          },
          {
            label: "Delivered",
            value: sales.filter((s) => s.status === "delivered").length,
          },
          {
            label: "Cancelled",
            value: sales.filter((s) => s.status === "cancelled").length,
          },
        ]}
      />

      <div className="toolbar ed-rise">
        <span className="toolbar__search">
          <Search />
          <input
            className="input"
            type="search"
            placeholder="Search order number…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </span>
        <span className="toolbar__spacer" />
        <button
          type="button"
          className={onlyAwaiting ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
          onClick={() => setOnlyAwaiting((v) => !v)}
        >
          Awaiting fulfilment
        </button>
        <select
          className="select"
          value={branchFilter}
          onChange={(e) => setBranchFilter(e.target.value)}
        >
          <option value="all">All branches</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="all">All statuses</option>
          <option value="confirmed">Pending pay</option>
          <option value="paid">Paid</option>
          <option value="handed_over">Handed over</option>
          <option value="delivered">Delivered</option>
          <option value="cancelled">Cancelled</option>
          <option value="failed">Failed</option>
        </select>
        <select
          className="select"
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
        >
          <option value="all">All channels</option>
          {channels.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>
          {filtered.length} of {sales.length}
        </span>
      </div>

      

        {loading ? (
          <InlineLoader />
        ) : filtered.length === 0 ? (
          <div className="empty">
            <div className="empty__title">No matches</div>
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              onClick={() => {
                setBranchFilter("all");
                setStatusFilter("all");
                setChannelFilter("all");
                setQ("");
              }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Date</th>
                  <th>Branch</th>
                  <th>Channel</th>
                  <th className="table__num">Total</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 600 }}>{s.orderNumber}</td>
                    <td>{formatDateTime(s.createdAtLocal)}</td>
                    <td>{branchName(s.branchId)}</td>
                    <td style={{ color: "var(--ink-soft)" }}>{s.channel}</td>
                    <td className="table__num" style={{ fontWeight: 700 }}>
                      {ngn(s.totalNgn)}
                    </td>
                    <td>
                      {statusPill(s.status)}
                      {s.scheduledDeliveryAt && (
                        <span className="pill pill--warning" style={{ marginLeft: 6 }}>
                          Scheduled
                        </span>
                      )}
                      {s.deliveryState && s.deliveryState !== "Lagos" && (
                        <span className="pill pill--warning" style={{ marginLeft: 6 }}>
                          {s.deliveryState}
                        </span>
                      )}
                    </td>
                    <td className="table__num">
                      <Link
                        to="/owner/orders/$saleId"
                        params={{ saleId: s.id }}
                        className="pill pill--ink"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > 200 && (
              <p style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 12 }}>
                Showing first 200 of {filtered.length}. Use filters to narrow down.
              </p>
            )}
          </div>
        )}
    </Shell>
  );
}

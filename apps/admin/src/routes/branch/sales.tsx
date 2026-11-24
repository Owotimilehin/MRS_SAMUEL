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
import { Search } from "lucide-react";
import { local } from "../../db/local.js";
import { isValidSalesSearch, parseReceiptCode, receiptCodeFromSaleId } from "../../lib/receipt-code.js";

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

  // Find one sale by its SO-… order number (or the tail of it) or the R-code
  // printed on a receipt before the sale synced. Searched on the server so it
  // reaches past the 200 most recent rows.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Sale[] | null>(null);
  const [searching, setSearching] = useState(false);
  // A receipt code that matches a sale still waiting on THIS till to sync.
  const [localOnly, setLocalOnly] = useState<string | null>(null);
  const trimmedQuery = query.trim();
  const queryValid = isValidSalesSearch(trimmedQuery);
  useEffect(() => {
    setLocalOnly(null);
    if (!trimmedQuery || !queryValid) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      setSearching(true);
      void (async () => {
        try {
          const res = await api<{ data: Sale[] }>(
            `/branches/${branchId}/sales?q=${encodeURIComponent(trimmedQuery)}`,
          );
          if (cancelled) return;
          setResults(res.data);
          const prefix = parseReceiptCode(trimmedQuery);
          if (res.data.length === 0 && prefix) {
            const pending = await local.sales.filter((s) => s.id.startsWith(prefix)).first();
            if (!cancelled && pending) setLocalOnly(receiptCodeFromSaleId(pending.id));
          }
        } catch (err) {
          if (!cancelled) {
            setResults([]);
            toast.error(humanizeError(err));
          }
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [branchId, trimmedQuery, queryValid]);

  const today = todayDate();
  const todaysSales = sales.filter((s) => s.createdAtLocal.slice(0, 10) === today);
  const awaitingList = sales.filter(awaitsFulfilment);
  const list =
    results ?? (filter === "today" ? todaysSales : filter === "awaiting" ? awaitingList : sales);

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

      <div className="toolbar__search" style={{ marginBottom: 6 }}>
        <Search aria-hidden />
        <input
          className="input"
          type="search"
          aria-label="Find a sale by order number or receipt code"
          placeholder="Find a sale: SO-2026-00123 or R-1A2B3C4D"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <p style={{ fontSize: 12, margin: "0 0 12px", color: trimmedQuery && !queryValid ? "var(--danger)" : "var(--ink-soft)" }}>
        {trimmedQuery && !queryValid
          ? "Type an order number (like SO-2026-00123) or a receipt code (R- and 8 letters or numbers)."
          : searching
            ? "Searching…"
            : results
              ? `${results.length} ${results.length === 1 ? "match" : "matches"} for “${trimmedQuery}”. Clear the box to see the list again.`
              : "The receipt code is on the customer's receipt if the sale was rung up offline."}
      </p>
      {localOnly && (
        <div className="card card--soft" role="status" style={{ marginBottom: 12, fontSize: 14 }}>
          <strong>{localOnly}</strong> is saved on this till but hasn't reached the system yet. It
          will show here once it syncs. If it doesn't, check the Sync queue on the Device page.
        </div>
      )}

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
      ) : list.length === 0 && results ? (
        <div className="empty">
          <div className="empty__title">No sale found</div>
          Check the number on the receipt and try again.
        </div>
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
                    <div className="tabular-nums" style={{ fontSize: 11, color: "var(--ink-soft)" }}>
                      Receipt {receiptCodeFromSaleId(s.id)}
                    </div>
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

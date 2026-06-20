import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import { local } from "../../db/local.js";
import { api } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import { fileLocalShiftClose } from "../../sync/local-shift-open.js";
import type { StatChip } from "../../components/StatHero.js";

interface TransferSale {
  order_number: string;
  channel: string;
  status: string;
  total_ngn: number;
  created_at_local: string;
}

interface PreviewBody {
  data: {
    // `expected_cash_ngn` / `cash_sales` keep their historical names on the wire,
    // but now hold the transfer figures (the till books every sale as transfer).
    expected_cash_ngn: number;
    expected_stock: Record<string, number>;
    cash_sales: TransferSale[];
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function BranchClosePage({ branchId }: { branchId: string }): JSX.Element {
  const products = useLiveQuery(() => local.products.toArray(), [], []);
  const [businessDate, setBusinessDate] = useState(today());
  const [preview, setPreview] = useState<PreviewBody["data"] | null>(null);
  const [transfers, setTransfers] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // null = loading, true/false from hasOpenShift
  const [hasShift, setHasShift] = useState<boolean | null>(null);
  // true after a successful close — shows the "Shift closed" confirmation.
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { hasOpenShift } = await import("../../sync/local-shift-open.js");
      const v = await hasOpenShift(branchId);
      if (!cancelled) setHasShift(v);
    })();
    return () => { cancelled = true; };
  }, [branchId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<PreviewBody>(
          `/branches/${branchId}/daily-close/preview?date=${businessDate}`,
        );
        if (!cancelled) {
          setPreview(res.data);
          const init: Record<string, string> = {};
          for (const [pid, qty] of Object.entries(res.data.expected_stock)) {
            init[pid] = String(qty);
          }
          setCounts(init);
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
  }, [branchId, businessDate]);

  const productName = (id: string): string =>
    (products as Array<{ id: string; name: string }>).find((p) => p.id === id)?.name ??
    id.slice(0, 8);

  const expectedCash = preview?.expected_cash_ngn ?? 0;
  const transferSales = preview?.cash_sales ?? [];
  const [showSales, setShowSales] = useState(false);
  const counted = Number(transfers) || 0;
  const variance = counted - expectedCash;

  const stockRows = useMemo(() => {
    if (!preview) return [];
    return Object.keys(preview.expected_stock).map((pid) => {
      const expected = preview.expected_stock[pid] ?? 0;
      const got = Number(counts[pid] ?? "0");
      return {
        product_id: pid,
        name: productName(pid),
        expected,
        counted: got,
        variance: got - expected,
        reason: reasons[pid] ?? "",
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, counts, reasons, products]);

  async function submit(): Promise<void> {
    if (!preview) return;
    setSubmitting(true);
    try {
      // Server requires variance_reason on lines that don't match
      const missing = stockRows.find((r) => r.variance !== 0 && !r.reason);
      if (missing) {
        throw new Error(`Pick a reason for ${missing.name}.`);
      }
      // Online-only: close is a direct POST (no outbox). If offline the call
      // throws, the user sees an error, and local state stays "open" — no silent
      // split between local and server. We only flip local to "closed" AFTER a
      // confirmed 2xx so the till gate stays accurate.
      await api(`/branches/${branchId}/daily-close`, {
        method: "POST",
        body: JSON.stringify({
          business_date: businessDate,
          cash_counted_ngn: 0,
          transfers_counted_ngn: Number(transfers) || 0,
          notes: notes || undefined,
          stock_counts: stockRows.map((r) => ({
            product_id: r.product_id,
            counted_quantity: r.counted,
            variance_reason: r.variance !== 0 ? r.reason : undefined,
          })),
        }),
      });
      // Server confirmed: flip local gate so Sell shows the reopen prompt.
      await fileLocalShiftClose(branchId);
      setClosed(true);
      setHasShift(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const closeChips: StatChip[] = [
    { label: "Expected ₦", value: ngn(expectedCash) },
    { label: "Counted ₦", value: ngn(counted) },
  ];
  if (variance !== 0) {
    closeChips.push({ label: "Variance ₦", value: `${variance > 0 ? "+" : ""}${ngn(variance)}`, tone: "warn" });
  } else {
    closeChips.push({ label: "Variance ₦", value: ngn(0), tone: "good" });
  }

  // "Shift closed" confirmation — shown after a successful close.
  if (closed) {
    return (
      <BranchShell branchId={branchId} title="Shift end">
        <section className="card" style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
          <h2 className="t-h2" style={{ marginBottom: 8 }}>Shift closed</h2>
          <p style={{ color: "var(--ink-soft)", margin: "0 0 24px" }}>
            The shift-end report has been submitted and is awaiting owner approval.
          </p>
          <a className="btn btn--primary btn--lg" href="/branch/shift-start">
            Open a new shift
          </a>
        </section>
      </BranchShell>
    );
  }

  // No open shift — block the form.
  if (hasShift === false) {
    return (
      <BranchShell branchId={branchId} title="Shift end">
        <section className="card" style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🌅</div>
          <h2 className="t-h2" style={{ marginBottom: 8 }}>No open shift</h2>
          <p style={{ color: "var(--ink-soft)", margin: "0 0 24px" }}>
            There is no open shift to close. Start a new shift first.
          </p>
          <a className="btn btn--primary btn--lg" href="/branch/shift-start">
            Open a shift
          </a>
        </section>
      </BranchShell>
    );
  }

  return (
    <BranchShell branchId={branchId} title="Shift end">
      <StatHero
        eyebrow="Branch"
        title="Shift end"
        sub="Enter stock counts and cash on hand to close out your shift."
        loading={loading || hasShift === null}
        chips={closeChips}
      />

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18 }}>
        <section className="card">
          <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
            <h2 className="t-h2">Stock count</h2>
            <div className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <label className="field__label" style={{ marginBottom: 0 }}>Date</label>
              <input
                className="input"
                type="date"
                style={{ width: 160 }}
                value={businessDate}
                onChange={(e) => setBusinessDate(e.target.value)}
              />
            </div>
          </header>
          {loading ? (
            <InlineLoader />
          ) : stockRows.length === 0 ? (
            <div className="empty">No products in scope.</div>
          ) : (
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="table__num">Expected</th>
                    <th className="table__num">Counted</th>
                    <th className="table__num">Variance</th>
                    <th>Reason (if variance)</th>
                  </tr>
                </thead>
                <tbody>
                  {stockRows.map((r) => (
                    <tr key={r.product_id}>
                      <td>{r.name}</td>
                      <td className="table__num">{r.expected}</td>
                      <td>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          style={{ width: 80, textAlign: "right" }}
                          value={counts[r.product_id] ?? ""}
                          onChange={(e) =>
                            setCounts((s) => ({ ...s, [r.product_id]: e.target.value }))
                          }
                        />
                      </td>
                      <td
                        className="table__num"
                        style={{
                          fontWeight: 700,
                          color:
                            r.variance < 0
                              ? "var(--danger)"
                              : r.variance > 0
                                ? "var(--warning)"
                                : "var(--ink-soft)",
                        }}
                      >
                        {r.variance > 0 ? "+" : ""}
                        {r.variance}
                      </td>
                      <td>
                        {r.variance !== 0 ? (
                          <input
                            className="input"
                            placeholder="Required"
                            value={r.reason}
                            onChange={(e) =>
                              setReasons((s) => ({ ...s, [r.product_id]: e.target.value }))
                            }
                          />
                        ) : (
                          <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 className="t-h2">Transfer reconcile</h2>
          <div className="field">
            <label className="field__label">Bank transfers received (₦)</label>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              value={transfers}
              onChange={(e) => setTransfers(e.target.value)}
              placeholder="0"
            />
          </div>

          <div className="card card--soft" style={{ padding: 12 }}>
            <Row label="System expected" value={ngn(expectedCash)} />
            <div style={{ marginTop: -2, marginBottom: 4 }}>
              {transferSales.length === 0 ? (
                <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                  No transfer sales recorded today.
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowSales((s) => !s)}
                  style={{
                    background: "transparent",
                    border: 0,
                    padding: 0,
                    cursor: "pointer",
                    fontSize: 12,
                    color: "var(--accent)",
                    fontWeight: 600,
                  }}
                >
                  {showSales ? "Hide" : "Show"} {transferSales.length} transfer{" "}
                  {transferSales.length === 1 ? "sale" : "sales"} →
                </button>
              )}
              {showSales && transferSales.length > 0 && (
                <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", fontSize: 12 }}>
                  {transferSales.map((s) => (
                    <li
                      key={s.order_number}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "3px 0",
                        borderTop: "1px solid var(--line)",
                        color: "var(--ink-soft)",
                      }}
                    >
                      <span>
                        {s.order_number}
                        <span style={{ opacity: 0.7 }}> · {s.channel}</span>
                      </span>
                      <span className="tabular-nums">{ngn(s.total_ngn)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Row label="You counted" value={ngn(counted)} />
            <Row
              label="Variance"
              value={`${variance > 0 ? "+" : ""}${ngn(variance)}`}
              emphasis
              tone={variance < 0 ? "danger" : variance > 0 ? "warning" : "default"}
            />
          </div>

          <div className="field">
            <label className="field__label">Notes</label>
            <textarea
              className="textarea"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the owner should see"
            />
          </div>

          <button
            type="button"
            className="btn btn--primary btn--block btn--lg"
            disabled={submitting || loading || !preview || hasShift !== true}
            onClick={() => void submit()}
          >
            {submitting ? "Submitting…" : "Submit close for approval"}
          </button>
        </aside>
      </div>
    </BranchShell>
  );
}

function Row({
  label,
  value,
  emphasis,
  tone = "default",
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  tone?: "default" | "warning" | "danger";
}): JSX.Element {
  const color =
    tone === "danger" ? "var(--danger)" : tone === "warning" ? "var(--warning)" : "var(--ink)";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        padding: "5px 0",
        borderTop: emphasis ? "1px solid var(--line)" : "none",
        marginTop: emphasis ? 4 : 0,
      }}
    >
      <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>{label}</span>
      <span
        className="tabular-nums"
        style={{ fontWeight: emphasis ? 800 : 700, color, fontSize: emphasis ? 18 : 15 }}
      >
        {value}
      </span>
    </div>
  );
}

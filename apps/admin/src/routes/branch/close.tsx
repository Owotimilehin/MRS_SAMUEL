import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import { local } from "../../db/local.js";
import { api } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

interface PreviewBody {
  data: {
    expected_cash_ngn: number;
    expected_stock: Record<string, number>;
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function BranchClosePage({ branchId }: { branchId: string }): JSX.Element {
  const products = useLiveQuery(() => local.products.toArray(), [], []);
  const [businessDate, setBusinessDate] = useState(today());
  const [preview, setPreview] = useState<PreviewBody["data"] | null>(null);
  const [cash, setCash] = useState("");
  const [transfers, setTransfers] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
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
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
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
  const counted = (Number(cash) || 0) + (Number(transfers) || 0);
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
    setError(null);
    try {
      // Server requires variance_reason on lines that don't match
      const missing = stockRows.find((r) => r.variance !== 0 && !r.reason);
      if (missing) {
        throw new Error(`Pick a reason for ${missing.name}.`);
      }
      await api(`/branches/${branchId}/daily-close`, {
        method: "POST",
        body: JSON.stringify({
          business_date: businessDate,
          cash_counted_ngn: Number(cash) || 0,
          transfers_counted_ngn: Number(transfers) || 0,
          notes: notes || undefined,
          stock_counts: stockRows.map((r) => ({
            product_id: r.product_id,
            counted_quantity: r.counted,
            variance_reason: r.variance !== 0 ? r.reason : undefined,
          })),
        }),
      });
      setFlash("Daily close submitted. Awaiting owner approval.");
      setCash("");
      setTransfers("");
      setNotes("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <BranchShell branchId={branchId} title="Daily close">
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
      {error && (
        <div
          className="card"
          style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}
        >
          {error}
        </div>
      )}

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
          <h2 className="t-h2">Cash reconcile</h2>
          <div className="field">
            <label className="field__label">Cash on hand (₦)</label>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              value={cash}
              onChange={(e) => setCash(e.target.value)}
              placeholder="0"
            />
          </div>
          <div className="field">
            <label className="field__label">Bank transfers counted (₦)</label>
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
            disabled={submitting || loading || !preview}
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

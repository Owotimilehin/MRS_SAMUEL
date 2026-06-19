import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import { local } from "../../db/local.js";
import { api } from "../../lib/api.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import { fileLocalShiftOpen } from "../../sync/local-shift-open.js";
import { lagosToday } from "../../lib/biz-date.js";

interface PreviewBody { data: { expected_stock: Record<string, number> }; }

export function BranchShiftStartPage({ branchId }: { branchId: string }): JSX.Element {
  const products = useLiveQuery(() => local.products.toArray(), [], []);
  const businessDate = lagosToday();
  const [expected, setExpected] = useState<Record<string, number> | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await api<PreviewBody>(`/branches/${branchId}/shift-open/preview`);
        if (!cancelled) {
          setExpected(res.data.expected_stock);
          const init: Record<string, string> = {};
          for (const [pid, qty] of Object.entries(res.data.expected_stock)) init[pid] = String(qty);
          setCounts(init);
        }
      } catch (err) {
        // Offline: fall back to an empty grid so she can still count + unlock.
        if (!cancelled) setExpected({});
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [branchId]);

  const productName = (id: string): string =>
    (products as Array<{ id: string; name: string }>).find((p) => p.id === id)?.name ?? id.slice(0, 8);

  const rows = useMemo(() => {
    if (!expected) return [];
    return Object.keys(expected).map((pid) => {
      const exp = expected[pid] ?? 0;
      const got = Number(counts[pid] ?? "0");
      return { product_id: pid, name: productName(pid), expected: exp, counted: got, variance: got - exp, reason: reasons[pid] ?? "" };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expected, counts, reasons, products]);

  async function submit(): Promise<void> {
    if (!expected) return;
    setSubmitting(true);
    try {
      const missing = rows.find((r) => r.variance !== 0 && !r.reason);
      if (missing) throw new Error(`Pick a reason for ${missing.name}.`);
      await fileLocalShiftOpen({
        branchId,
        businessDate,
        notes: notes || undefined,
        stockCounts: rows.map((r) => ({
          product_id: r.product_id,
          counted_quantity: r.counted,
          variance_reason: r.variance !== 0 ? r.reason : undefined,
        })),
      });
      toast.success("Opening stock confirmed. Your till is unlocked.");
      window.location.href = `/branch/sell`;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <BranchShell branchId={branchId} title="Shift start">
      <StatHero
        eyebrow="Branch"
        title="Shift start"
        sub="Count the stock you're starting with. This unlocks your till."
        loading={loading}
        chips={[{ label: "Date", value: businessDate }]}
      />
      <section className="card">
        <h2 className="t-h2" style={{ marginBottom: 12 }}>Opening stock count</h2>
        {loading ? (
          <InlineLoader />
        ) : rows.length === 0 ? (
          <div className="empty">No products to count — you can confirm to open.</div>
        ) : (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="table__num">System</th>
                  <th className="table__num">Counted</th>
                  <th className="table__num">Variance</th>
                  <th>Reason (if variance)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.product_id}>
                    <td>{r.name}</td>
                    <td className="table__num">{r.expected}</td>
                    <td>
                      <input
                        className="input" type="number" min={0}
                        style={{ width: 80, textAlign: "right" }}
                        value={counts[r.product_id] ?? ""}
                        onChange={(e) => setCounts((s) => ({ ...s, [r.product_id]: e.target.value }))}
                      />
                    </td>
                    <td className="table__num" style={{ fontWeight: 700, color: r.variance < 0 ? "var(--danger)" : r.variance > 0 ? "var(--warning)" : "var(--ink-soft)" }}>
                      {r.variance > 0 ? "+" : ""}{r.variance}
                    </td>
                    <td>
                      {r.variance !== 0 ? (
                        <input
                          className="input" placeholder="Required"
                          value={r.reason}
                          onChange={(e) => setReasons((s) => ({ ...s, [r.product_id]: e.target.value }))}
                        />
                      ) : (<span style={{ color: "var(--ink-soft)", fontSize: 13 }}>—</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="field" style={{ marginTop: 12 }}>
          <label className="field__label">Notes</label>
          <textarea className="textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything the owner should see" />
        </div>
        <button
          type="button" className="btn btn--primary btn--block btn--lg"
          disabled={submitting || loading || !expected}
          onClick={() => void submit()}
        >
          {submitting ? "Confirming…" : "Confirm opening stock"}
        </button>
      </section>
    </BranchShell>
  );
}

import { useEffect, useState } from "react";
import { BranchShell } from "../../components/BranchShell.js";
import { api, ApiError } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";

interface BranchClosePageProps {
  branchId: string;
}

interface Preview {
  expected_cash_ngn: number;
  expected_stock: Record<string, number>;
}

interface ProductRow {
  id: string;
  name: string;
}

interface CountedRow {
  productId: string;
  counted: number;
  reason: string;
}

interface CloseRow {
  id: string;
  status: string;
  varianceNgn: number;
  businessDate: string;
}

export function BranchClosePage({ branchId }: BranchClosePageProps): JSX.Element {
  const today = new Date().toISOString().slice(0, 10);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [counts, setCounts] = useState<Record<string, CountedRow>>({});
  const [cashCounted, setCashCounted] = useState(0);
  const [transfersCounted, setTransfersCounted] = useState(0);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<CloseRow | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [prevRes, prodRes] = await Promise.all([
          api<{ data: Preview }>(`/branches/${branchId}/daily-close/preview?date=${today}`),
          api<{ data: ProductRow[] }>("/products"),
        ]);
        setPreview(prevRes.data);
        setProducts(prodRes.data);
        const seeded: Record<string, CountedRow> = {};
        for (const p of prodRes.data) {
          seeded[p.id] = {
            productId: p.id,
            counted: prevRes.data.expected_stock[p.id] ?? 0,
            reason: "",
          };
        }
        setCounts(seeded);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [branchId, today]);

  const variance =
    preview === null ? 0 : cashCounted + transfersCounted - preview.expected_cash_ngn;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const stockCounts = Object.values(counts).map((c) => ({
        product_id: c.productId,
        counted_quantity: c.counted,
        variance_reason: c.reason || undefined,
      }));
      const res = await api<{ data: CloseRow }>(
        `/branches/${branchId}/daily-close`,
        {
          method: "POST",
          body: JSON.stringify({
            business_date: today,
            cash_counted_ngn: cashCounted,
            transfers_counted_ngn: transfersCounted,
            notes: notes || undefined,
            stock_counts: stockCounts,
          }),
        },
      );
      setSubmitted(res.data);
    } catch (err) {
      if (err instanceof ApiError) setError(`${err.code}: ${err.message}`);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BranchShell branchId={branchId} title={`Daily close · ${today}`}>
      <div className="max-w-3xl flex flex-col gap-6">
        {error && (
          <div
            className="p-3 rounded-md text-sm"
            style={{ background: "rgba(198,58,46,0.12)", color: "var(--ms-danger)" }}
          >
            {error}
          </div>
        )}

        {submitted && (
          <div
            className="p-4 rounded-md text-sm"
            style={{ background: "var(--ms-green-100)", color: "var(--ms-green-900)" }}
          >
            <strong>Submitted for owner review.</strong> Variance:{" "}
            <span className="tabular-nums">{ngn(submitted.varianceNgn)}</span>
          </div>
        )}

        <section
          className="p-5 rounded-xl flex flex-col gap-4"
          style={{ background: "var(--ms-surface)", border: "1px solid var(--ms-border)" }}
        >
          <h2 className="font-display text-lg font-bold">Cash up</h2>
          {preview && (
            <div className="text-sm" style={{ color: "var(--ms-ink-2)" }}>
              System expects{" "}
              <strong className="tabular-nums">{ngn(preview.expected_cash_ngn)}</strong> in
              cash today.
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs flex flex-col gap-1">
              Cash counted (₦)
              <input
                type="number"
                value={cashCounted}
                onChange={(e) => setCashCounted(Number(e.target.value))}
                className="px-3 py-2 rounded-md border text-sm tabular-nums"
                style={{ borderColor: "var(--ms-border)" }}
              />
            </label>
            <label className="text-xs flex flex-col gap-1">
              Transfers counted (₦)
              <input
                type="number"
                value={transfersCounted}
                onChange={(e) => setTransfersCounted(Number(e.target.value))}
                className="px-3 py-2 rounded-md border text-sm tabular-nums"
                style={{ borderColor: "var(--ms-border)" }}
              />
            </label>
          </div>
          <div className="text-sm">
            Variance:{" "}
            <strong
              className="tabular-nums"
              style={{
                color:
                  variance === 0
                    ? "var(--ms-green-900)"
                    : Math.abs(variance) < 200
                      ? "#7a5a0a"
                      : "var(--ms-danger)",
              }}
            >
              {ngn(variance)}
            </strong>
          </div>
        </section>

        <section
          className="p-5 rounded-xl flex flex-col gap-4"
          style={{ background: "var(--ms-surface)", border: "1px solid var(--ms-border)" }}
        >
          <h2 className="font-display text-lg font-bold">Stock count</h2>
          <table className="w-full text-sm">
            <thead style={{ background: "var(--ms-surface-alt)" }}>
              <tr>
                <th className="text-left px-3 py-2 text-xs uppercase tracking-wide font-semibold">
                  Product
                </th>
                <th className="text-right px-3 py-2 text-xs uppercase tracking-wide font-semibold">
                  Expected
                </th>
                <th className="text-right px-3 py-2 text-xs uppercase tracking-wide font-semibold">
                  Counted
                </th>
                <th className="text-right px-3 py-2 text-xs uppercase tracking-wide font-semibold">
                  Variance
                </th>
                <th className="text-left px-3 py-2 text-xs uppercase tracking-wide font-semibold">
                  Reason
                </th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const expected = preview?.expected_stock[p.id] ?? 0;
                const c = counts[p.id];
                if (!c) return null;
                const v = c.counted - expected;
                return (
                  <tr key={p.id} style={{ borderTop: "1px solid var(--ms-divider)" }}>
                    <td className="px-3 py-2">{p.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{expected}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        value={c.counted}
                        onChange={(e) =>
                          setCounts((prev) => ({
                            ...prev,
                            [p.id]: { ...c, counted: Number(e.target.value) },
                          }))
                        }
                        className="w-20 px-2 py-1 rounded border text-sm text-right tabular-nums"
                        style={{ borderColor: "var(--ms-border)" }}
                      />
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums"
                      style={{
                        color: v === 0 ? "var(--ms-ink-2)" : "var(--ms-danger)",
                      }}
                    >
                      {v > 0 ? `+${v}` : v}
                    </td>
                    <td className="px-3 py-2">
                      {v !== 0 && (
                        <input
                          type="text"
                          value={c.reason}
                          onChange={(e) =>
                            setCounts((prev) => ({
                              ...prev,
                              [p.id]: { ...c, reason: e.target.value },
                            }))
                          }
                          placeholder="Why?"
                          className="w-full px-2 py-1 rounded border text-xs"
                          style={{ borderColor: "var(--ms-border)" }}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <label className="text-xs flex flex-col gap-1">
          Manager notes (optional)
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="px-3 py-2 rounded-md border text-sm"
            style={{ borderColor: "var(--ms-border)" }}
          />
        </label>

        <div className="flex justify-end">
          <button
            type="button"
            disabled={busy || !preview}
            onClick={() => void submit()}
            className="px-6 py-2 rounded-md text-sm font-semibold disabled:opacity-50"
            style={{ background: "var(--ms-green-500)", color: "white" }}
          >
            {busy ? "Submitting…" : "Submit for review"}
          </button>
        </div>
      </div>
    </BranchShell>
  );
}

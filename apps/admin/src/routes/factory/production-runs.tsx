import { useEffect, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { formatDate } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

interface Factory {
  id: string;
  name: string;
}
interface Product {
  id: string;
  name: string;
  category: string;
}
interface RunItem {
  product_id: string;
  quantity_produced: number;
  batch_code: string;
}
interface RunSummary {
  id: string;
  factoryId: string;
  runDate: string;
  status: "draft" | "completed";
  createdAt: string;
}

export function ProductionRunsPage(): JSX.Element {
  const [factories, setFactories] = useState<Factory[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [recent, setRecent] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Draft state for the new run
  const [factoryId, setFactoryId] = useState<string>("");
  const [runDate, setRunDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<RunItem[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [f, p] = await Promise.all([
          api<{ data: Factory[] }>(`/factories`),
          api<{ data: Product[] }>(`/products`),
        ]);
        if (cancelled) return;
        setFactories(f.data);
        setProducts(p.data);
        if (f.data[0]) setFactoryId(f.data[0].id);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function addItem(): void {
    const used = new Set(items.map((i) => i.product_id));
    const next = products.find((p) => !used.has(p.id));
    if (!next) return;
    setItems((it) => [...it, { product_id: next.id, quantity_produced: 100, batch_code: "" }]);
  }
  function updateItem(idx: number, patch: Partial<RunItem>): void {
    setItems((it) => it.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }
  function removeItem(idx: number): void {
    setItems((it) => it.filter((_, i) => i !== idx));
  }

  async function submit(e: FormEvent, complete: boolean): Promise<void> {
    e.preventDefault();
    if (!factoryId || items.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await api<{ data: RunSummary }>(`/production-runs`, {
        method: "POST",
        body: JSON.stringify({
          factory_id: factoryId,
          run_date: runDate,
          items: items.map((it) => ({
            product_id: it.product_id,
            quantity_produced: Number(it.quantity_produced),
            batch_code: it.batch_code || undefined,
          })),
          notes: notes || undefined,
        }),
      });
      let final = created.data;
      if (complete) {
        const done = await api<{ data: RunSummary }>(
          `/production-runs/${created.data.id}/complete`,
          { method: "PATCH" },
        );
        final = done.data;
      }
      setRecent((r) => [final, ...r].slice(0, 10));
      setItems([]);
      setNotes("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const productName = (id: string): string => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const factoryName = (id: string): string => factories.find((f) => f.id === id)?.name ?? id.slice(0, 8);

  return (
    <Shell title="Production runs">
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
          <h2 className="t-h2" style={{ marginBottom: 12 }}>Log a production run</h2>
          {loading ? (
            <InlineLoader />
          ) : factories.length === 0 ? (
            <div className="empty">No factories configured. Ask the owner to add one.</div>
          ) : (
            <form
              onSubmit={(e) => void submit(e, false)}
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="field">
                  <label className="field__label">Factory</label>
                  <select
                    className="select"
                    value={factoryId}
                    onChange={(e) => setFactoryId(e.target.value)}
                  >
                    {factories.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field__label">Run date</label>
                  <input
                    className="input"
                    type="date"
                    value={runDate}
                    onChange={(e) => setRunDate(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="field">
                <label className="field__label">Items</label>
                {items.length === 0 ? (
                  <div className="empty" style={{ padding: 18 }}>
                    No items yet.{" "}
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      onClick={addItem}
                      style={{ marginLeft: 6 }}
                    >
                      + Add product
                    </button>
                  </div>
                ) : (
                  <div className="table-wrap" style={{ border: 0 }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th className="table__num">Quantity</th>
                          <th>Batch code</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((it, idx) => (
                          <tr key={idx}>
                            <td>
                              <select
                                className="select"
                                value={it.product_id}
                                onChange={(e) => updateItem(idx, { product_id: e.target.value })}
                              >
                                {products.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <input
                                className="input"
                                type="number"
                                inputMode="numeric"
                                style={{ textAlign: "right" }}
                                value={it.quantity_produced}
                                onChange={(e) =>
                                  updateItem(idx, { quantity_produced: Number(e.target.value) })
                                }
                                min={1}
                              />
                            </td>
                            <td>
                              <input
                                className="input"
                                placeholder="optional"
                                value={it.batch_code}
                                onChange={(e) => updateItem(idx, { batch_code: e.target.value })}
                              />
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <button
                                type="button"
                                onClick={() => removeItem(idx)}
                                aria-label="Remove row"
                                style={{
                                  background: "transparent",
                                  border: 0,
                                  cursor: "pointer",
                                  color: "var(--ink-soft)",
                                  fontSize: 18,
                                }}
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ padding: 10, borderTop: "1px solid var(--line)" }}>
                      <button
                        type="button"
                        className="btn btn--subtle btn--sm"
                        onClick={addItem}
                        disabled={items.length >= products.length}
                      >
                        + Add product
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="field">
                <label className="field__label">Notes</label>
                <textarea
                  className="textarea"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Anything operations should know"
                />
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="submit"
                  className="btn btn--subtle"
                  disabled={submitting || items.length === 0}
                >
                  {submitting ? "Saving…" : "Save as draft"}
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={submitting || items.length === 0}
                  onClick={(e) => void submit(e as unknown as FormEvent, true)}
                >
                  {submitting ? "Completing…" : "Save & complete"}
                </button>
              </div>
            </form>
          )}
        </section>

        <section className="card">
          <h2 className="t-h2" style={{ marginBottom: 12 }}>Recently created</h2>
          {recent.length === 0 ? (
            <div className="empty">
              Runs created in this session will appear here so you can quickly mark them completed.
            </div>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
              {recent.map((r) => (
                <li
                  key={r.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    padding: 12,
                    background: "var(--surface-soft)",
                    borderRadius: 12,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <Link
                      to="/factory/production-runs/$runId"
                      params={{ runId: r.id }}
                      style={{ fontWeight: 600, color: "var(--ink)" }}
                    >
                      {formatDate(r.runDate)}
                    </Link>
                    <span
                      className={r.status === "completed" ? "pill pill--success" : "pill pill--warning"}
                    >
                      {r.status}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                    {factoryName(r.factoryId)} · {r.id.slice(0, 8)}
                  </div>
                  {r.status === "draft" && (
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      style={{ alignSelf: "flex-start", marginTop: 4 }}
                      onClick={async () => {
                        try {
                          const done = await api<{ data: RunSummary }>(
                            `/production-runs/${r.id}/complete`,
                            { method: "PATCH" },
                          );
                          setRecent((rs) =>
                            rs.map((row) => (row.id === r.id ? done.data : row)),
                          );
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      Complete run
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 14 }}>
            Tip — completing a run posts the produced quantities into the factory ledger.
          </p>
        </section>
      </div>

      <div style={{ display: "none" }}>{productName("")}</div>
    </Shell>
  );
}

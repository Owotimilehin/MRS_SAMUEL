import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { formatDate } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

interface Factory { id: string; name: string }
interface Product { id: string; name: string; category: string }
interface Variant { id: string; size_ml: number | null; sku?: string | null }
interface RunItem {
  id: string;
  productId: string;
  quantityProduced: number;
  batchCode: string | null;
}
interface Run {
  id: string;
  factoryId: string;
  runDate: string;
  status: "draft" | "completed";
  createdAt: string;
  notes: string | null;
  items: RunItem[];
}

export function ProductionRunsPage(): JSX.Element {
  const [factories, setFactories] = useState<Factory[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [factoryId, setFactoryId] = useState<string>("");
  const [runDate, setRunDate] = useState(new Date().toISOString().slice(0, 10));
  const [run, setRun] = useState<Run | null>(null);
  const [history, setHistory] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [variantsByProduct, setVariantsByProduct] = useState<Record<string, Variant[]>>({});
  const [draftRow, setDraftRow] = useState<{ productId: string; variantId: string; qty: number; batch: string }>({
    productId: "",
    variantId: "",
    qty: 50,
    batch: "",
  });

  // Fetch variants for a product on demand and cache. Used when the factory
  // picks a flavour from the dropdown.
  async function ensureVariants(productId: string): Promise<Variant[]> {
    if (variantsByProduct[productId]) return variantsByProduct[productId]!;
    try {
      const res = await api<{ data: { variants?: Variant[] } }>(`/products/${productId}`);
      const list = res.data.variants ?? [];
      setVariantsByProduct((s) => ({ ...s, [productId]: list }));
      return list;
    } catch {
      return [];
    }
  }

  // Bootstrap factories + products
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
        const firstProduct = p.data[0];
        if (firstProduct) {
          setDraftRow((d) => ({ ...d, productId: firstProduct.id }));
          // Pre-load variants for the first product so the Size dropdown
          // is populated immediately.
          void ensureVariants(firstProduct.id).then((vs) => {
            const first = vs[0];
            if (first) setDraftRow((d) => (d.productId === firstProduct.id && !d.variantId ? { ...d, variantId: first.id } : d));
          });
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Resume / refresh today's open draft whenever factory or date changes
  useEffect(() => {
    if (!factoryId || !runDate) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ data: Run | null }>(
          `/production-runs/open?factory_id=${factoryId}&run_date=${runDate}`,
        );
        if (!cancelled) setRun(res.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [factoryId, runDate]);

  // Load the run history for the selected factory.
  async function loadHistory(): Promise<void> {
    if (!factoryId) return;
    try {
      const res = await api<{ data: Run[] }>(
        `/production-runs?factory_id=${factoryId}&limit=50`,
      );
      setHistory(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factoryId]);

  async function startDraft(): Promise<void> {
    if (!factoryId) return;
    setBusy(true); setError(null);
    try {
      const res = await api<{ data: Run }>(`/production-runs`, {
        method: "POST",
        body: JSON.stringify({ factory_id: factoryId, run_date: runDate }),
      });
      setRun(res.data);
      setFlash("Draft started — add flavours as each batch is done");
      setTimeout(() => setFlash(null), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function appendItem(): Promise<void> {
    if (!run || !draftRow.productId || draftRow.qty <= 0) return;
    setBusy(true); setError(null);
    try {
      const res = await api<{ data: Run }>(`/production-runs/${run.id}/items`, {
        method: "POST",
        body: JSON.stringify({
          items: [{
            product_id: draftRow.productId,
            variant_id: draftRow.variantId || undefined,
            quantity_produced: Number(draftRow.qty),
            batch_code: draftRow.batch || undefined,
          }],
        }),
      });
      setRun(res.data);
      setDraftRow((d) => ({ ...d, qty: 50, batch: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function patchItem(itemId: string, patch: { quantity_produced?: number; batch_code?: string | null }): Promise<void> {
    if (!run) return;
    setBusy(true); setError(null);
    try {
      await api(`/production-runs/${run.id}/items/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      const res = await api<{ data: Run | null }>(
        `/production-runs/open?factory_id=${factoryId}&run_date=${runDate}`,
      );
      setRun(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function deleteItem(itemId: string): Promise<void> {
    if (!run) return;
    if (!confirm("Remove this flavour from the run?")) return;
    setBusy(true); setError(null);
    try {
      await api(`/production-runs/${run.id}/items/${itemId}`, { method: "DELETE" });
      setRun((r) => (r ? { ...r, items: r.items.filter((i) => i.id !== itemId) } : r));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  async function completeRun(): Promise<void> {
    if (!run) return;
    setBusy(true); setError(null);
    try {
      const done = await api<{ data: Run }>(`/production-runs/${run.id}/complete`, { method: "PATCH" });
      // Merge so `items` survives even if the API ever omits it — guards the
      // render against `run.items` being undefined.
      setRun((r) => (r ? { ...r, ...done.data, items: done.data.items ?? r.items } : done.data));
      void loadHistory();
      setFlash("Run completed — stock posted to factory ledger");
      setTimeout(() => setFlash(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  const productName = (id: string): string =>
    products.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  return (
    <Shell title="Production runs">
      {error && (
        <div className="card" style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}>
          {error}
        </div>
      )}
      {flash && (
        <div className="card" style={{ borderColor: "rgba(16,185,129,0.35)", color: "var(--success)", marginBottom: 16 }}>
          {flash}
        </div>
      )}

      <section className="card" style={{ marginBottom: 18 }}>
        <h2 className="t-h2" style={{ marginBottom: 12 }}>Today's run</h2>
        {loading ? (
          <InlineLoader />
        ) : factories.length === 0 ? (
          <div className="empty">No factories configured. Ask the owner to add one.</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div className="field">
                <label className="field__label">Factory</label>
                <select className="select" value={factoryId} onChange={(e) => setFactoryId(e.target.value)}>
                  {factories.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label className="field__label">Run date</label>
                <input className="input" type="date" value={runDate} onChange={(e) => setRunDate(e.target.value)} />
              </div>
            </div>

            {!run ? (
              <button className="btn btn--primary" disabled={busy || !factoryId} onClick={() => void startDraft()}>
                {busy ? "Starting…" : "Start today's run"}
              </button>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div>
                    <span className={run.status === "completed" ? "pill pill--success" : "pill pill--warning"}>{run.status}</span>
                    <span style={{ marginLeft: 8, color: "var(--ink-soft)", fontSize: 13 }}>
                      {formatDate(run.runDate)} · {run.items.length} flavour{run.items.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {run.status === "draft" && (
                    <button
                      className="btn btn--primary"
                      disabled={busy || run.items.length === 0}
                      onClick={() => void completeRun()}
                    >
                      {busy ? "Completing…" : "Complete run"}
                    </button>
                  )}
                </div>

                {run.items.length > 0 && (
                  <div className="table-wrap" style={{ marginBottom: 12 }}>
                    <table className="table">
                      <thead>
                        <tr><th>Product</th><th className="table__num">Qty</th><th>Batch</th><th /></tr>
                      </thead>
                      <tbody>
                        {run.items.map((it) => (
                          <tr key={it.id}>
                            <td>{productName(it.productId)}</td>
                            <td className="table__num">
                              {run.status === "draft" ? (
                                <input
                                  className="input"
                                  type="number"
                                  defaultValue={it.quantityProduced}
                                  style={{ width: 90, textAlign: "right" }}
                                  onBlur={(e) => {
                                    const v = Number(e.target.value);
                                    if (v > 0 && v !== it.quantityProduced) void patchItem(it.id, { quantity_produced: v });
                                  }}
                                />
                              ) : (it.quantityProduced)}
                            </td>
                            <td>
                              {run.status === "draft" ? (
                                <input
                                  className="input"
                                  defaultValue={it.batchCode ?? ""}
                                  placeholder="optional"
                                  onBlur={(e) => {
                                    const v = e.target.value;
                                    if (v !== (it.batchCode ?? "")) void patchItem(it.id, { batch_code: v || null });
                                  }}
                                />
                              ) : (it.batchCode ?? "—")}
                            </td>
                            <td style={{ textAlign: "right" }}>
                              {run.status === "draft" && (
                                <button
                                  type="button"
                                  aria-label="Remove"
                                  style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--ink-soft)", fontSize: 18 }}
                                  onClick={() => void deleteItem(it.id)}
                                >×</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {run.status === "draft" && (
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
                    <div className="field">
                      <label className="field__label">Add flavour</label>
                      <select
                        className="select"
                        value={draftRow.productId}
                        onChange={(e) => {
                          const pid = e.target.value;
                          setDraftRow((d) => ({ ...d, productId: pid, variantId: "" }));
                          void ensureVariants(pid).then((vs) => {
                            if (vs.length > 0) {
                              const first = vs[0]!;
                              setDraftRow((d) => (d.productId === pid && !d.variantId ? { ...d, variantId: first.id } : d));
                            }
                          });
                        }}
                      >
                        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label className="field__label">Size</label>
                      <select
                        className="select"
                        value={draftRow.variantId}
                        onChange={(e) => setDraftRow((d) => ({ ...d, variantId: e.target.value }))}
                        disabled={!draftRow.productId || (variantsByProduct[draftRow.productId]?.length ?? 0) === 0}
                      >
                        {(variantsByProduct[draftRow.productId] ?? []).length === 0 ? (
                          <option value="">—</option>
                        ) : (
                          (variantsByProduct[draftRow.productId] ?? []).map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.size_ml ? `${v.size_ml}ml` : (v.sku ?? v.id.slice(0, 6))}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    <div className="field">
                      <label className="field__label">Quantity</label>
                      <input
                        className="input" type="number" min={1}
                        value={draftRow.qty}
                        style={{ textAlign: "right" }}
                        onChange={(e) => setDraftRow((d) => ({ ...d, qty: Number(e.target.value) }))}
                      />
                    </div>
                    <div className="field">
                      <label className="field__label">Batch</label>
                      <input className="input" placeholder="optional" value={draftRow.batch} onChange={(e) => setDraftRow((d) => ({ ...d, batch: e.target.value }))} />
                    </div>
                    <button className="btn btn--subtle" disabled={busy || !draftRow.productId || draftRow.qty <= 0} onClick={() => void appendItem()}>
                      {busy ? "…" : "+ Append"}
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>

      <section className="card" style={{ marginBottom: 18 }}>
        <h2 className="t-h2" style={{ marginBottom: 12 }}>Run history</h2>
        {history.length === 0 ? (
          <div className="empty">No runs yet for this factory.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Status</th>
                  <th className="table__num">Flavours</th>
                  <th className="table__num">Bottles</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{formatDate(h.runDate)}</td>
                    <td>
                      <span className={h.status === "completed" ? "pill pill--success" : "pill pill--warning"}>{h.status}</span>
                    </td>
                    <td className="table__num">{h.items.length}</td>
                    <td className="table__num">{h.items.reduce((sum, it) => sum + it.quantityProduced, 0)}</td>
                    <td style={{ textAlign: "right" }}>
                      <Link to="/factory/production-runs/$runId" params={{ runId: h.id }} className="btn btn--subtle btn--sm">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="t-h2" style={{ marginBottom: 8 }}>Tip</h2>
        <p style={{ color: "var(--ink-soft)", margin: 0 }}>
          Append a flavour each time a batch finishes — no need to hold the whole day in your head.
          When the shift ends, hit <em>Complete run</em> and stock posts to the factory ledger.
        </p>
      </section>
    </Shell>
  );
}

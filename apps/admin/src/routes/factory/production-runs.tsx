import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { Stat } from "../../components/Stat.js";
import { api } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";
import { formatDate } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

interface Factory { id: string; name: string }
interface Product { id: string; name: string; category: string }
interface Variant { id: string; size_ml: number | null; sku?: string | null }
interface RunItem {
  id: string;
  productId: string;
  variantId: string | null;
  sizeMl: number | null;
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
interface BottleStock {
  material_id: string;
  name: string;
  size_ml: number | null;
  balance: number;
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
  const [variantsByProduct, setVariantsByProduct] = useState<Record<string, Variant[]>>({});
  const [bottleStock, setBottleStock] = useState<BottleStock[]>([]);
  // The add-flavour form now works batch-first: the factory enters the total
  // volume produced for one flavour, then divides it into per-size bottle
  // counts. `counts` is keyed by variantId. `totalLitres` is the produced
  // volume (a guide/sanity-check — only bottle counts are persisted).
  const [draft, setDraft] = useState<{
    productId: string;
    totalLitres: string;
    counts: Record<string, number>;
    batch: string;
  }>({ productId: "", totalLitres: "", counts: {}, batch: "" });

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
          setDraft((d) => ({ ...d, productId: firstProduct.id }));
          // Pre-load variants so the size allocation rows appear immediately.
          void ensureVariants(firstProduct.id);
        }
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
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
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
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
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factoryId]);

  // Load per-size bottle stock balances for the selected factory.
  useEffect(() => {
    if (!factoryId) { setBottleStock([]); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ data: BottleStock[] }>(`/packaging/stock?factory_id=${factoryId}`);
        if (cancelled) return;
        setBottleStock(
          res.data
            .filter((m) => m.size_ml != null)
            .sort((a, b) => (a.size_ml ?? 0) - (b.size_ml ?? 0)),
        );
      } catch {
        if (!cancelled) setBottleStock([]);
      }
    })();
    return () => { cancelled = true; };
  }, [factoryId]);

  async function startDraft(): Promise<void> {
    if (!factoryId) return;
    setBusy(true);
    try {
      const res = await api<{ data: Run }>(`/production-runs`, {
        method: "POST",
        body: JSON.stringify({ factory_id: factoryId, run_date: runDate }),
      });
      setRun(res.data);
      toast.success("Draft started — add flavours as each batch is done");
    } catch { /* api() already toasted */ } finally { setBusy(false); }
  }

  // Append every size allocated for the chosen flavour in one call. Sizes left
  // at 0 are skipped. The total-volume field is a guide only — what's persisted
  // is the per-size bottle counts.
  async function appendAllocation(): Promise<void> {
    if (!run || !draft.productId) return;
    const items = (variantsByProduct[draft.productId] ?? [])
      .map((v) => ({ v, qty: Number(draft.counts[v.id] ?? 0) }))
      .filter((x) => x.qty > 0)
      .map((x) => ({
        product_id: draft.productId,
        variant_id: x.v.id,
        quantity_produced: x.qty,
        batch_code: draft.batch || undefined,
      }));
    if (items.length === 0) {
      toast.error("Enter at least one bottle count before adding.");
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ data: Run }>(`/production-runs/${run.id}/items`, {
        method: "POST",
        body: JSON.stringify({ items }),
      });
      setRun(res.data);
      setDraft((d) => ({ ...d, totalLitres: "", counts: {}, batch: "" }));
    } catch { /* api() already toasted */ } finally { setBusy(false); }
  }

  async function patchItem(itemId: string, patch: { quantity_produced?: number; batch_code?: string | null }): Promise<void> {
    if (!run) return;
    setBusy(true);
    try {
      await api(`/production-runs/${run.id}/items/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      const res = await api<{ data: Run | null }>(
        `/production-runs/open?factory_id=${factoryId}&run_date=${runDate}`,
      );
      setRun(res.data);
    } catch { /* api() already toasted */ } finally { setBusy(false); }
  }

  async function deleteItem(itemId: string): Promise<void> {
    if (!run) return;
    if (!confirm("Remove this flavour from the run?")) return;
    setBusy(true);
    try {
      await api(`/production-runs/${run.id}/items/${itemId}`, { method: "DELETE" });
      setRun((r) => (r ? { ...r, items: r.items.filter((i) => i.id !== itemId) } : r));
    } catch { /* api() already toasted */ } finally { setBusy(false); }
  }

  async function completeRun(): Promise<void> {
    if (!run) return;
    setBusy(true);
    try {
      const done = await api<{ data: Run }>(`/production-runs/${run.id}/complete`, { method: "PATCH" });
      // Merge so `items` survives even if the API ever omits it — guards the
      // render against `run.items` being undefined.
      setRun((r) => (r ? { ...r, ...done.data, items: done.data.items ?? r.items } : done.data));
      void loadHistory();
      toast.success("Run completed — stock posted to factory ledger");
    } catch { /* api() already toasted */ } finally { setBusy(false); }
  }

  const productName = (id: string): string =>
    products.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const sizeLabel = (ml: number | null): string => (ml ? `${ml}ml` : "—");

  const selectedFactoryName = factories.find((f) => f.id === factoryId)?.name;
  // Only completed runs have actually produced bottles (drafts haven't consumed
  // stock yet), so the card's tile counts completed runs dated today.
  const producedToday = history
    .filter((h) => h.runDate === runDate && h.status === "completed")
    .flatMap((h) => h.items)
    .reduce((sum, it) => sum + it.quantityProduced, 0);

  // Live volume math for the allocation form: bottles × size → litres bottled.
  const draftVariants = variantsByProduct[draft.productId] ?? [];
  const bottledMl = draftVariants.reduce(
    (sum, v) => sum + (v.size_ml ?? 0) * Number(draft.counts[v.id] ?? 0),
    0,
  );
  const bottledL = bottledMl / 1000;
  const totalL = Number(draft.totalLitres) || 0;
  const remainingL = totalL - bottledL;
  const overAllocated = totalL > 0 && remainingL < -1e-9;

  return (
    <Shell title="Production runs">
      <section className="card" style={{ marginBottom: 18 }}>
        <div className="card__head">
          <h2 className="t-h2">Bottle stock{selectedFactoryName ? ` — ${selectedFactoryName}` : ""}</h2>
        </div>
        {bottleStock.length === 0 ? (
          <div className="empty">No bottle stock recorded for this factory yet.</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 14,
            }}
          >
            {bottleStock.map((b) => (
              <Stat key={b.material_id} label={`${b.size_ml}ml bottles`} value={String(b.balance)} />
            ))}
            <Stat label="Produced today" value={String(producedToday)} tone="accent" />
          </div>
        )}
      </section>

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
                        <tr><th>Product</th><th>Size</th><th className="table__num">Qty</th><th>Batch</th><th /></tr>
                      </thead>
                      <tbody>
                        {run.items.map((it) => (
                          <tr key={it.id}>
                            <td>{productName(it.productId)}</td>
                            <td style={{ color: "var(--ink-soft)" }}>{sizeLabel(it.sizeMl)}</td>
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
                  <div className="card" style={{ background: "var(--surface-soft)", padding: 14 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8, alignItems: "end", marginBottom: 12 }}>
                      <div className="field">
                        <label className="field__label">Add flavour</label>
                        <select
                          className="select"
                          value={draft.productId}
                          onChange={(e) => {
                            const pid = e.target.value;
                            setDraft((d) => ({ ...d, productId: pid, counts: {} }));
                            void ensureVariants(pid);
                          }}
                        >
                          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </div>
                      <div className="field">
                        <label className="field__label">Total produced (L)</label>
                        <input
                          className="input" type="number" min={0} step="0.1"
                          placeholder="e.g. 50"
                          value={draft.totalLitres}
                          style={{ textAlign: "right" }}
                          onChange={(e) => setDraft((d) => ({ ...d, totalLitres: e.target.value }))}
                        />
                      </div>
                      <div className="field">
                        <label className="field__label">Batch</label>
                        <input className="input" placeholder="optional" value={draft.batch} onChange={(e) => setDraft((d) => ({ ...d, batch: e.target.value }))} />
                      </div>
                    </div>

                    <label className="field__label" style={{ display: "block", marginBottom: 6 }}>Divide into bottles</label>
                    {draftVariants.length === 0 ? (
                      <div className="empty" style={{ padding: 14 }}>This flavour has no sizes yet.</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {draftVariants.map((v) => {
                          const count = Number(draft.counts[v.id] ?? 0);
                          const litres = ((v.size_ml ?? 0) * count) / 1000;
                          return (
                            <div key={v.id} style={{ display: "grid", gridTemplateColumns: "100px 120px 1fr", gap: 10, alignItems: "center" }}>
                              <span style={{ fontWeight: 600 }}>{v.size_ml ? `${v.size_ml}ml` : (v.sku ?? "—")}</span>
                              <input
                                className="input" type="number" min={0}
                                value={draft.counts[v.id] ?? ""}
                                placeholder="0"
                                style={{ textAlign: "right" }}
                                onChange={(e) =>
                                  setDraft((d) => ({ ...d, counts: { ...d.counts, [v.id]: Math.max(0, Number(e.target.value) || 0) } }))
                                }
                              />
                              <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>{count > 0 ? `= ${litres.toFixed(2)} L` : ""}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Volume reconciliation: how much of the produced total is bottled. */}
                    <div
                      style={{
                        display: "flex", justifyContent: "space-between", alignItems: "baseline",
                        marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)",
                        fontSize: 13.5,
                        color: overAllocated ? "var(--danger)" : "var(--ink)",
                      }}
                    >
                      <span>Bottled <strong>{bottledL.toFixed(2)} L</strong>{totalL > 0 ? ` of ${totalL.toFixed(2)} L` : ""}</span>
                      <span style={{ fontWeight: 600 }}>
                        {totalL <= 0
                          ? ""
                          : overAllocated
                            ? `${Math.abs(remainingL).toFixed(2)} L over`
                            : `${remainingL.toFixed(2)} L left`}
                      </span>
                    </div>

                    <button
                      className="btn btn--subtle"
                      style={{ marginTop: 12 }}
                      disabled={busy || !draft.productId || bottledMl <= 0 || overAllocated}
                      onClick={() => void appendAllocation()}
                    >
                      {busy ? "…" : overAllocated ? "Over the produced total" : "+ Add to run"}
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
                  <th>By size</th>
                  <th className="table__num">Bottles</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  // Bottle distribution per size across all flavours in the run.
                  const bySize = new Map<number, number>();
                  for (const it of h.items) {
                    const ml = it.sizeMl ?? 0;
                    bySize.set(ml, (bySize.get(ml) ?? 0) + it.quantityProduced);
                  }
                  const sizeRows = [...bySize.entries()].sort((a, b) => a[0] - b[0]);
                  return (
                    <tr key={h.id}>
                      <td>{formatDate(h.runDate)}</td>
                      <td>
                        <span className={h.status === "completed" ? "pill pill--success" : "pill pill--warning"}>{h.status}</span>
                      </td>
                      <td className="table__num">{h.items.length}</td>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {sizeRows.map(([ml, qty]) => (
                            <span key={ml} className="pill" style={{ fontSize: 12 }}>
                              {sizeLabel(ml || null)}: {qty.toLocaleString()}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="table__num">{h.items.reduce((sum, it) => sum + it.quantityProduced, 0)}</td>
                      <td style={{ textAlign: "right" }}>
                        <Link to="/factory/production-runs/$runId" params={{ runId: h.id }} className="btn btn--subtle btn--sm">
                          View
                        </Link>
                      </td>
                    </tr>
                  );
                })}
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

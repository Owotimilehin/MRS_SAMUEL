import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { StatHero } from "../../components/StatHero.js";
import type { StatChip } from "../../components/StatHero.js";
import { api } from "../../lib/api.js";
import { formatDate, formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface RunItem {
  id: string;
  productId: string;
  variantId: string | null;
  sizeMl: number | null;
  quantityProduced: number;
  batchCode: string | null;
}
interface RunDetail {
  id: string;
  factoryId: string;
  runDate: string;
  status: "draft" | "completed" | "cancelled";
  completedAt: string | null;
  notes: string | null;
  createdAt: string;
  items: RunItem[];
}
interface Factory {
  id: string;
  name: string;
}
interface Product {
  id: string;
  name: string;
}

function statusPill(s: RunDetail["status"]): JSX.Element {
  if (s === "completed") return <span className="pill pill--success">Completed</span>;
  if (s === "cancelled") return <span className="pill pill--ink">Cancelled</span>;
  return <span className="pill pill--warning">Draft</span>;
}

export function RunDetailPage({ runId }: { runId: string }): JSX.Element {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [factories, setFactories] = useState<Factory[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [r, f, p] = await Promise.all([
        api<{ data: RunDetail }>(`/production-runs/${runId}`),
        api<{ data: Factory[] }>(`/factories`),
        api<{ data: Product[] }>(`/products`),
      ]);
      setRun(r.data);
      setFactories(f.data);
      setProducts(p.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  async function complete(): Promise<void> {
    setActing(true);
    try {
      await api(`/production-runs/${runId}/complete`, { method: "PATCH" });
      toast.success("Run completed — bottles posted to factory ledger");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  const factoryName = (id: string): string => factories.find((f) => f.id === id)?.name ?? id.slice(0, 8);
  const productName = (id: string): string => products.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const sizeLabel = (ml: number | null): string => (ml ? `${ml}ml` : "—");

  const totalBottles = run?.items.reduce((sum, it) => sum + it.quantityProduced, 0) ?? 0;

  // Chips: guard against null run while loading; "Planned" omitted (no planned
  // quantity field on RunDetail). Yield % guarded against div-by-zero — dropped
  // when no planned qty is available. Tone for status varies by value.
  const runDetailChips: StatChip[] = [];
  runDetailChips.push({ label: "Bottles produced", value: totalBottles ?? 0 });
  runDetailChips.push({ label: "Line items", value: run?.items.length ?? 0 });
  if (run) {
    const statusTone =
      run.status === "completed"
        ? "good" as const
        : run.status === "cancelled"
        ? "danger" as const
        : "warn" as const;
    runDetailChips.push({ label: "Status", value: run.status, tone: statusTone });
  } else {
    runDetailChips.push({ label: "Status", value: "—" });
  }

  return (
    <Shell
      title={run ? `Run · ${formatDate(run.runDate)}` : "Production run"}
      actions={
        <Link to="/factory/production-runs" className="btn btn--subtle btn--sm">
          ← All runs
        </Link>
      }
    >
      <StatHero
        eyebrow="Factory"
        title={run ? `Run · ${formatDate(run.runDate)}` : "Production run"}
        sub="Per-run breakdown of bottles produced and line items."
        loading={loading}
        chips={runDetailChips}
      />

      {loading || !run ? (
        <InlineLoader />
      ) : (
        <>
          <section className="card" style={{ marginBottom: 18 }}>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <div>
                <h2 className="t-h2">{factoryName(run.factoryId)}</h2>
                <div style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 4 }}>
                  Created {formatDateTime(run.createdAt)}
                  {run.completedAt && ` · completed ${formatDateTime(run.completedAt)}`}
                </div>
              </div>
              {statusPill(run.status)}
            </header>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <Field label="Run date" value={formatDate(run.runDate)} />
              <Field label="Bottles produced" value={totalBottles.toLocaleString()} />
              <Field label="Line items" value={String(run.items.length)} />
            </div>

            {run.notes && (
              <div className="card card--soft" style={{ marginTop: 14, padding: 12, whiteSpace: "pre-wrap", fontSize: 14 }}>
                {run.notes}
              </div>
            )}

            {run.status === "draft" && (
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={acting}
                  onClick={() => void complete()}
                >
                  {acting ? "Completing…" : "Complete run · post to ledger"}
                </button>
              </div>
            )}
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 12 }}>Items</h2>
            {run.items.length === 0 ? (
              <div className="empty">No items.</div>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Size</th>
                      <th className="table__num">Quantity</th>
                      <th>Batch code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.items.map((it) => (
                      <tr key={it.id}>
                        <td>{productName(it.productId)}</td>
                        <td style={{ color: "var(--ink-soft)" }}>{sizeLabel(it.sizeMl)}</td>
                        <td className="table__num" style={{ fontWeight: 700 }}>
                          {it.quantityProduced.toLocaleString()}
                        </td>
                        <td style={{ fontFamily: "monospace", fontSize: 13 }}>
                          {it.batchCode ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </Shell>
  );
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="card card--soft" style={{ padding: 14 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-soft)",
        }}
      >
        {label}
      </div>
      <div style={{ fontWeight: 800, fontSize: 22, marginTop: 4 }}>{value}</div>
    </div>
  );
}

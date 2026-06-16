import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { StatHero } from "../../components/StatHero.js";
import { api } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

const REASON_LABEL: Record<string, string> = {
  physical_recount: "Physical recount",
  damaged: "Damaged",
  spoilage: "Spoilage",
  theft: "Theft / loss",
  found: "Found extra",
  opening_balance: "Opening balance",
  other_with_note: "Other",
};

interface Line {
  product_id: string;
  product_name: string;
  delta: number;
  note: string | null;
}
interface Adjustment {
  id: string;
  location_type: "factory" | "branch";
  location_id: string;
  reason_code: string;
  reason_note: string | null;
  recorded_by_email: string | null;
  created_at: string;
  lines: Line[];
}
interface Branch { id: string; name: string }
interface Factory { id: string; name: string }

function todayMinusDays(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function AdjustmentsPage(): JSX.Element {
  const [from, setFrom] = useState(todayMinusDays(30));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [locationType, setLocationType] = useState<"" | "factory" | "branch">("");
  const [rows, setRows] = useState<Adjustment[]>([]);
  const [factories, setFactories] = useState<Factory[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const [f, b] = await Promise.all([
          api<{ data: Factory[] }>(`/factories`),
          api<{ data: Branch[] }>(`/branches`),
        ]);
        setFactories(f.data);
        setBranches(b.data);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from, to, page_size: "200" });
      if (locationType) qs.set("location_type", locationType);
      const res = await api<{ data: Adjustment[] }>(`/inventory/adjustments?${qs}`);
      setRows(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, locationType]);

  function locationName(t: string, id: string): string {
    if (t === "factory") return factories.find((f) => f.id === id)?.name ?? id.slice(0, 8);
    return branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);
  }

  function toggle(id: string): void {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allLines = rows.flatMap((r) => r.lines);
  const netDelta = allLines.reduce((sum, l) => sum + l.delta, 0);
  const positiveAdj = rows.filter((r) => r.lines.some((l) => l.delta > 0)).length;
  const negativeAdj = rows.filter((r) => r.lines.every((l) => l.delta <= 0) && r.lines.some((l) => l.delta < 0)).length;

  return (
    <Shell title="Adjustments history">
      <StatHero
        eyebrow="Products"
        title="Adjustments"
        sub="Stock adjustment history for factories and branches."
        loading={loading}
        chips={[
          { label: "In range", value: rows.length },
          { label: "Net delta (cans)", value: (netDelta >= 0 ? "+" : "") + netDelta },
          { label: "Increases", value: positiveAdj, tone: "good" },
          { label: "Decreases", value: negativeAdj, tone: negativeAdj > 0 ? "warn" : "good" },
        ]}
      />

      <div style={{ display: "flex", gap: 12, alignItems: "end", marginBottom: 16, flexWrap: "wrap" }}>
        <div className="field">
          <label className="field__label" htmlFor="adj-from">From</label>
          <input id="adj-from" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="adj-to">To</label>
          <input id="adj-to" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="adj-loc">Location type</label>
          <select
            id="adj-loc"
            className="select"
            value={locationType}
            onChange={(e) => setLocationType(e.target.value as "" | "factory" | "branch")}
          >
            <option value="">All</option>
            <option value="factory">Factory</option>
            <option value="branch">Branch</option>
          </select>
        </div>
      </div>

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">No adjustments in this range.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Location</th>
                <th>Reason</th>
                <th>By</th>
                <th className="table__num">Lines</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((adj) => (
                <>
                  <tr key={adj.id}>
                    <td>{formatDateTime(adj.created_at)}</td>
                    <td>
                      {adj.location_type} · {locationName(adj.location_type, adj.location_id)}
                    </td>
                    <td>
                      {REASON_LABEL[adj.reason_code] ?? adj.reason_code}
                      {adj.reason_note && (
                        <div style={{ color: "var(--ink-soft)", fontSize: 12 }}>“{adj.reason_note}”</div>
                      )}
                    </td>
                    <td style={{ color: "var(--ink-soft)" }}>{adj.recorded_by_email ?? "—"}</td>
                    <td className="table__num">{adj.lines.length}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn btn--subtle btn--sm"
                        onClick={() => toggle(adj.id)}
                      >
                        {expanded.has(adj.id) ? "Hide" : "View"}
                      </button>
                    </td>
                  </tr>
                  {expanded.has(adj.id) && (
                    <tr key={adj.id + "-detail"}>
                      <td colSpan={6} style={{ background: "var(--surface-soft)", padding: 12 }}>
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Product</th>
                              <th className="table__num">Delta</th>
                              <th>Note</th>
                            </tr>
                          </thead>
                          <tbody>
                            {adj.lines.map((l) => (
                              <tr key={l.product_id}>
                                <td>{l.product_name}</td>
                                <td
                                  className="table__num"
                                  style={{
                                    fontWeight: 700,
                                    color: l.delta > 0 ? "var(--success)" : "var(--danger)",
                                  }}
                                >
                                  {l.delta > 0 ? "+" : ""}
                                  {l.delta}
                                </td>
                                <td style={{ color: "var(--ink-soft)" }}>{l.note ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}

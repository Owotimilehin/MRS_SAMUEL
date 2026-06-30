import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api, humanizeError } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

interface SourceTotal { bottles: number; value_ngn: number }
interface Report {
  month: string;
  totals: { bottles: number; value_ngn: number; by_source: Record<string, SourceTotal> };
  by_flavour: Array<{
    product_id: string;
    name: string;
    size_ml: number | null;
    source: string;
    bottles: number;
    value_ngn: number;
  }>;
}

const SOURCE_LABEL: Record<string, string> = {
  transfer: "Transfer",
  shift_close: "Shift close",
};

export function VarianceReportPage(): JSX.Element {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ data: Report }>(`/reports/variance-losses?month=${month}`)
      .then((r) => {
        if (!cancelled) setReport(r.data);
      })
      .catch((err) => {
        if (!cancelled) setError(humanizeError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [month]);

  const transfer = report?.totals.by_source["transfer"] ?? { bottles: 0, value_ngn: 0 };
  const shift = report?.totals.by_source["shift_close"] ?? { bottles: 0, value_ngn: 0 };

  return (
    <Shell
      title="Variance & losses"
      crumb="Owner"
      actions={
        <input
          type="month"
          className="input"
          value={month}
          max={new Date().toISOString().slice(0, 7)}
          onChange={(e) => setMonth(e.target.value)}
        />
      }
    >
      {loading && <InlineLoader />}
      {error && <p className="t-error" style={{ marginTop: 12 }}>{error}</p>}

      {!loading && !error && report && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 16 }}>
            <div className="card">
              <div className="t-muted">Total lost</div>
              <div className="t-h2">{ngn(report.totals.value_ngn)}</div>
              <div className="t-muted">{report.totals.bottles} bottles</div>
            </div>
            <div className="card">
              <div className="t-muted">Transfer variance</div>
              <div className="t-h2">{ngn(transfer.value_ngn)}</div>
              <div className="t-muted">{transfer.bottles} bottles</div>
            </div>
            <div className="card">
              <div className="t-muted">Shift-close shortfall</div>
              <div className="t-h2">{ngn(shift.value_ngn)}</div>
              <div className="t-muted">{shift.bottles} bottles</div>
            </div>
          </div>

          <section className="card" style={{ marginTop: 16 }}>
            <h2 className="t-h2" style={{ marginBottom: 12 }}>By flavour</h2>
            {report.by_flavour.length === 0 ? (
              <p className="t-muted">No losses recorded for {month}.</p>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Flavour</th>
                      <th>Source</th>
                      <th>Bottles</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.by_flavour.map((row, i) => (
                      <tr key={`${row.product_id}-${row.size_ml}-${row.source}-${i}`}>
                        <td>
                          {row.name}
                          {row.size_ml ? ` ${row.size_ml}ml` : ""}
                        </td>
                        <td>{SOURCE_LABEL[row.source] ?? row.source}</td>
                        <td>{row.bottles}</td>
                        <td>{ngn(row.value_ngn)}</td>
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

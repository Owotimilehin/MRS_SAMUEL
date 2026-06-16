import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { StatHero } from "../../components/StatHero.js";
import { api } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface VarianceRow {
  daily_close_id: string;
  branch_id: string;
  business_date: string;
  variance_ngn: number;
}
interface BranchRow {
  id: string;
  name: string;
}

export function OwnerClosesPage(): JSX.Element {
  const [variances, setVariances] = useState<VarianceRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(() =>
    new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
  );

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [vari, br] = await Promise.all([
        api<{ data: VarianceRow[] }>(`/reports/variances?from=${from}`),
        api<{ data: BranchRow[] }>(`/branches`),
      ]);
      setVariances(vari.data);
      setBranches(br.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);

  const branchName = (id: string): string => branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  const withVariance = variances.filter((v) => v.variance_ngn !== 0).length;
  const netVariance = variances.reduce((sum, v) => sum + v.variance_ngn, 0);
  const negativeCloses = variances.filter((v) => v.variance_ngn < 0).length;

  return (
    <Shell
      title="Daily closes"
      actions={
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label className="t-eyebrow" style={{ color: "var(--ink-soft)" }}>
            Since
          </label>
          <input
            type="date"
            className="input"
            style={{ width: 160, height: 36 }}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
      }
    >
      <StatHero
        eyebrow="Finance"
        title="Daily closes"
        sub="Branch end-of-day cash variance report."
        loading={loading}
        chips={[
          { label: "In range", value: variances.length },
          { label: "With variance", value: withVariance, tone: withVariance > 0 ? "warn" : "good" },
          { label: "Net variance", value: ngn(netVariance) },
          { label: "Negative closes", value: negativeCloses, tone: negativeCloses > 0 ? "danger" : "good" },
        ]}
      />


      {loading ? (
        <InlineLoader />
      ) : variances.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No closes in range</div>
          Closes will appear here as branches submit them.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Branch</th>
                <th className="table__num">Variance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {variances.map((v) => (
                <tr key={v.daily_close_id}>
                  <td style={{ fontWeight: 600 }}>{v.business_date}</td>
                  <td>{branchName(v.branch_id)}</td>
                  <td
                    className="table__num"
                    style={{
                      fontWeight: 700,
                      color:
                        v.variance_ngn < 0
                          ? "var(--danger)"
                          : v.variance_ngn > 0
                            ? "var(--warning)"
                            : "var(--ink-soft)",
                    }}
                  >
                    {v.variance_ngn > 0 ? "+" : ""}
                    {ngn(v.variance_ngn)}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Link
                      to="/closes/$branchId/$closeId"
                      params={{ branchId: v.branch_id, closeId: v.daily_close_id }}
                      className="btn btn--subtle btn--sm"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}

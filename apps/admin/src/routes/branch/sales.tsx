import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import { local } from "../../db/local.js";
import { ngn, formatDateTime } from "../../lib/format.js";

interface BranchSalesPageProps {
  branchId: string;
}

export function BranchSalesPage({ branchId }: BranchSalesPageProps): JSX.Element {
  const sales = useLiveQuery(async () => {
    const all = await local.sales.orderBy("created_at_local").reverse().toArray();
    return all.filter((s) => s.branch_id === branchId).slice(0, 200);
  }, [branchId]);

  return (
    <BranchShell branchId={branchId} title="Today's sales">
      {sales && sales.length === 0 ? (
        <p style={{ color: "var(--ms-ink-3)" }}>No sales yet. Open the till to start.</p>
      ) : (
        <div
          className="overflow-hidden"
          style={{
            background: "var(--ms-surface)",
            border: "1px solid var(--ms-border)",
            borderRadius: 14,
          }}
        >
          <table className="w-full text-sm">
            <thead style={{ background: "var(--ms-surface-alt)" }}>
              <tr>
                <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                  Order
                </th>
                <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                  Channel
                </th>
                <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                  Time
                </th>
                <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                  Status
                </th>
                <th className="text-right px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {sales?.map((s) => (
                <tr key={s.id} style={{ borderTop: "1px solid var(--ms-divider)" }}>
                  <td className="px-4 py-3 font-mono text-xs">{s.order_number}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: "var(--ms-ink-2)" }}>
                    {s.channel}
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: "var(--ms-ink-2)" }}>
                    {formatDateTime(s.created_at_local)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="text-xs font-semibold px-2 py-1 rounded-full"
                      style={{
                        background: "var(--ms-green-100)",
                        color: "var(--ms-green-900)",
                      }}
                    >
                      {s.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">
                    {ngn(s.total_ngn)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </BranchShell>
  );
}

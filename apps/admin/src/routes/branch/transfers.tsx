import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import { local } from "../../db/local.js";
import { formatDateTime } from "../../lib/format.js";

interface BranchTransfersPageProps {
  branchId: string;
}

export function BranchTransfersPage({ branchId }: BranchTransfersPageProps): JSX.Element {
  const transfers = useLiveQuery(
    () =>
      local.transfers
        .orderBy("updated_at")
        .reverse()
        .toArray()
        .then((rows) => rows.slice(0, 50)),
    [],
  );

  return (
    <BranchShell branchId={branchId} title="Incoming transfers">
      <p className="mb-4" style={{ color: "var(--ms-ink-3)" }}>
        Transfers shown here are pulled from the factory. Receive flow is wired in admin /transfers
        — branch staff can open from there and mark Arrived → Received.
      </p>
      {transfers && transfers.length === 0 ? (
        <p style={{ color: "var(--ms-ink-3)" }}>No transfers yet.</p>
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
                  Number
                </th>
                <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                  Status
                </th>
                <th className="text-left px-4 py-2 text-xs uppercase tracking-wide font-semibold">
                  Last update
                </th>
              </tr>
            </thead>
            <tbody>
              {transfers?.map((t) => (
                <tr key={t.id} style={{ borderTop: "1px solid var(--ms-divider)" }}>
                  <td className="px-4 py-3 font-mono text-xs">{t.transfer_number}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: "var(--ms-ink-2)" }}>
                    {t.status}
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: "var(--ms-ink-2)" }}>
                    {formatDateTime(t.updated_at)}
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

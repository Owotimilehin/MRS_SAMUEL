import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface Device {
  device_id: string;
  branch_id: string | null;
  app_version: string | null;
  queue_depth: number;
  last_sync_at: string | null;
  reported_at: string;
  age_seconds: number;
}
interface Branch {
  id: string;
  name: string;
}

function onlinePill(ageSec: number): JSX.Element {
  if (ageSec < 300)
    return <span className="pill pill--success">● Online</span>;
  if (ageSec < 1800)
    return <span className="pill pill--warning">● Idle</span>;
  return <span className="pill pill--danger">● Offline</span>;
}

function relativeAge(ageSec: number): string {
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86400)}d ago`;
}

export function DevicesPage(): JSX.Element {
  const [devices, setDevices] = useState<Device[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [d, b] = await Promise.all([
        api<{ data: Device[] }>("/telemetry/devices"),
        api<{ data: Branch[] }>("/branches"),
      ]);
      setDevices(d.data);
      setBranches(b.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const branchName = (id: string | null): string =>
    id ? branches.find((b) => b.id === id)?.name ?? id.slice(0, 8) : "—";

  return (
    <Shell
      title="Devices"
      actions={
        <button type="button" className="btn btn--subtle btn--sm" onClick={() => void load()}>
          Refresh
        </button>
      }
    >
      <section className="card">
        
        {loading ? (
          <InlineLoader />
        ) : devices.length === 0 ? (
          <div className="empty">
            <div className="empty__title">No devices yet</div>
            Branch tablets check in here once they sync at least once.
          </div>
        ) : (
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Device</th>
                  <th>Branch</th>
                  <th>App version</th>
                  <th className="table__num">Queue</th>
                  <th>Last sync</th>
                  <th>Reported</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.device_id}>
                    <td>{onlinePill(d.age_seconds)}</td>
                    <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
                      {d.device_id.slice(0, 12)}…
                    </td>
                    <td>{branchName(d.branch_id)}</td>
                    <td style={{ color: "var(--ink-soft)" }}>
                      {d.app_version ?? "—"}
                    </td>
                    <td
                      className="table__num"
                      style={{
                        fontWeight: 700,
                        color: d.queue_depth > 0 ? "var(--warning)" : undefined,
                      }}
                    >
                      {d.queue_depth}
                    </td>
                    <td style={{ color: "var(--ink-soft)" }}>
                      {d.last_sync_at ? formatDateTime(d.last_sync_at) : "—"}
                    </td>
                    <td style={{ color: "var(--ink-soft)" }}>
                      {relativeAge(d.age_seconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BranchShell } from "../../components/BranchShell.js";
import { StatHero } from "../../components/StatHero.js";
import { useSyncState } from "../../sync/state.js";
import { flushOutbox, resyncStock } from "../../sync/engine.js";
import { local } from "../../db/local.js";
import { formatDateTime } from "../../lib/format.js";
import { toast } from "../../lib/toast.js";

const APP_VERSION = import.meta.env?.VITE_APP_VERSION ?? "dev";

function deviceId(): string {
  let id = localStorage.getItem("ms_device_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("ms_device_id", id);
  }
  return id;
}

export function BranchDevicePage({ branchId }: { branchId: string }): JSX.Element {
  const sync = useSyncState();
  const [syncing, setSyncing] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [lastPull, setLastPull] = useState<string | null>(null);

  const meta = useLiveQuery(() => local.meta.get("default"), []);

  useEffect(() => {
    if (meta?.last_pull_at) setLastPull(meta.last_pull_at);
  }, [meta]);

  async function forceSync(): Promise<void> {
    setSyncing(true);
    try {
      await flushOutbox();
    } finally {
      setSyncing(false);
    }
  }

  // Pull a fresh authoritative stock snapshot from the server, discarding the
  // local one. The fix for "wrong number on the till" — e.g. phantom stock left
  // over from a server-side correction the incremental sync never reached.
  async function resyncStockNow(): Promise<void> {
    setResyncing(true);
    try {
      const refreshed = await resyncStock(branchId);
      toast[refreshed ? "success" : "error"](
        refreshed
          ? "Stock refreshed from the server."
          : "Can't resync while offline — reconnect and try again.",
      );
    } catch {
      toast.error("Couldn't refresh stock. Check the connection and retry.");
    } finally {
      setResyncing(false);
    }
  }

  const onlinePill = sync.online ? (
    <span className="pill pill--success">● Online</span>
  ) : (
    <span className="pill pill--warning">● Offline</span>
  );

  return (
    <BranchShell
      branchId={branchId}
      title="Device health"
      actions={
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={syncing}
          onClick={forceSync}
        >
          {syncing ? "Syncing…" : "Force sync"}
        </button>
      }
    >
      <StatHero
        eyebrow="Branch"
        title="Device"
        sub="Monitor connection, sync status and device info for this POS terminal."
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <section className="card">
          <h2 className="t-h2" style={{ marginBottom: 12 }}>
            Connection
          </h2>
          <Row label="Status" value={onlinePill} />
          <Row label="Pending queue" value={`${sync.queued}`} />
          <Row
            label="Failed ops"
            value={
              sync.dead > 0 ? (
                <span style={{ color: "var(--danger)", fontWeight: 700 }}>
                  {sync.dead}
                </span>
              ) : (
                "0"
              )
            }
          />
          <Row
            label="Last server pull"
            value={lastPull ? formatDateTime(lastPull) : "—"}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 12 }}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={resyncing || !sync.online}
              onClick={resyncStockNow}
            >
              {resyncing ? "Refreshing…" : "Resync stock now"}
            </button>
            <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
              Pulls fresh on-hand counts from the server. Use if a flavour shows the wrong
              number on the till.
            </span>
          </div>
        </section>

        <section className="card">
          <h2 className="t-h2" style={{ marginBottom: 12 }}>
            This device
          </h2>
          <Row label="Device ID" value={deviceId()} mono />
          <Row label="Branch ID" value={branchId} mono />
          <Row label="App version" value={APP_VERSION} />
          <Row label="User agent" value={navigator.userAgent} small />
          <Row
            label="Storage estimate"
            value={
              navigator.storage && "estimate" in navigator.storage
                ? "Available"
                : "Unsupported"
            }
          />
        </section>

        <section className="card">
          <h2 className="t-h2" style={{ marginBottom: 12 }}>
            Trouble?
          </h2>
          <ul
            style={{
              fontSize: 14,
              color: "var(--ink-soft)",
              lineHeight: 1.6,
              paddingLeft: 18,
            }}
          >
            <li>
              If <strong>Pending queue</strong> isn't going down, check the WiFi and tap
              "Force sync."
            </li>
            <li>
              If anything shows under <strong>Failed ops</strong>, open the{" "}
              <a href="/branch/queue" style={{ color: "var(--accent)", fontWeight: 600 }}>
                queue inspector
              </a>{" "}
              to see what failed.
            </li>
            <li>
              Close and reopen the app to refresh the cached menu and prices.
            </li>
          </ul>
        </section>
      </div>
    </BranchShell>
  );
}

function Row({
  label,
  value,
  mono,
  small,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  small?: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr",
        gap: 12,
        alignItems: "center",
        padding: "8px 0",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <span style={{ color: "var(--ink-soft)", fontSize: 13 }}>{label}</span>
      <span
        style={{
          fontFamily: mono ? "ui-monospace, monospace" : undefined,
          fontSize: small ? 11 : 14,
          fontWeight: mono || small ? 500 : 600,
          wordBreak: "break-word",
        }}
      >
        {value}
      </span>
    </div>
  );
}

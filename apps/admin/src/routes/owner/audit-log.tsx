import { useEffect, useState, type CSSProperties } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import {
  humanizeAction,
  humanizeActor,
  humanizeDiff,
  humanizeEntity,
  entityTypeLabel,
  actionFilterLabel,
  type AuditRow,
  type UserLookup,
  type BranchLookup,
} from "../../lib/audit-humanize.js";
import { StatHero } from "../../components/StatHero.js";
import { DataState } from "../../components/DataState.js";

interface Facets {
  entity_types: string[];
  actions: string[];
}

const filterFieldStyle: CSSProperties ={ gap: 4 };
const filterLabelStyle: CSSProperties ={ fontSize: 11 };
const filterControlStyle: CSSProperties ={ height: 34, fontSize: 13, padding: "0 10px" };

export function AuditLogPage(): JSX.Element {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [facets, setFacets] = useState<Facets>({ entity_types: [], actions: [] });
  const [users, setUsers] = useState<UserLookup[]>([]);
  const [branches, setBranches] = useState<BranchLookup[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<AuditRow | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");
  const [actorUserId, setActorUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  async function load(): Promise<void> {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (entityType) params.set("entity_type", entityType);
      if (action) params.set("action", action);
      if (actorUserId) params.set("actor_user_id", actorUserId);
      if (from) params.set("from", new Date(from).toISOString());
      if (to) params.set("to", new Date(to).toISOString());
      params.set("limit", "100");
      const res = await api<{ data: AuditRow[] }>(`/audit-log?${params}`);
      setRows(res.data);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [f, u, b] = await Promise.all([
          api<{ data: Facets }>(`/audit-log/facets`),
          api<{ data: UserLookup[] }>(`/admin/users`),
          api<{ data: BranchLookup[] }>(`/branches`),
        ]);
        if (cancelled) return;
        setFacets(f.data);
        setUsers(u.data);
        setBranches(b.data);
      } catch {
        /* facets are nice-to-have */
      }
    })();
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openRow(row: AuditRow): void {
    setSelected(row);
    setShowRaw(false);
  }

  const loginCount = rows.filter((r) => r.action === "auth.login_success").length;
  const writeCount = rows.filter((r) => r.action !== "auth.login_success").length;
  const distinctActors = new Set(rows.map((r) => r.actorUserId).filter(Boolean)).size;

  return (
    <Shell
      title="Audit log"
      actions={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void load()}>
          Refresh
        </button>
      }
    >
      <StatHero
        eyebrow="Admin"
        title="Audit log"
        sub="Every write, sign-in, and configuration change in this view."
        loading={loading}
        chips={[
          { label: "Events", value: rows.length },
          { label: "Writes", value: writeCount },
          { label: "Sign-ins", value: loginCount },
          { label: "Actors", value: distinctActors },
        ]}
      />

      <div
        className="card grid grid-cols-2 sm:flex sm:flex-wrap items-end"
        style={{ marginBottom: 16, padding: "12px 14px", gap: 10 }}
      >
        <div className="field sm:w-[150px]" style={{ ...filterFieldStyle, minWidth: 0 }}>
          <label className="field__label" style={filterLabelStyle}>What</label>
          <select className="select" style={filterControlStyle} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">Anything</option>
            {facets.entity_types.map((t) => (
              <option key={t} value={t}>
                {entityTypeLabel(t)}
              </option>
            ))}
          </select>
        </div>
        <div className="field sm:w-[200px]" style={{ ...filterFieldStyle, minWidth: 0 }}>
          <label className="field__label" style={filterLabelStyle}>Action</label>
          <select className="select" style={filterControlStyle} value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Any action</option>
            {facets.actions.map((a) => (
              <option key={a} value={a}>
                {actionFilterLabel(a)}
              </option>
            ))}
          </select>
        </div>
        <div className="field col-span-2 sm:w-[200px]" style={{ ...filterFieldStyle, minWidth: 0 }}>
          <label className="field__label" style={filterLabelStyle}>Who</label>
          <select className="select" style={filterControlStyle} value={actorUserId} onChange={(e) => setActorUserId(e.target.value)}>
            <option value="">Anyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </select>
        </div>
        <div className="field col-span-2 sm:w-[185px]" style={{ ...filterFieldStyle, minWidth: 0 }}>
          <label className="field__label" style={filterLabelStyle}>From</label>
          <input className="input" style={filterControlStyle} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field col-span-2 sm:w-[185px]" style={{ ...filterFieldStyle, minWidth: 0 }}>
          <label className="field__label" style={filterLabelStyle}>To</label>
          <input className="input" style={filterControlStyle} type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button type="button" className="btn btn--primary btn--sm col-span-2" style={{ minWidth: 100, height: 34 }} onClick={() => void load()}>
          Apply
        </button>
      </div>

      <DataState
        loading={loading}
        error={loadError}
        isEmpty={rows.length === 0}
        emptyTitle="No activity in view"
        emptyHint="Adjust filters or wait for new activity."
        onRetry={() => void load()}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What happened</th>
                <th>Details</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ color: "var(--ink-soft)", fontSize: 13, whiteSpace: "nowrap" }}>
                    {formatDateTime(r.occurredAt)}
                  </td>
                  <td style={{ minWidth: 180 }}>
                    <div style={{ fontWeight: 600 }}>{humanizeActor(r, users)}</div>
                  </td>
                  <td style={{ minWidth: 220 }}>{humanizeAction(r, branches)}</td>
                  <td style={{ color: "var(--ink-soft)", fontSize: 13, minWidth: 160 }}>
                    {humanizeEntity(r)}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      onClick={() => openRow(r)}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataState>

      {selected && (
        <AuditDetailModal
          row={selected}
          users={users}
          branches={branches}
          showRaw={showRaw}
          onToggleRaw={() => setShowRaw((v) => !v)}
          onClose={() => setSelected(null)}
        />
      )}
    </Shell>
  );
}

function AuditDetailModal({
  row,
  users,
  branches,
  showRaw,
  onToggleRaw,
  onClose,
}: {
  row: AuditRow;
  users: UserLookup[];
  branches: BranchLookup[];
  showRaw: boolean;
  onToggleRaw: () => void;
  onClose: () => void;
}): JSX.Element {
  const diff = humanizeDiff(row.beforeJson, row.afterJson, row.entityType);
  const hasBeforeOrAfter = row.beforeJson != null || row.afterJson != null;

  return (
    <div
      role="dialog"
      aria-modal
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20,24,31,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 50,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: 720,
          maxHeight: "calc(100vh - 32px)",
          overflow: "auto",
          boxShadow: "var(--shadow-float)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
          <div>
            <h2 className="t-h2">{humanizeAction(row, branches)}</h2>
            <div style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 4 }}>
              {humanizeActor(row, users)} · {formatDateTime(row.occurredAt)}
            </div>
            <div style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 2 }}>
              {entityTypeLabel(row.entityType)}: {humanizeEntity(row)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: 0,
              fontSize: 22,
              cursor: "pointer",
              color: "var(--ink-soft)",
            }}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {diff.length > 0 ? (
          <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
            {diff.map((line) => (
              <div
                key={line.field}
                className="card card--soft"
                style={{ padding: "10px 12px", display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "center" }}
              >
                <div>
                  <div className="t-eyebrow" style={{ color: "var(--ink-soft)", marginBottom: 2 }}>
                    {line.label}
                  </div>
                  <div style={{ color: "var(--ink-soft)", textDecoration: "line-through" }}>
                    {line.before}
                  </div>
                </div>
                <div style={{ color: "var(--ink-soft)" }}>→</div>
                <div>
                  <div className="t-eyebrow" style={{ visibility: "hidden", marginBottom: 2 }}>
                    .
                  </div>
                  <div style={{ fontWeight: 600 }}>{line.after}</div>
                </div>
              </div>
            ))}
          </div>
        ) : hasBeforeOrAfter ? (
          <div className="empty" style={{ marginBottom: 12 }}>
            No tracked field changes for this event.
          </div>
        ) : (
          <div className="empty" style={{ marginBottom: 12 }}>
            No additional detail captured.
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <button type="button" className="btn btn--subtle btn--sm" onClick={onToggleRaw}>
            {showRaw ? "Hide raw data" : "Show raw data"}
          </button>
          <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
            IP {row.ipAddress ?? "—"} · {row.userAgent ? row.userAgent.slice(0, 60) : "—"}
          </div>
        </div>

        {showRaw && (
          <div style={{ display: "grid", gridTemplateColumns: row.beforeJson && row.afterJson ? "1fr 1fr" : "1fr", gap: 12 }}>
            {row.beforeJson != null && (
              <div>
                <div className="t-eyebrow" style={{ color: "var(--ink-soft)", marginBottom: 6 }}>
                  Before
                </div>
                <pre
                  className="card card--soft"
                  style={{ fontSize: 12, margin: 0, padding: 12, overflow: "auto", maxHeight: 360 }}
                >
                  {JSON.stringify(row.beforeJson, null, 2)}
                </pre>
              </div>
            )}
            {row.afterJson != null && (
              <div>
                <div className="t-eyebrow" style={{ color: "var(--ink-soft)", marginBottom: 6 }}>
                  After
                </div>
                <pre
                  className="card card--soft"
                  style={{ fontSize: 12, margin: 0, padding: 12, overflow: "auto", maxHeight: 360 }}
                >
                  {JSON.stringify(row.afterJson, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

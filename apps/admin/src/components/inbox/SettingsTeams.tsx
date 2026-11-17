import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DataState } from "../DataState.js";
import { Modal } from "../Modal.js";
import { ConfirmModal } from "../ConfirmModal.js";
import { settingsApi, settingsKeys } from "../../lib/inbox-settings-api.js";
import { inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { toast } from "../../lib/toast.js";
import type { QuickReply, TeamWithMembers } from "../../lib/inbox-types.js";

// ── Teams ────────────────────────────────────────────────────────────────────

export function SettingsTeams(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: settingsKeys.teams, queryFn: settingsApi.teams });
  const [edit, setEdit] = useState<TeamWithMembers | "new" | null>(null);
  const [members, setMembers] = useState<TeamWithMembers | null>(null);
  const reload = (): void => {
    void qc.invalidateQueries({ queryKey: settingsKeys.teams });
    void qc.invalidateQueries({ queryKey: inboxKeys.teams });
    void qc.invalidateQueries({ queryKey: inboxKeys.staff });
  };

  return (
    <section className="card">
      <div className="card__head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div>
          <h2 className="t-h2">Teams</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 13 }}>Group staff so chats and calls reach the right people.</p>
        </div>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setEdit("new")}>
          + New team
        </button>
      </div>
      <DataState
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        isEmpty={(q.data ?? []).length === 0}
        emptyTitle="No teams yet"
        emptyHint="Create a team, e.g. Sales or Deliveries."
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Team</th>
                <th>Members</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((t) => (
                <tr key={t.id}>
                  <td>
                    <div style={{ fontWeight: 700 }}>{t.name}</div>
                    {t.description && <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{t.description}</div>}
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {t.members.length === 0
                      ? "Nobody yet"
                      : t.members.map((m) => `${m.name}${m.is_lead ? " (lead)" : ""}`).join(", ")}
                  </td>
                  <td>{t.isActive ? <span className="pill pill--success">Active</span> : <span className="pill pill--ink">Off</span>}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button type="button" className="btn btn--subtle btn--sm" style={{ marginRight: 6 }} onClick={() => setMembers(t)}>
                      Members
                    </button>
                    <button type="button" className="btn btn--subtle btn--sm" onClick={() => setEdit(t)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataState>
      {edit && (
        <TeamForm
          row={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
      {members && (
        <MembersEditor
          team={members}
          onClose={() => setMembers(null)}
          onSaved={() => {
            setMembers(null);
            reload();
          }}
        />
      )}
    </section>
  );
}

function TeamForm({ row, onClose, onSaved }: { row: TeamWithMembers | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [name, setName] = useState(row?.name ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [active, setActive] = useState(row?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmModal
      title={row ? `Edit ${row.name}` : "New team"}
      confirmLabel="Save team"
      busyLabel="Saving…"
      busy={busy}
      confirmDisabled={!name.trim()}
      onCancel={onClose}
      onConfirm={async () => {
        setBusy(true);
        try {
          const desc = description.trim() ? description.trim() : null;
          if (row) await settingsApi.updateTeam(row.id, { name: name.trim(), description: desc, is_active: active });
          else await settingsApi.createTeam({ name: name.trim(), description: desc });
          onSaved();
        } catch {
          /* toast shown */
        } finally {
          setBusy(false);
        }
      }}
    >
      <div style={{ display: "grid", gap: 10 }}>
        <label className="field">
          <span className="field__label">Team name</span>
          <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">What they handle (optional)</span>
          <input className="input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {row && (
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span>Team is active</span>
          </label>
        )}
      </div>
    </ConfirmModal>
  );
}

function MembersEditor({ team, onClose, onSaved }: { team: TeamWithMembers; onClose: () => void; onSaved: () => void }): JSX.Element {
  // Inbox staff only — people who can't open the inbox can't work a team queue.
  const staff = useQuery({ queryKey: inboxKeys.staff, queryFn: inboxApi.staff });
  const [sel, setSel] = useState<Map<string, boolean>>(() => new Map(team.members.map((m) => [m.user_id, m.is_lead])));
  const [busy, setBusy] = useState(false);
  const toggle = (id: string, on: boolean): void =>
    setSel((s) => {
      const n = new Map(s);
      if (on) n.set(id, n.get(id) ?? false);
      else n.delete(id);
      return n;
    });

  return (
    <Modal title={`${team.name} — members`} onClose={onClose} maxWidth={520}>
      {staff.isLoading ? (
        <div>Loading staff…</div>
      ) : (
        <div style={{ display: "grid", gap: 6, maxHeight: "55vh", overflowY: "auto" }}>
          {(staff.data ?? []).map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
                <input type="checkbox" checked={sel.has(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
                <span>{s.name}</span>
              </label>
              {sel.has(s.id) && (
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, color: "var(--ink-soft)" }}>
                  <input
                    type="checkbox"
                    checked={sel.get(s.id) ?? false}
                    onChange={(e) => setSel((m) => new Map(m).set(s.id, e.target.checked))}
                  />
                  Team lead
                </label>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await settingsApi.setMembers(
                team.id,
                [...sel.entries()].map(([user_id, is_lead]) => ({ user_id, is_lead })),
              );
              toast.success("Team members saved.");
              onSaved();
            } catch {
              /* toast shown */
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save members"}
        </button>
      </div>
    </Modal>
  );
}

// ── Who can use which number ─────────────────────────────────────────────────

export function SettingsAccess(): JSX.Element {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: settingsKeys.users, queryFn: settingsApi.adminUsers });
  const staff = useQuery({ queryKey: inboxKeys.staff, queryFn: inboxApi.staff });
  const numbers = useQuery({ queryKey: settingsKeys.numbers, queryFn: settingsApi.numbers });
  const access = useQuery({ queryKey: settingsKeys.access, queryFn: settingsApi.access });
  const [drafts, setDrafts] = useState<Record<string, Set<string>>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const granted = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const a of access.data ?? []) {
      if (!m.has(a.user_id)) m.set(a.user_id, new Set());
      m.get(a.user_id)!.add(a.phone_number_id);
    }
    return m;
  }, [access.data]);

  // Only people who can open the inbox; owners/admins with "see everything" still appear.
  const inboxIds = new Set((staff.data ?? []).map((s) => s.id));
  const people = (users.data ?? []).filter((u) => u.isActive && inboxIds.has(u.id));
  const activeNumbers = (numbers.data ?? []).filter((n) => n.isActive);
  const loading = users.isLoading || staff.isLoading || numbers.isLoading || access.isLoading;
  const error = users.error ?? staff.error ?? numbers.error ?? access.error;

  async function save(userId: string): Promise<void> {
    const set = drafts[userId];
    if (!set) return;
    setSaving(userId);
    try {
      await settingsApi.setAccess(userId, [...set]);
      setDrafts((d) => {
        const n = { ...d };
        delete n[userId];
        return n;
      });
      toast.success("Access saved.");
      await qc.invalidateQueries({ queryKey: settingsKeys.access });
    } catch {
      /* toast shown */
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="card">
      <h2 className="t-h2">Who can use which number</h2>
      <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 12 }}>
        Staff only see chats and calls for the numbers ticked here. Owners and admins who can see everything aren't limited.
      </p>
      <DataState
        loading={loading}
        error={error}
        onRetry={() => {
          void users.refetch();
          void staff.refetch();
          void numbers.refetch();
          void access.refetch();
        }}
        isEmpty={people.length === 0 || activeNumbers.length === 0}
        emptyTitle={activeNumbers.length === 0 ? "No numbers yet" : "No inbox staff yet"}
        emptyHint={activeNumbers.length === 0 ? "Add a business number first." : "Give staff inbox access in Admin users."}
      >
        <div style={{ display: "grid", gap: 10 }}>
          {people.map((u) => {
            const current = drafts[u.id] ?? granted.get(u.id) ?? new Set<string>();
            const dirty = !!drafts[u.id];
            return (
              <div key={u.id} className="card card--soft" style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{u.name?.trim() || u.email}</div>
                    <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{u.role}</div>
                  </div>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={!dirty || saving === u.id}
                    onClick={() => void save(u.id)}
                  >
                    {saving === u.id ? "Saving…" : "Save"}
                  </button>
                </div>
                <div className="ibx-checks">
                  {activeNumbers.map((n) => (
                    <label key={n.id}>
                      <input
                        type="checkbox"
                        checked={current.has(n.id)}
                        onChange={(e) =>
                          setDrafts((d) => {
                            const next = new Set(d[u.id] ?? granted.get(u.id) ?? []);
                            if (e.target.checked) next.add(n.id);
                            else next.delete(n.id);
                            return { ...d, [u.id]: next };
                          })
                        }
                      />
                      {n.label}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </DataState>
    </section>
  );
}

// ── Quick replies ────────────────────────────────────────────────────────────

export function SettingsQuickReplies(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: inboxKeys.quickReplies, queryFn: inboxApi.quickReplies });
  const [edit, setEdit] = useState<QuickReply | "new" | null>(null);
  const [del, setDel] = useState<QuickReply | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = (): void => void qc.invalidateQueries({ queryKey: inboxKeys.quickReplies });

  return (
    <section className="card">
      <div className="card__head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div>
          <h2 className="t-h2">Quick replies</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 13 }}>Ready-made answers staff can drop into a chat.</p>
        </div>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setEdit("new")}>
          + New quick reply
        </button>
      </div>
      <DataState
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        isEmpty={(q.data ?? []).length === 0}
        emptyTitle="No quick replies yet"
        emptyHint="Add answers to common questions, like prices or delivery times."
      >
        <div style={{ display: "grid", gap: 8 }}>
          {(q.data ?? []).map((r) => (
            <div key={r.id} className="card card--soft" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{r.title}</div>
                <div style={{ fontSize: 13, color: "var(--ink-soft)", whiteSpace: "pre-wrap" }}>{r.body}</div>
              </div>
              <button type="button" className="btn btn--subtle btn--sm" onClick={() => setEdit(r)}>
                Edit
              </button>
              <button type="button" className="btn btn--danger btn--sm" onClick={() => setDel(r)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      </DataState>
      {edit && (
        <QuickReplyForm
          row={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
      {del && (
        <ConfirmModal
          title="Delete quick reply?"
          confirmLabel="Delete"
          busyLabel="Deleting…"
          tone="danger"
          busy={busy}
          onCancel={() => setDel(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await inboxApi.deleteQuickReply(del.id);
              setDel(null);
              reload();
            } catch {
              /* toast shown */
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>"{del.title}" will no longer be offered to staff.</p>
        </ConfirmModal>
      )}
    </section>
  );
}

function QuickReplyForm({ row, onClose, onSaved }: { row: QuickReply | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [title, setTitle] = useState(row?.title ?? "");
  const [body, setBody] = useState(row?.body ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmModal
      title={row ? "Edit quick reply" : "New quick reply"}
      confirmLabel="Save"
      busyLabel="Saving…"
      busy={busy}
      confirmDisabled={!title.trim() || !body.trim()}
      onCancel={onClose}
      onConfirm={async () => {
        setBusy(true);
        try {
          if (row) await inboxApi.updateQuickReply(row.id, { title: title.trim(), body: body.trim() });
          else await inboxApi.createQuickReply({ title: title.trim(), body: body.trim() });
          onSaved();
        } catch {
          /* toast shown */
        } finally {
          setBusy(false);
        }
      }}
    >
      <div style={{ display: "grid", gap: 10 }}>
        <label className="field">
          <span className="field__label">Short name</span>
          <input className="input" value={title} maxLength={80} placeholder="Delivery times" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Message</span>
          <textarea className="textarea" rows={5} value={body} maxLength={4096} onChange={(e) => setBody(e.target.value)} />
        </label>
      </div>
    </ConfirmModal>
  );
}

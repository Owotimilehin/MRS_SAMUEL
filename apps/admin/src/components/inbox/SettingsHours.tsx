import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { DataState } from "../DataState.js";
import { Modal } from "../Modal.js";
import { settingsApi, settingsKeys, type MenuInput } from "../../lib/inbox-settings-api.js";
import {
  WEEKDAYS,
  rulesToWeek,
  validateMenu,
  validateWeek,
  weekToRules,
  type MenuOptionDraft,
  type WeekHours,
} from "../../lib/inbox-logic.js";
import { toast } from "../../lib/toast.js";
import type { HoursProfileRow, IvrMenuRow } from "../../lib/inbox-types.js";

// ── Opening hours + holidays ─────────────────────────────────────────────────

export function SettingsHours(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: settingsKeys.hours, queryFn: settingsApi.hours });
  const [edit, setEdit] = useState<HoursProfileRow | "new" | null>(null);
  const reload = (): void => void qc.invalidateQueries({ queryKey: settingsKeys.hours });

  const profiles = q.data?.profiles ?? [];
  const holidays = q.data?.holidays ?? [];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section className="card">
        <div className="card__head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div>
            <h2 className="t-h2">Opening hours</h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13 }}>
              Outside these hours callers hear the after-hours message and chats get the after-hours reply. Times are Lagos time.
            </p>
          </div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setEdit("new")}>
            + New schedule
          </button>
        </div>
        <DataState
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          isEmpty={profiles.length === 0}
          emptyTitle="No schedules yet"
          emptyHint="Without a schedule a number is treated as always open."
        >
          <div style={{ display: "grid", gap: 10 }}>
            {profiles.map((p) => {
              const week = rulesToWeek(p.rules);
              return (
                <div key={p.id} className="card card--soft">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <strong>{p.name}</strong>
                    <button type="button" className="btn btn--subtle btn--sm" onClick={() => setEdit(p)}>
                      Edit
                    </button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: "2px 10px", fontSize: 13 }}>
                    {WEEKDAYS.map((d, i) => (
                      <div key={d} style={{ display: "contents" }}>
                        <span style={{ color: "var(--ink-soft)" }}>{d}</span>
                        <span>{week[i]!.length ? week[i]!.map((w) => `${w.open}–${w.close}`).join(", ") : "Closed"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </DataState>
      </section>

      <Holidays holidays={holidays} profiles={profiles} onChanged={reload} />

      {edit && (
        <HoursEditor
          row={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function HoursEditor({ row, onClose, onSaved }: { row: HoursProfileRow | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [name, setName] = useState(row?.name ?? "");
  const [week, setWeek] = useState<WeekHours>(() =>
    row
      ? rulesToWeek(row.rules)
      : // Sensible default: Mon–Sat 8am–6pm.
        Array.from({ length: 7 }, (_, d) => (d === 0 ? [] : [{ open: "08:00", close: "18:00" }])),
  );
  const [busy, setBusy] = useState(false);
  const problem = validateWeek(week);

  const setDay = (d: number, windows: WeekHours[number]): void => setWeek((w) => w.map((x, i) => (i === d ? windows : x)));

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const body = { name: name.trim(), rules: weekToRules(week) };
      if (row) await settingsApi.updateHours(row.id, body);
      else await settingsApi.createHours(body);
      toast.success("Opening hours saved.");
      onSaved();
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={row ? `Edit ${row.name}` : "New schedule"} onClose={onClose} maxWidth={620}>
      <div style={{ display: "grid", gap: 12 }}>
        <label className="field">
          <span className="field__label">Schedule name</span>
          <input className="input" value={name} maxLength={60} placeholder="Shop hours" onChange={(e) => setName(e.target.value)} />
        </label>
        {WEEKDAYS.map((dayName, d) => {
          const windows = week[d]!;
          return (
            <div key={dayName} style={{ display: "grid", gap: 6, borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={windows.length > 0}
                    onChange={(e) => setDay(d, e.target.checked ? [{ open: "08:00", close: "18:00" }] : [])}
                  />
                  {dayName}
                </label>
                {windows.length === 0 ? (
                  <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>Closed</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setDay(d, [...windows, { open: windows[windows.length - 1]!.close, close: "24:00" }])}
                  >
                    <Plus size={13} /> Add a break
                  </button>
                )}
              </div>
              {windows.map((w, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    className="input"
                    type="time"
                    aria-label={`${dayName} opens`}
                    value={w.open}
                    onChange={(e) => setDay(d, windows.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))}
                    style={{ width: 130 }}
                  />
                  <span>to</span>
                  <input
                    className="input"
                    // "24:00" (midnight) isn't a valid <input type=time>; let people type it.
                    type={w.close === "24:00" ? "text" : "time"}
                    aria-label={`${dayName} closes`}
                    value={w.close}
                    onChange={(e) => setDay(d, windows.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))}
                    style={{ width: 130 }}
                  />
                  {windows.length > 1 && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      aria-label="Remove this time slot"
                      onClick={() => setDay(d, windows.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          );
        })}
        {problem && <div className="field__error">{problem}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={busy || !!problem || !name.trim()} onClick={() => void save()}>
            {busy ? "Saving…" : "Save hours"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Holidays({
  holidays,
  profiles,
  onChanged,
}: {
  holidays: Array<{ id: string; date: string; label: string; profileId: string | null }>;
  profiles: HoursProfileRow[];
  onChanged: () => void;
}): JSX.Element {
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");
  const [profileId, setProfileId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function add(): Promise<void> {
    setBusy("add");
    try {
      await settingsApi.addHoliday({ date, label: label.trim(), profile_id: profileId || null });
      setDate("");
      setLabel("");
      onChanged();
    } catch {
      /* toast shown */
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <h2 className="t-h2">Holidays</h2>
      <p style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 12 }}>Days you're closed all day, like Christmas or Eid.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
        <label className="field">
          <span className="field__label">Date</span>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 160 }}>
          <span className="field__label">Name</span>
          <input className="input" value={label} maxLength={80} placeholder="Christmas Day" onChange={(e) => setLabel(e.target.value)} />
        </label>
        {profiles.length > 1 && (
          <label className="field">
            <span className="field__label">Applies to</span>
            <select className="select" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">Every schedule</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="btn btn--primary btn--sm" disabled={!date || !label.trim() || busy === "add"} onClick={() => void add()}>
          {busy === "add" ? "Adding…" : "Add holiday"}
        </button>
      </div>
      {holidays.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>No holidays added.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {holidays.map((h) => (
                <tr key={h.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{h.date}</td>
                  <td>{h.label}</td>
                  <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                    {h.profileId ? profiles.find((p) => p.id === h.profileId)?.name ?? "One schedule" : "Every schedule"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy === h.id}
                      aria-label={`Remove ${h.label}`}
                      onClick={async () => {
                        setBusy(h.id);
                        try {
                          await settingsApi.deleteHoliday(h.id);
                          onChanged();
                        } catch {
                          /* toast shown */
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Phone menu (IVR) ─────────────────────────────────────────────────────────

const ACTION_LABEL = { ring_team: "Ring a team", voicemail: "Take a voicemail", play: "Read out a message" } as const;

export function SettingsIvr(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: settingsKeys.ivr, queryFn: settingsApi.ivr });
  const teams = useQuery({ queryKey: settingsKeys.teams, queryFn: settingsApi.teams });
  const [edit, setEdit] = useState<IvrMenuRow | "new" | null>(null);
  const teamName = (id: string | null): string => (teams.data ?? []).find((t) => t.id === id)?.name ?? "a team";

  return (
    <section className="card">
      <div className="card__head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div>
          <h2 className="t-h2">Phone menu</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 13 }}>"Press 1 for orders, 2 for deliveries…" — pick a menu for each number under Numbers.</p>
        </div>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setEdit("new")}>
          + New menu
        </button>
      </div>
      <DataState
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        isEmpty={(q.data ?? []).length === 0}
        emptyTitle="No phone menus yet"
        emptyHint="Without a menu, calls ring straight through to available staff."
      >
        <div style={{ display: "grid", gap: 10 }}>
          {(q.data ?? []).map((m) => (
            <div key={m.id} className="card card--soft">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <strong>{m.name}</strong>
                <button type="button" className="btn btn--subtle btn--sm" onClick={() => setEdit(m)}>
                  Edit
                </button>
              </div>
              <div style={{ fontSize: 13, fontStyle: "italic", marginBottom: 6 }}>"{m.greetingText}"</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {m.options.map((o) => (
                  <li key={o.id}>
                    <strong>{o.digit}</strong> — {o.label}: {o.action === "ring_team" ? `ring ${teamName(o.teamId)}` : ACTION_LABEL[o.action].toLowerCase()}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DataState>
      {edit && (
        <IvrEditor
          row={edit === "new" ? null : edit}
          teams={(teams.data ?? []).filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name }))}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            void qc.invalidateQueries({ queryKey: settingsKeys.ivr });
          }}
        />
      )}
    </section>
  );
}

function IvrEditor({
  row,
  teams,
  onClose,
  onSaved,
}: {
  row: IvrMenuRow | null;
  teams: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [name, setName] = useState(row?.name ?? "");
  const [greeting, setGreeting] = useState(row?.greetingText ?? "Welcome to Mrs. Samuel.");
  const [options, setOptions] = useState<MenuOptionDraft[]>(
    () =>
      row?.options.map((o) => ({ digit: o.digit, label: o.label, action: o.action, team_id: o.teamId, play_text: o.playText })) ?? [
        { digit: "1", label: "Orders", action: "ring_team", team_id: teams[0]?.id ?? null, play_text: null },
      ],
  );
  const [busy, setBusy] = useState(false);
  const input: MenuInput = { name: name.trim(), greeting_text: greeting.trim(), options };
  const problem = validateMenu(input);
  const patch = (i: number, p: Partial<MenuOptionDraft>): void => setOptions((os) => os.map((o, j) => (j === i ? { ...o, ...p } : o)));
  const nextDigit = (): string => ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].find((d) => !options.some((o) => o.digit === d)) ?? "";

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const body: MenuInput = {
        ...input,
        options: options.map((o) => ({
          ...o,
          label: o.label.trim(),
          team_id: o.action === "ring_team" ? o.team_id : null,
          play_text: o.action === "play" ? (o.play_text ?? "").trim() : null,
        })),
      };
      if (row) await settingsApi.updateIvr(row.id, body);
      else await settingsApi.createIvr(body);
      toast.success("Phone menu saved.");
      onSaved();
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={row ? `Edit ${row.name}` : "New phone menu"} onClose={onClose} maxWidth={640}>
      <div style={{ display: "grid", gap: 12 }}>
        <label className="field">
          <span className="field__label">Menu name</span>
          <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Greeting (read out to callers)</span>
          <textarea className="textarea" rows={3} value={greeting} maxLength={1000} onChange={(e) => setGreeting(e.target.value)} />
        </label>
        <div className="t-eyebrow">Options</div>
        {options.map((o, i) => (
          <div key={i} className="card card--soft" style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label className="field" style={{ width: 80 }}>
                <span className="field__label">Key</span>
                <select className="select" value={o.digit} onChange={(e) => patch(i, { digit: e.target.value })}>
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ flex: 1, minWidth: 140 }}>
                <span className="field__label">Label</span>
                <input className="input" value={o.label} maxLength={60} onChange={(e) => patch(i, { label: e.target.value })} />
              </label>
              <label className="field" style={{ minWidth: 170 }}>
                <span className="field__label">What happens</span>
                <select
                  className="select"
                  value={o.action}
                  onChange={(e) => patch(i, { action: e.target.value as MenuOptionDraft["action"] })}
                >
                  {(Object.keys(ACTION_LABEL) as Array<keyof typeof ACTION_LABEL>).map((a) => (
                    <option key={a} value={a}>
                      {ACTION_LABEL[a]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-label={`Remove key ${o.digit}`}
                onClick={() => setOptions((os) => os.filter((_, j) => j !== i))}
              >
                <Trash2 size={14} />
              </button>
            </div>
            {o.action === "ring_team" && (
              <label className="field">
                <span className="field__label">Team to ring</span>
                <select className="select" value={o.team_id ?? ""} onChange={(e) => patch(i, { team_id: e.target.value || null })}>
                  <option value="">Pick a team…</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {o.action === "play" && (
              <label className="field">
                <span className="field__label">Message to read out</span>
                <textarea className="textarea" rows={2} maxLength={1000} value={o.play_text ?? ""} onChange={(e) => patch(i, { play_text: e.target.value })} />
              </label>
            )}
          </div>
        ))}
        {options.length < 10 && (
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            style={{ justifySelf: "start" }}
            onClick={() => setOptions((os) => [...os, { digit: nextDigit(), label: "", action: "voicemail", team_id: null, play_text: null }])}
          >
            <Plus size={13} /> Add option
          </button>
        )}
        {problem && <div className="field__error">{problem}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={busy || !!problem} onClick={() => void save()}>
            {busy ? "Saving…" : "Save menu"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

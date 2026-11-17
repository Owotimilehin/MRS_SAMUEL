import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { DataState } from "../DataState.js";
import { Modal } from "../Modal.js";
import { ConfirmModal } from "../ConfirmModal.js";
import { settingsApi, settingsKeys, type NumberInput } from "../../lib/inbox-settings-api.js";
import { inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { toast } from "../../lib/toast.js";
import type { PhoneNumberRow } from "../../lib/inbox-types.js";

const CHANNEL_LABEL = { both: "WhatsApp + calls", whatsapp: "WhatsApp only", voice: "Calls only" } as const;

function qualityPill(q: string | null): JSX.Element {
  const v = (q ?? "").toUpperCase();
  if (!v) return <span className="pill pill--ink">Unknown</span>;
  if (v === "GREEN" || v === "HIGH") return <span className="pill pill--success">Good</span>;
  if (v === "YELLOW" || v === "MEDIUM") return <span className="pill pill--warning">Watch</span>;
  return <span className="pill pill--danger">Low</span>;
}

export function SettingsNumbers(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: settingsKeys.numbers, queryFn: settingsApi.numbers });
  const [edit, setEdit] = useState<PhoneNumberRow | "new" | null>(null);
  const [register, setRegister] = useState<PhoneNumberRow | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const reload = (): void => {
    void qc.invalidateQueries({ queryKey: settingsKeys.numbers });
    void qc.invalidateQueries({ queryKey: inboxKeys.me });
  };

  async function refresh(n: PhoneNumberRow): Promise<void> {
    setRefreshing(n.id);
    try {
      await settingsApi.refreshNumber(n.id);
      toast.success(`${n.label}: status updated from WhatsApp.`);
      reload();
    } catch {
      /* toast shown */
    } finally {
      setRefreshing(null);
    }
  }

  return (
    <section className="card">
      <div className="card__head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div>
          <h2 className="t-h2">Business numbers</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 13 }}>The phone numbers customers WhatsApp and call.</p>
        </div>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setEdit("new")}>
          + Add number
        </button>
      </div>
      <DataState
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        isEmpty={(q.data ?? []).length === 0}
        emptyTitle="No numbers yet"
        emptyHint="Add your first business number."
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Used for</th>
                <th>WhatsApp status</th>
                <th>Quality</th>
                <th className="table__num">Calls now</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((n) => (
                <tr key={n.id}>
                  <td>
                    <div style={{ fontWeight: 700 }}>{n.label}</div>
                    <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{n.e164}</div>
                    {!n.isActive && <span className="pill pill--ink">Switched off</span>}
                  </td>
                  <td>{CHANNEL_LABEL[n.channels]}</td>
                  <td>
                    {n.channels === "voice" ? (
                      "—"
                    ) : n.waStatus ? (
                      <span className={`pill ${/connected|registered/i.test(n.waStatus) ? "pill--success" : "pill--warning"}`}>
                        {n.waStatus.toLowerCase()}
                      </span>
                    ) : (
                      <span className="pill pill--ink">Not registered</span>
                    )}
                    {n.messagingLimit && (
                      <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>Limit: {n.messagingLimit.replace(/_/g, " ").toLowerCase()}</div>
                    )}
                  </td>
                  <td>{n.channels === "voice" ? "—" : qualityPill(n.qualityRating)}</td>
                  <td className="table__num">{n.calls_in_progress}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button type="button" className="btn btn--subtle btn--sm" style={{ marginRight: 6 }} onClick={() => setEdit(n)}>
                      Edit
                    </button>
                    {n.channels !== "voice" && n.waPhoneNumberId && (
                      <>
                        <button
                          type="button"
                          className="btn btn--subtle btn--sm"
                          style={{ marginRight: 6 }}
                          disabled={refreshing === n.id}
                          onClick={() => void refresh(n)}
                          title="Check status with WhatsApp"
                        >
                          <RefreshCw size={13} /> {refreshing === n.id ? "Checking…" : "Check"}
                        </button>
                        <button type="button" className="btn btn--subtle btn--sm" onClick={() => setRegister(n)}>
                          Register on WhatsApp
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataState>
      {edit && (
        <NumberForm
          row={edit === "new" ? null : edit}
          all={q.data ?? []}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
      {register && <RegisterDialog row={register} onClose={() => setRegister(null)} onDone={reload} />}
    </section>
  );
}

function blankToNull(s: string): string | null {
  return s.trim() ? s.trim() : null;
}

function NumberForm({
  row,
  all,
  onClose,
  onSaved,
}: {
  row: PhoneNumberRow | null;
  all: PhoneNumberRow[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const teams = useQuery({ queryKey: settingsKeys.teams, queryFn: settingsApi.teams });
  const hours = useQuery({ queryKey: settingsKeys.hours, queryFn: settingsApi.hours });
  const ivr = useQuery({ queryKey: settingsKeys.ivr, queryFn: settingsApi.ivr });
  const [f, setF] = useState({
    e164: row?.e164 ?? "",
    label: row?.label ?? "",
    channels: row?.channels ?? ("both" as NumberInput["channels"]),
    waba_id: row?.wabaId ?? "",
    wa_phone_number_id: row?.waPhoneNumberId ?? "",
    wa_fallback_number_id: row?.waFallbackNumberId ?? "",
    voice_provider: row?.voiceProvider ?? "twilio",
    inbound_match: row?.inboundMatch ?? "",
    max_concurrent_calls: row?.maxConcurrentCalls != null ? String(row.maxConcurrentCalls) : "",
    default_team_id: row?.defaultTeamId ?? "",
    hours_profile_id: row?.hoursProfileId ?? "",
    ivr_menu_id: row?.ivrMenuId ?? "",
    after_hours_text: row?.afterHoursText ?? "",
    is_active: row?.isActive ?? true,
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]): void => setF((x) => ({ ...x, [k]: v }));
  const wa = f.channels !== "voice";
  const voice = f.channels !== "whatsapp";

  async function save(): Promise<void> {
    const max = f.max_concurrent_calls.trim() ? Number(f.max_concurrent_calls) : null;
    if (max !== null && (!Number.isInteger(max) || max < 1)) {
      toast.error("Max calls at once must be a whole number, 1 or more.");
      return;
    }
    const body: NumberInput = {
      e164: f.e164.trim(),
      label: f.label.trim(),
      channels: f.channels,
      waba_id: blankToNull(f.waba_id),
      wa_phone_number_id: blankToNull(f.wa_phone_number_id),
      wa_fallback_number_id: blankToNull(f.wa_fallback_number_id),
      voice_provider: blankToNull(f.voice_provider),
      inbound_match: blankToNull(f.inbound_match),
      max_concurrent_calls: max,
      default_team_id: blankToNull(f.default_team_id),
      hours_profile_id: blankToNull(f.hours_profile_id),
      ivr_menu_id: blankToNull(f.ivr_menu_id),
      after_hours_text: blankToNull(f.after_hours_text),
      is_active: f.is_active,
    };
    setBusy(true);
    try {
      if (row) await settingsApi.updateNumber(row.id, body);
      else await settingsApi.createNumber(body);
      toast.success("Number saved.");
      onSaved();
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={row ? `Edit ${row.label}` : "Add a business number"} onClose={onClose} maxWidth={640}>
      <div style={{ display: "grid", gap: 12 }}>
        <div className="ibx-grid2">
          <label className="field">
            <span className="field__label">Name staff see</span>
            <input className="input" value={f.label} maxLength={60} placeholder="Main line" onChange={(e) => set("label", e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Phone number</span>
            <input className="input" inputMode="tel" value={f.e164} placeholder="+234 803 123 4567" onChange={(e) => set("e164", e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span className="field__label">Used for</span>
          <select className="select" value={f.channels} onChange={(e) => set("channels", e.target.value as NumberInput["channels"])}>
            <option value="both">WhatsApp and phone calls</option>
            <option value="whatsapp">WhatsApp only</option>
            <option value="voice">Phone calls only</option>
          </select>
        </label>

        {wa && (
          <fieldset className="card card--soft" style={{ display: "grid", gap: 10 }}>
            <legend className="t-eyebrow">WhatsApp</legend>
            <div className="ibx-grid2">
              <label className="field">
                <span className="field__label">WhatsApp Business Account ID</span>
                <input className="input" value={f.waba_id} onChange={(e) => set("waba_id", e.target.value)} />
              </label>
              <label className="field">
                <span className="field__label">Phone number ID (from Meta)</span>
                <input className="input" value={f.wa_phone_number_id} onChange={(e) => set("wa_phone_number_id", e.target.value)} />
              </label>
            </div>
            <label className="field">
              <span className="field__label">If WhatsApp fails, send from</span>
              <select className="select" value={f.wa_fallback_number_id} onChange={(e) => set("wa_fallback_number_id", e.target.value)}>
                <option value="">No fallback</option>
                {all
                  .filter((n) => n.id !== row?.id && n.channels !== "voice")
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
              </select>
            </label>
          </fieldset>
        )}

        {voice && (
          <fieldset className="card card--soft" style={{ display: "grid", gap: 10 }}>
            <legend className="t-eyebrow">Phone calls</legend>
            <div className="ibx-grid2">
              <label className="field">
                <span className="field__label">Phone provider</span>
                <input className="input" value={f.voice_provider} onChange={(e) => set("voice_provider", e.target.value)} />
              </label>
              <label className="field">
                <span className="field__label">Incoming call match</span>
                <input className="input" value={f.inbound_match} placeholder="Usually the number itself" onChange={(e) => set("inbound_match", e.target.value)} />
                <span className="field__hint">The "To" value the phone provider sends for this number.</span>
              </label>
              <label className="field">
                <span className="field__label">Max calls at once</span>
                <input className="input" inputMode="numeric" value={f.max_concurrent_calls} placeholder="No limit" onChange={(e) => set("max_concurrent_calls", e.target.value)} />
              </label>
              <label className="field">
                <span className="field__label">Phone menu</span>
                <select className="select" value={f.ivr_menu_id} onChange={(e) => set("ivr_menu_id", e.target.value)}>
                  <option value="">No menu — ring straight away</option>
                  {(ivr.data ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>
        )}

        <div className="ibx-grid2">
          <label className="field">
            <span className="field__label">Team that gets new chats</span>
            <select className="select" value={f.default_team_id} onChange={(e) => set("default_team_id", e.target.value)}>
              <option value="">No team</option>
              {(teams.data ?? []).filter((t) => t.isActive).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Opening hours</span>
            <select className="select" value={f.hours_profile_id} onChange={(e) => set("hours_profile_id", e.target.value)}>
              <option value="">Always open</option>
              {(hours.data?.profiles ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span className="field__label">After-hours message</span>
          <textarea
            className="textarea"
            rows={3}
            maxLength={600}
            value={f.after_hours_text}
            placeholder="Thanks for reaching out! We're closed now and will reply when we open."
            onChange={(e) => set("after_hours_text", e.target.value)}
          />
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={f.is_active} onChange={(e) => set("is_active", e.target.checked)} />
          <span>Number is in use</span>
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={busy || !f.label.trim() || !f.e164.trim()} onClick={() => void save()}>
            {busy ? "Saving…" : "Save number"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RegisterDialog({ row, onClose, onDone }: { row: PhoneNumberRow; onClose: () => void; onDone: () => void }): JSX.Element {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = /^\d{6}$/.test(pin);
  return (
    <ConfirmModal
      title={`Register ${row.label} on WhatsApp`}
      confirmLabel="Register"
      busyLabel="Registering…"
      busy={busy}
      confirmDisabled={!valid}
      onCancel={onClose}
      onConfirm={async () => {
        setBusy(true);
        try {
          await settingsApi.registerNumber(row.id, pin);
          toast.success(`${row.label} is registered on WhatsApp.`);
          onDone();
          onClose();
        } catch {
          /* toast shown */
        } finally {
          setBusy(false);
        }
      }}
    >
      <div style={{ display: "grid", gap: 10 }}>
        <div className="card" style={{ borderColor: "rgba(232,149,28,0.4)", background: "rgba(232,149,28,0.08)", fontSize: 14 }}>
          <strong>Careful:</strong> Meta only allows <strong>10 tries every 72 hours</strong>. Use the 6-digit two-step
          verification PIN for this number. If you don't know it, stop and check first.
        </div>
        <label className="field">
          <span className="field__label">6-digit PIN</span>
          <input
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
        </label>
      </div>
    </ConfirmModal>
  );
}

/** Templates list + "Sync from WhatsApp". */
export function SettingsTemplates(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: inboxKeys.templates, queryFn: inboxApi.templates });
  const [busy, setBusy] = useState(false);
  return (
    <section className="card">
      <div className="card__head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div>
          <h2 className="t-h2">Message templates</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 13 }}>
            Templates are created and approved in WhatsApp Manager. Sync to bring the latest here.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await inboxApi.syncTemplates();
              toast.success(`Synced ${r.synced} template${r.synced === 1 ? "" : "s"} from WhatsApp.`);
              await qc.invalidateQueries({ queryKey: inboxKeys.templates });
            } catch {
              /* toast shown */
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw size={13} /> {busy ? "Syncing…" : "Sync from WhatsApp"}
        </button>
      </div>
      <DataState
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        isEmpty={(q.data ?? []).length === 0}
        emptyTitle="No templates yet"
        emptyHint="Create templates in WhatsApp Manager, then press Sync."
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Language</th>
                <th>Type</th>
                <th>Status</th>
                <th className="table__num">Blanks to fill</th>
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((t) => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 600 }}>{t.name}</td>
                  <td>{t.language}</td>
                  <td>{(t.category ?? "—").toLowerCase()}</td>
                  <td>
                    <span className={`pill ${t.status.toUpperCase() === "APPROVED" ? "pill--success" : t.status.toUpperCase() === "REJECTED" ? "pill--danger" : "pill--warning"}`}>
                      {t.status.toLowerCase()}
                    </span>
                  </td>
                  <td className="table__num">{t.param_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataState>
    </section>
  );
}

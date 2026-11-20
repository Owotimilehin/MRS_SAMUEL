/**
 * Call settings: the call-only parts of what used to be Inbox settings. The
 * screens are the shop admin's own (SettingsNumbers, SettingsIvr), so the
 * rules and saving work exactly as there.
 *
 * Opening hours and teams drive both chats and calls, so they stay in one
 * place, Message settings, and this page links to them.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import { GreetingUpload } from "@admin/components/inbox/GreetingUpload.js";
import { SettingsNumbers } from "@admin/components/inbox/SettingsNumbers.js";
import { SettingsIvr } from "@admin/components/inbox/SettingsHours.js";
import { setAvailable, useVoice } from "@admin/lib/inbox-voice.js";
import "@admin/components/inbox/inbox.css";
import "./calls.css";
import { callKeys, callsApi } from "./calls-api.js";
import { boardKeys, callFeaturesApi, type CallFeatures } from "./switchboard-api.js";
import { minutesLabel } from "./switchboard-logic.js";

type Tab = "numbers" | "ivr";

const TABS: { key: Tab; label: string }[] = [
  { key: "numbers", label: "Phone numbers" },
  { key: "ivr", label: "Phone menu" },
];

export function CallsSettingsPage(): JSX.Element {
  const can = useCan();
  const [tab, setTab] = useState<Tab>("numbers");
  const configured = useQuery({ queryKey: callKeys.voiceStatus, queryFn: callsApi.voiceConfigured, staleTime: 5 * 60_000, retry: false });

  if (!can("inbox.settings")) {
    return (
      <Frame title="Call settings">
        <div className="card">You don&apos;t have access to call settings. Ask the owner.</div>
      </Frame>
    );
  }

  return (
    <Frame title="Call settings" crumb="Calls">
      <p className="cl-sub">Which numbers take calls, what callers hear, and whether calls ring on this device.</p>
      <div className="cl-cards">
        {configured.data === false && (
          <section className="card">
            <h2 className="t-h2">Calling is not set up</h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: "4px 0 0" }}>
              The phone provider is not connected on this system yet, so no calls can ring or be made. You can still get the settings below
              ready.
            </p>
          </section>
        )}
        {configured.data === true && can("calls.answer") && <TakingCalls />}

        <div>
          <div className="ibx-tabs" role="tablist" aria-label="Call settings sections" style={{ marginBottom: 16, flexWrap: "wrap" }}>
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                className={`ibx-tab${tab === t.key ? " is-active" : ""}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="ibx-settings">
            {tab === "numbers" && <SettingsNumbers only="calls" />}
            {tab === "ivr" && <SettingsIvr />}
          </div>
        </div>

        <QueueAndSupervisorSettings />

        <section className="card cl-link-card">
          <div>
            <h2 className="t-h2">Opening hours</h2>
            <p>
              Outside opening hours callers hear the after-hours message and can leave a voicemail. The same hours decide when chats get the
              after-hours reply, so they are kept in Message settings.
            </p>
          </div>
          <Link to="/inbox/settings" search={{ tab: "hours" }} className="btn btn--subtle btn--sm">
            Open opening hours
          </Link>
        </section>

        <section className="card cl-link-card">
          <div>
            <h2 className="t-h2">Teams</h2>
            <p>A phone menu option can ring a team. Teams also share out chats, so they are kept in Message settings.</p>
          </div>
          <Link to="/inbox/settings" search={{ tab: "teams" }} className="btn btn--subtle btn--sm">
            Open teams
          </Link>
        </section>
      </div>
    </Frame>
  );
}

/** The same "take calls" switch as the call bar at the bottom of the screen, for this device. */
function TakingCalls(): JSX.Element {
  const v = useVoice();
  return (
    <section className="card cl-link-card">
      <div>
        <h2 className="t-h2">Taking calls on this device</h2>
        <p>
          When this is on, customer calls ring here. It is the same switch as in the call bar at the bottom of the screen, and it only
          changes this device.
        </p>
      </div>
      <label className="cl-switch">
        <input
          type="checkbox"
          role="switch"
          className={`callbar__switch${v.available && v.status === "loading" ? " is-busy" : ""}`}
          checked={v.available}
          onChange={(e) => void setAvailable(e.target.checked)}
        />
        <span>{v.available ? (v.status === "loading" ? "Connecting…" : "Taking calls") : "Off"}</span>
      </label>
    </section>
  );
}

/**
 * The owner's beta switch. Off (the default) calls are connected exactly as
 * before. On: callers wait in a queue with hold music when everyone is busy,
 * and the switchboard can listen in, whisper and join.
 */
function QueueAndSupervisorSettings(): JSX.Element {
  const qc = useQueryClient();
  const current = useQuery({ queryKey: boardKeys.features, queryFn: callFeaturesApi.get });
  const [draft, setDraft] = useState<CallFeatures | null>(null);
  const [saving, setSaving] = useState(false);
  const form = draft ?? current.data ?? null;
  const changed = !!draft && JSON.stringify(draft) !== JSON.stringify(current.data);

  async function save(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    try {
      await callFeaturesApi.save(draft);
      await qc.invalidateQueries({ queryKey: boardKeys.features });
      await qc.invalidateQueries({ queryKey: boardKeys.board });
      setDraft(null);
      toast.success(draft.enabled ? "Call queue and supervisor tools are on." : "Saved. Calls connect as before.");
    } catch {
      // api() already showed what went wrong.
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card" style={{ display: "grid", gap: 12 }}>
      <div className="cl-link-card">
        <div>
          <h2 className="t-h2">
            Call queue and supervisor tools <span className="pill pill--warning">Beta</span>
          </h2>
          <p>
            When everyone is busy, callers wait in a queue with hold music and hear their place in line, instead of going to voicemail. On
            the Switchboard, managers can listen in to a call, whisper to the staff member, or join it. Off, calls connect exactly as before.
          </p>
        </div>
        {form && (
          <label className="cl-switch">
            <input
              type="checkbox"
              role="switch"
              className="callbar__switch"
              checked={form.enabled}
              onChange={(e) => setDraft({ ...form, enabled: e.target.checked })}
            />
            <span>{form.enabled ? "On" : "Off"}</span>
          </label>
        )}
      </div>
      {form?.enabled && (
        <>
          <label className="field" style={{ margin: 0, maxWidth: 320 }}>
            <span className="field__label">Longest wait before voicemail</span>
            <select
              className="select"
              value={form.max_wait_s}
              onChange={(e) => setDraft({ ...form, max_wait_s: Number(e.target.value) })}
            >
              {[60, 120, 180, 300, 600, 900, 1800].map((s) => (
                <option key={s} value={s}>
                  {minutesLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <div className="field" style={{ margin: 0 }}>
            <span className="field__label">Hold music</span>
            <p className="cl-fine" style={{ marginBottom: 6 }}>
              Upload music you own or have a licence for (MP3 or WAV). Without one, callers hear a short &quot;please hold&quot; message and
              quiet in between.
            </p>
            <GreetingUpload audioKey={form.hold_audio_key} what="the quiet hold" onChange={(key) => setDraft({ ...form, hold_audio_key: key })} />
          </div>
        </>
      )}
      {changed && (
        <div className="cl-sb-actions">
          <button type="button" className="btn btn--primary btn--sm" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={saving} onClick={() => setDraft(null)}>
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

/** Inbox settings: the reply-time target (suite spec 15). Off by default. */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { REPLY_TARGET_MAX, REPLY_TARGET_MIN } from "@ms/shared";
import { DataState } from "../DataState.js";
import { inboxKeys } from "../../lib/inbox-api.js";
import { settingsApi, settingsKeys } from "../../lib/inbox-settings-api.js";
import { toast } from "../../lib/toast.js";

export function SettingsReplyTarget(): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: settingsKeys.replyTarget, queryFn: settingsApi.replyTarget });
  const [on, setOn] = useState(false);
  const [minutes, setMinutes] = useState("15");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.data === undefined) return;
    setOn(q.data !== null);
    if (q.data !== null) setMinutes(String(q.data));
  }, [q.data]);

  const n = Number(minutes);
  const problem =
    on && (!Number.isInteger(n) || n < REPLY_TARGET_MIN || n > REPLY_TARGET_MAX)
      ? `Use a whole number of minutes from ${REPLY_TARGET_MIN} to ${REPLY_TARGET_MAX}.`
      : null;
  const dirty = q.data !== undefined && (on ? q.data !== n : q.data !== null);

  async function save(): Promise<void> {
    if (problem) return;
    setBusy(true);
    try {
      await settingsApi.setReplyTarget(on ? n : null);
      toast.success(on ? `Reply target set to ${n} minutes` : "Reply target turned off");
      void qc.invalidateQueries({ queryKey: settingsKeys.replyTarget });
      void qc.invalidateQueries({ queryKey: inboxKeys.lists });
      void qc.invalidateQueries({ queryKey: inboxKeys.replyTarget });
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="ibx-cardhead">
        <div>
          <h2 className="t-h2">Reply time</h2>
          <p style={{ color: "var(--ink-soft)", fontSize: 13 }}>
            Flag chats where a customer has waited too long for an answer. Chats waiting longer show in amber, and in red at twice the
            time. Only time inside each line&apos;s opening hours counts; holidays are skipped. A line with no schedule counts every minute.
          </p>
        </div>
      </div>
      <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        <div style={{ display: "grid", gap: 12, maxWidth: 460 }}>
          <div className="ibx-tabs" role="radiogroup" aria-label="Reply-time target">
            {[
              { key: false, label: "Off" },
              { key: true, label: "On" },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={on === o.key}
                className={`ibx-tab${on === o.key ? " is-active" : ""}`}
                onClick={() => setOn(o.key)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {on && (
            <label className="field">
              <span className="field__label">Reply within this many minutes during opening hours</span>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={REPLY_TARGET_MIN}
                max={REPLY_TARGET_MAX}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                style={{ maxWidth: 140 }}
              />
              {problem && <span className="field__hint" style={{ color: "var(--danger)" }}>{problem}</span>}
            </label>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" className="btn btn--primary" disabled={busy || !!problem || !dirty} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </DataState>
    </section>
  );
}

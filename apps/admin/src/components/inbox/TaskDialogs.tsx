/**
 * Snooze and reminders (suite spec 15), shared by the admin app and the suite:
 *   SnoozeDialog    — "Snooze until…" with Lagos-time quick choices or a date and time
 *   ReminderDialog  — add or move a reminder (note, when, for whom)
 *   ReminderStrip   — a chat's open reminders under its header, with Done
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Check } from "lucide-react";
import { REMINDER_NOTE_MAX, reminderTimeProblem, snoozeTimeProblem } from "@ms/shared";
import { Modal } from "../Modal.js";
import { inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { dateToLagosInput, lagosInputToDate, reminderDue, snoozePresets, staffLabel, whenLabel } from "../../lib/inbox-logic.js";
import type { ReminderRow, StaffMember } from "../../lib/inbox-types.js";

/** Quick choices plus "Pick a date and time"; reports the chosen instant (or null while incomplete). */
function WhenPicker({
  withHour,
  closesAt,
  initial,
  onChange,
}: {
  withHour?: boolean | undefined;
  closesAt?: string | null | undefined;
  initial?: Date | undefined;
  onChange: (at: Date | null) => void;
}): JSX.Element {
  const presets = useMemo(() => snoozePresets(new Date(), { withHour, closesAt }), [withHour, closesAt]);
  const [choice, setChoice] = useState<string>(initial ? "custom" : (presets[0]?.key ?? "custom"));
  const start = dateToLagosInput(initial ?? presets[presets.length - 1]!.at);
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);

  function pick(key: string, d = date, t = time): void {
    setChoice(key);
    if (key === "custom") onChange(lagosInputToDate(d, t));
    else onChange(presets.find((p) => p.key === key)?.at ?? null);
  }

  return (
    <div className="ibx-when">
      <div className="ibx-tabs ibx-when__choices" role="radiogroup" aria-label="When">
        {presets.map((p) => (
          <button
            key={p.key}
            type="button"
            role="radio"
            aria-checked={choice === p.key}
            className={`ibx-tab${choice === p.key ? " is-active" : ""}`}
            onClick={() => pick(p.key)}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={choice === "custom"}
          className={`ibx-tab${choice === "custom" ? " is-active" : ""}`}
          onClick={() => pick("custom")}
        >
          Pick a date and time
        </button>
      </div>
      {choice === "custom" && (
        <div className="ibx-when__custom">
          <label className="field">
            <span className="field__label">Date</span>
            <input
              className="input"
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                pick("custom", e.target.value, time);
              }}
            />
          </label>
          <label className="field">
            <span className="field__label">Time (Lagos)</span>
            <input
              className="input"
              type="time"
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                pick("custom", date, e.target.value);
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}

export function SnoozeDialog({
  conversationId,
  closesAt,
  onClose,
  onDone,
}: {
  conversationId: string;
  /** The line's closing time today, for "Later today" (see snoozePresets). */
  closesAt?: string | null | undefined;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const first = useMemo(() => snoozePresets(new Date(), { closesAt })[0]?.at ?? null, [closesAt]);
  const [at, setAt] = useState<Date | null>(first);
  const [busy, setBusy] = useState(false);
  const problem = at ? snoozeTimeProblem(at) : "Pick a date and time.";

  async function save(): Promise<void> {
    if (!at || problem) return;
    setBusy(true);
    try {
      await inboxApi.snooze(conversationId, at);
      onDone();
      onClose();
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Snooze this chat" onClose={onClose} maxWidth={520}>
      <p className="ibx-when__help">The chat leaves your open lists and comes back to the top at the time you pick.</p>
      <WhenPicker closesAt={closesAt} onChange={setAt} />
      <p className="ibx-when__result" aria-live="polite">
        {problem ? <span className="ibx-when__problem">{problem}</span> : <>Comes back {whenLabel(at!)}</>}
      </p>
      <p className="ibx-when__help">If the customer writes before then, the chat comes back straight away.</p>
      <div className="ibx-dialog-actions">
        <button type="button" className="btn btn--subtle" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={busy || !!problem} onClick={() => void save()}>
          {busy ? "Snoozing…" : "Snooze"}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Add a reminder on a chat or a contact, or move an existing one (`editing`).
 * "For" is offered only to people who may assign work (inbox.assign).
 */
export function ReminderDialog({
  target,
  editing,
  meId,
  staff,
  canAssign,
  onClose,
  onDone,
}: {
  target?: { conversationId: string } | { customerId: string };
  editing?: ReminderRow;
  meId: string;
  staff: StaffMember[];
  canAssign: boolean;
  onClose: () => void;
  onDone?: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [note, setNote] = useState(editing?.note ?? "");
  const [at, setAt] = useState<Date | null>(() => (editing ? new Date(editing.due_at) : (snoozePresets(new Date(), { withHour: true })[0]?.at ?? null)));
  const [assignee, setAssignee] = useState(editing?.assignee_id ?? meId);
  const [busy, setBusy] = useState(false);
  const problem = !note.trim() ? "Write what needs doing." : at ? reminderTimeProblem(at) : "Pick a date and time.";

  async function save(): Promise<void> {
    if (problem || !at) return;
    setBusy(true);
    try {
      if (editing) {
        await inboxApi.updateReminder(editing.id, {
          note: note.trim(),
          due_at: at.toISOString(),
          ...(assignee !== editing.assignee_id ? { assignee_id: assignee } : {}),
        });
      } else {
        await inboxApi.addReminder({
          note: note.trim(),
          due_at: at.toISOString(),
          ...(assignee !== meId ? { assignee_id: assignee } : {}),
          ...(target && "conversationId" in target ? { conversation_id: target.conversationId } : {}),
          ...(target && "customerId" in target ? { customer_id: target.customerId } : {}),
        });
      }
      void qc.invalidateQueries({ queryKey: inboxKeys.reminders });
      onDone?.();
      onClose();
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? "Move reminder" : "Add a reminder"} onClose={onClose} maxWidth={540}>
      <label className="field">
        <span className="field__label">What needs doing</span>
        <textarea
          className="input"
          rows={2}
          maxLength={REMINDER_NOTE_MAX}
          value={note}
          placeholder="Call back about the party order"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="field">
        <span className="field__label">When</span>
        <WhenPicker withHour initial={editing ? new Date(editing.due_at) : undefined} onChange={setAt} />
      </div>
      {canAssign && staff.length > 0 && (
        <label className="field">
          <span className="field__label">For</span>
          <select className="select" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value={meId}>Me</option>
            {staff
              .filter((s) => s.id !== meId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {staffLabel(s.name)}
                </option>
              ))}
          </select>
        </label>
      )}
      <p className="ibx-when__result" aria-live="polite">
        {problem ? <span className="ibx-when__problem">{problem}</span> : <>Due {whenLabel(at!)}</>}
      </p>
      <div className="ibx-dialog-actions">
        <button type="button" className="btn btn--subtle" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={busy || !!problem} onClick={() => void save()}>
          {busy ? "Saving…" : "Save reminder"}
        </button>
      </div>
    </Modal>
  );
}

/** A chat's open reminders, shown under its header. Nothing when there are none. */
export function ReminderStrip({ conversationId, meId, canAssign }: { conversationId: string; meId: string; canAssign: boolean }): JSX.Element | null {
  const qc = useQueryClient();
  const filter = { conversationId };
  const q = useQuery({ queryKey: inboxKeys.reminderList(filter), queryFn: () => inboxApi.reminders(filter), refetchInterval: 60_000 });
  const rows = q.data ?? [];
  if (rows.length === 0) return null;

  async function done(r: ReminderRow): Promise<void> {
    try {
      await inboxApi.updateReminder(r.id, { done: true });
      void qc.invalidateQueries({ queryKey: inboxKeys.reminders });
    } catch {
      /* toast shown by api() */
    }
  }

  return (
    <ul className="ibx-reminders" aria-label="Reminders on this chat">
      {rows.map((r) => {
        const due = reminderDue(r.due_at, r.done_at);
        const mayChange = r.assignee_id === meId || r.created_by === meId || canAssign;
        return (
          <li key={r.id} className="ibx-reminders__item">
            <BellRing size={14} aria-hidden />
            <span className="ibx-reminders__note">{r.note}</span>
            <span className={`pill pill--${due.tone === "neutral" ? "ink" : due.tone}`}>{due.label}</span>
            {r.assignee_id !== meId && <span className="ibx-reminders__who">for {staffLabel(r.assignee_name)}</span>}
            {mayChange && (
              <button type="button" className="btn btn--subtle btn--sm" onClick={() => void done(r)}>
                <Check size={14} /> Done
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

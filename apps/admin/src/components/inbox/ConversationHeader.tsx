import { useState } from "react";
import { AlarmClock, ArrowLeft, BellPlus, Phone, Tag, UserRound, CheckCircle2, RotateCcw, Sun } from "lucide-react";
import { ChannelIcon } from "./ChannelIcon.js";
import { toE164 } from "@ms/shared";
import { Modal } from "../Modal.js";
import { inboxApi } from "../../lib/inbox-api.js";
import { contactName, identityName, parseLabels, prettyPhone, staffLabel, whenLabel } from "../../lib/inbox-logic.js";
import { ReminderDialog, ReminderStrip, SnoozeDialog } from "./TaskDialogs.js";
import { startCall, useVoice } from "../../lib/inbox-voice.js";
import type { ConversationDetail, InboxTeamLite, StaffMember } from "../../lib/inbox-types.js";

interface Props {
  conv: ConversationDetail;
  meId: string;
  staff: StaffMember[];
  teams: InboxTeamLite[];
  can: (cap: string) => boolean;
  onBack: () => void;
  onChanged: () => void;
  onShowContact: () => void;
}

export function ConversationHeader({ conv, meId, staff, teams, can, onBack, onChanged, onShowContact }: Props): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  // Suite spec 15: snooze and reminders.
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);
  const snoozedUntil = conv.snoozedUntil && new Date(conv.snoozedUntil).getTime() > Date.now() ? conv.snoozedUntil : null;
  const canSnooze = can("inbox.reply") && conv.status !== "closed";
  const onCall = useVoice((s) => s.active !== null);
  const name = contactName(conv.customer?.name, conv.customer?.phone, identityName(conv.identity));
  const canAssign = can("inbox.assign");

  async function wake(): Promise<void> {
    setBusy(true);
    try {
      await inboxApi.unsnooze(conv.id);
      onChanged();
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  async function patch(p: Parameters<typeof inboxApi.patchConversation>[1]): Promise<void> {
    setBusy(true);
    try {
      await inboxApi.patchConversation(conv.id, p);
      onChanged();
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  // Only a phone line can place a call; a Facebook Page or Instagram account never can.
  const callable =
    can("calls.outbound") &&
    conv.can_use_number &&
    conv.number &&
    (conv.number.kind ?? "phone") === "phone" &&
    conv.number.channels !== "whatsapp" &&
    !!conv.customer;
  const customerE164 = toE164(conv.customer?.phone);

  const assigneeSelect = canAssign ? (
    <select
      className="ibx-select"
      aria-label="Assigned to"
      title="Who is looking after this chat"
      value={conv.assigneeId ?? ""}
      disabled={busy}
      onChange={(e) => void patch({ assignee_id: e.target.value || null })}
    >
      <option value="">Unassigned</option>
      {staff.map((s) => (
        <option key={s.id} value={s.id}>
          {s.id === meId ? "Me" : staffLabel(s.name)}
        </option>
      ))}
    </select>
  ) : conv.assigneeId !== meId ? (
    <button type="button" className="btn btn--subtle btn--sm" disabled={busy} onClick={() => void patch({ assignee_id: meId })}>
      <UserRound size={14} /> Take it
    </button>
  ) : (
    <span className="pill pill--accent">Assigned to you</span>
  );

  return (
    <>
      <div className="ibx-conv__head">
        <button type="button" className="btn btn--ghost btn--sm ibx-back" aria-label="Back to conversations" onClick={onBack}>
          <ArrowLeft size={16} />
        </button>
        <div className="ibx-conv__title">
          <button type="button" className="ibx-conv__who" onClick={onShowContact} title="Contact details">
            <div className="ibx-conv__name">{name}</div>
            <div className="ibx-conv__sub">
              {conv.number && (
                <>
                  <ChannelIcon channel={conv.channel} callsOnly={(conv.number.kind ?? "phone") === "phone" && conv.number.channels === "voice"} size={12} />{" "}
                </>
              )}
              {[
                conv.number?.label ?? "",
                conv.team?.name ?? "",
                conv.status === "closed" ? "Closed" : conv.status === "pending" ? "Pending" : "",
                conv.customer?.name?.trim() ? prettyPhone(conv.customer.phone) : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </button>
          {snoozedUntil && (
            <div className="ibx-conv__labels">
              <span className="pill pill--accent">Snoozed until {whenLabel(snoozedUntil)}</span>
            </div>
          )}
          {conv.labels.length > 0 && (
            <div className="ibx-conv__labels">
              {conv.labels.map((l) => (
                <span key={l} className="ibx-chip">
                  {l}
                </span>
              ))}
            </div>
          )}
        </div>
        {conv.customer && (
          <button type="button" className="btn btn--subtle btn--sm ibx-contact-btn" onClick={onShowContact} title="Contact details and notes">
            <UserRound size={14} /> Contact
          </button>
        )}
        {can("inbox.close") &&
          (conv.status === "closed" ? (
            <button type="button" className="btn btn--subtle btn--sm ibx-close-btn" disabled={busy} onClick={() => void patch({ status: "open" })}>
              <RotateCcw size={14} /> Reopen chat
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--subtle btn--sm ibx-close-btn"
              disabled={busy}
              title="Mark this chat as finished"
              onClick={() => void patch({ status: "closed" })}
            >
              <CheckCircle2 size={14} /> Close chat
            </button>
          ))}
        {callable && (
          <button
            type="button"
            className="btn btn--call btn--sm ibx-call-btn"
            aria-label="Call"
            disabled={onCall}
            title={onCall ? "You're already on a call" : `Call from ${conv.number!.label}`}
            onClick={() =>
              void startCall({ to: customerE164 ?? conv.customer!.id, numberId: conv.number!.id, who: name })
            }
          >
            <Phone size={14} /> <span className="ibx-hide-phone">Call</span>
          </button>
        )}
        <span className="ibx-conv__break" aria-hidden />
        <div className="ibx-conv__actions">
          {assigneeSelect}
          {canAssign && teams.length > 0 && (
            <select
              className="ibx-select"
              aria-label="Team"
              title="Team this chat belongs to"
              value={conv.teamId ?? ""}
              disabled={busy}
              onChange={(e) => void patch({ team_id: e.target.value || null })}
            >
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          {can("inbox.reply") && (
            <button type="button" className="btn btn--subtle btn--sm ibx-labels-btn" onClick={() => setLabelsOpen(true)} title="Labels" aria-label="Labels">
              <Tag size={14} /> <span className="ibx-hide-phone">Labels</span>
            </button>
          )}
          {canSnooze &&
            (snoozedUntil ? (
              <button type="button" className="btn btn--subtle btn--sm" disabled={busy} onClick={() => void wake()} title="Bring this chat back now" aria-label="Wake now">
                <Sun size={14} /> <span className="ibx-hide-phone">Wake now</span>
              </button>
            ) : (
              <button type="button" className="btn btn--subtle btn--sm" onClick={() => setSnoozeOpen(true)} title="Put this chat away until later" aria-label="Snooze">
                <AlarmClock size={14} /> <span className="ibx-hide-phone">Snooze</span>
              </button>
            ))}
          <button type="button" className="btn btn--subtle btn--sm" onClick={() => setRemindOpen(true)} title="Remind me about this chat" aria-label="Remind">
            <BellPlus size={14} /> <span className="ibx-hide-phone">Remind</span>
          </button>
        </div>
      </div>
      <ReminderStrip conversationId={conv.id} meId={meId} canAssign={canAssign} />
      {snoozeOpen && <SnoozeDialog conversationId={conv.id} onClose={() => setSnoozeOpen(false)} onDone={onChanged} />}
      {remindOpen && (
        <ReminderDialog
          target={{ conversationId: conv.id }}
          meId={meId}
          staff={staff}
          canAssign={canAssign}
          onClose={() => setRemindOpen(false)}
        />
      )}
      {labelsOpen && (
        <LabelsModal
          initial={conv.labels}
          onClose={() => setLabelsOpen(false)}
          onSave={async (labels) => {
            await patch({ labels });
            setLabelsOpen(false);
          }}
        />
      )}
    </>
  );
}

function LabelsModal({
  initial,
  onClose,
  onSave,
}: {
  initial: string[];
  onClose: () => void;
  onSave: (labels: string[]) => Promise<void>;
}): JSX.Element {
  const [value, setValue] = useState(initial.join(", "));
  const [busy, setBusy] = useState(false);
  const parsed = parseLabels(value);
  return (
    <Modal title="Labels" onClose={onClose}>
      <label className="field">
        <span className="field__label">Labels, separated by commas</span>
        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="vip, delivery, complaint" />
        <span className="field__hint">Labels help you find chats later. Up to 20.</span>
      </label>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", margin: "10px 0" }}>
        {parsed.map((l) => (
          <span key={l} className="ibx-chip">
            {l}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="btn btn--subtle" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onSave(parsed);
            setBusy(false);
          }}
        >
          {busy ? "Saving…" : "Save labels"}
        </button>
      </div>
    </Modal>
  );
}

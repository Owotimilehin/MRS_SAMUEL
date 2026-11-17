import { useState } from "react";
import { ArrowLeft, Phone, Tag, UserRound, CheckCircle2, RotateCcw } from "lucide-react";
import { toE164 } from "@ms/shared";
import { Modal } from "../Modal.js";
import { inboxApi } from "../../lib/inbox-api.js";
import { contactName, parseLabels } from "../../lib/inbox-logic.js";
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
  const onCall = useVoice((s) => s.active !== null);
  const name = contactName(conv.customer?.name, conv.customer?.phone);
  const canAssign = can("inbox.assign");

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

  const callable =
    can("calls.outbound") && conv.can_use_number && conv.number && conv.number.channels !== "whatsapp" && !!conv.customer;
  const customerE164 = toE164(conv.customer?.phone);

  return (
    <div className="ibx-conv__head">
      <button type="button" className="btn btn--ghost btn--sm ibx-back" aria-label="Back to conversations" onClick={onBack}>
        <ArrowLeft size={16} />
      </button>
      <div className="ibx-conv__title">
        <button
          type="button"
          onClick={onShowContact}
          style={{ background: "none", border: 0, padding: 0, textAlign: "left", cursor: "pointer", color: "inherit" }}
          title="Contact details"
        >
          <div className="ibx-conv__name">{name}</div>
          <div className="ibx-conv__sub">
            {conv.customer?.phone ?? ""} · {conv.number?.label ?? "—"}
            {conv.team ? ` · ${conv.team.name}` : ""}
            {conv.status === "closed" ? " · Closed" : conv.status === "pending" ? " · Pending" : ""}
          </div>
        </button>
        {conv.labels.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
            {conv.labels.map((l) => (
              <span key={l} className="ibx-chip">
                {l}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="ibx-conv__actions">
        {canAssign ? (
          <select
            className="select"
            aria-label="Assigned to"
            value={conv.assigneeId ?? ""}
            disabled={busy}
            onChange={(e) => void patch({ assignee_id: e.target.value || null })}
            style={{ fontSize: 12, maxWidth: 170 }}
          >
            <option value="">Unassigned</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id === meId ? `Me (${s.name})` : s.name}
              </option>
            ))}
          </select>
        ) : conv.assigneeId !== meId ? (
          <button type="button" className="btn btn--subtle btn--sm" disabled={busy} onClick={() => void patch({ assignee_id: meId })}>
            <UserRound size={14} /> Take it
          </button>
        ) : (
          <span className="pill pill--accent">Assigned to you</span>
        )}
        {canAssign && teams.length > 0 && (
          <select
            className="select"
            aria-label="Team"
            value={conv.teamId ?? ""}
            disabled={busy}
            onChange={(e) => void patch({ team_id: e.target.value || null })}
            style={{ fontSize: 12, maxWidth: 150 }}
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
          <button type="button" className="btn btn--subtle btn--sm" onClick={() => setLabelsOpen(true)} title="Labels">
            <Tag size={14} /> Labels
          </button>
        )}
        {can("inbox.close") &&
          (conv.status === "closed" ? (
            <button type="button" className="btn btn--subtle btn--sm" disabled={busy} onClick={() => void patch({ status: "open" })}>
              <RotateCcw size={14} /> Reopen
            </button>
          ) : (
            <button type="button" className="btn btn--subtle btn--sm" disabled={busy} onClick={() => void patch({ status: "closed" })}>
              <CheckCircle2 size={14} /> Close
            </button>
          ))}
        {callable && (
          <button
            type="button"
            className="btn btn--call btn--sm"
            disabled={onCall}
            title={onCall ? "You're already on a call" : `Call from ${conv.number!.label}`}
            onClick={() =>
              void startCall({ to: customerE164 ?? conv.customer!.id, numberId: conv.number!.id, who: name })
            }
          >
            <Phone size={14} /> Call
          </button>
        )}
      </div>
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
    </div>
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

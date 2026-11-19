import { useState } from "react";
import { ConfirmModal } from "../ConfirmModal.js";
import { inboxApi } from "../../lib/inbox-api.js";
import { toast } from "../../lib/toast.js";
import { flowAddressPreview, flowCardActions, flowHandledText, formatFlowValue, timeOfDay } from "../../lib/inbox-logic.js";
import type { FlowResponseAction, FlowResponseCard, FlowSent } from "../../lib/inbox-types.js";

/** Under an outbound form message: the button the customer sees (not clickable here) and which form it opens. */
export function FlowSentRow({ flow }: { flow: FlowSent }): JSX.Element {
  return (
    <>
      <div className="ibx-flow-cta">📋 {flow.cta}</div>
      <div className="ibx-msg__caption">Form: {flow.title}</div>
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  handled: "Mark as handled",
  reopen: "Mark as not handled",
  add_note: "Add to notes",
  save_address: "Save as their address",
};

interface CardProps {
  response: FlowResponseCard;
  /** When the customer sent it. */
  at: string;
  canReply: boolean;
  canNote: boolean;
  /** Refresh the timeline after an action. */
  onChanged: () => void;
}

/**
 * A customer's answers to a WhatsApp form (suite spec 07, 7.3), in place of the
 * plain bubble. Every value is rendered as text. Nothing here writes to the
 * customer; "Save as their address" changes the contact only after a confirm.
 */
export function FlowResponseCardView({ response, at, canReply, canNote, onChanged }: CardProps): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAddress, setConfirmAddress] = useState(false);
  const actions = flowCardActions(response, canReply, canNote);
  const rows = Array.isArray(response.rows) ? response.rows : [];
  const warning = typeof response.warning === "string" && response.warning.trim() ? response.warning : null;
  const after = flowAddressPreview(rows);

  async function run(action: FlowResponseAction): Promise<void> {
    if (busy) return;
    setBusy(action);
    try {
      const res = await inboxApi.flowResponseAction(response.id, action);
      if (action === "save_address") {
        setConfirmAddress(false);
        const before = typeof res.before === "string" ? res.before.trim() : "";
        toast.success("Address saved to the contact.");
        if (before && before !== (res.after ?? "").trim()) toast.info(`Replaced: ${before}`);
      } else if (action === "add_note") {
        toast.success("Added to the notes.");
      }
      onChanged();
    } catch {
      /* api() already showed the server's message */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ibx-flow">
      <div className="ibx-flow__head">
        <strong className="ibx-flow__title">📋 {response.title || "Form"}</strong>
        {response.status === "new" ? (
          <span className="pill pill--warning">New</span>
        ) : response.status === "handled" ? (
          <span className="pill">{flowHandledText(response)}</span>
        ) : null}
      </div>
      {rows.length > 0 && (
        <dl className="ibx-flow__rows">
          {rows.map((r, i) => (
            <div key={i} className="ibx-flow__row">
              <dt>{r.label}</dt>
              <dd className={r.kind === "longtext" ? "ibx-flow__long" : undefined}>{formatFlowValue(r.kind, r.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {warning && <div className="ibx-flow__warning">{warning}</div>}
      {actions.length > 0 && (
        <div className="ibx-flow__actions">
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              className="btn btn--subtle btn--sm"
              disabled={busy !== null}
              onClick={() => (a === "save_address" ? setConfirmAddress(true) : void run(a as FlowResponseAction))}
            >
              {ACTION_LABEL[a] ?? a}
            </button>
          ))}
        </div>
      )}
      <div className="ibx-msg__meta">
        <span>{timeOfDay(at)}</span>
      </div>
      {confirmAddress && (
        <ConfirmModal
          title="Save this address to the contact?"
          confirmLabel="Save address"
          busyLabel="Saving…"
          busy={busy === "save_address"}
          confirmDisabled={!after}
          onCancel={() => setConfirmAddress(false)}
          onConfirm={() => void run("save_address")}
        >
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-soft)" }}>
            This replaces the address saved on the contact, if there is one.
          </p>
          <dl className="ibx-flow__rows" style={{ marginTop: 10 }}>
            <div className="ibx-flow__row">
              <dt>After</dt>
              <dd>{after || "(none)"}</dd>
            </div>
          </dl>
        </ConfirmModal>
      )}
    </div>
  );
}

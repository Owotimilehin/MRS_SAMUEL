import { useState } from "react";
import { FLOW_MESSAGE_LIMITS } from "@ms/shared";
import { Modal } from "../Modal.js";
import { inboxApi } from "../../lib/inbox-api.js";
import { ApiError, humanizeError } from "../../lib/api.js";
import type { InboxFlow } from "../../lib/inbox-types.js";

/** Shown on the disabled "Send a form" button once the 24-hour window has closed. */
export const FLOW_WINDOW_HINT = "Forms can only be sent within 24 hours of the customer's last message. Send a template first.";

interface Props {
  conversationId: string;
  flows: InboxFlow[];
  /** May send a form that is not live yet as a test (templates.manage). */
  canTest: boolean;
  onClose: () => void;
  /** The form went out (or landed in the chat as a failed send): close and refresh the timeline. */
  onSent: () => void;
}

/**
 * "Send a form" (suite spec 07, 7.3): pick a WhatsApp form, edit the message
 * above its button, then send. Nothing is sent until "Send form" is clicked.
 */
export function FlowPicker({ conversationId, flows, canTest, onClose, onSent }: Props): JSX.Element {
  const [pick, setPick] = useState<InboxFlow | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const max = FLOW_MESSAGE_LIMITS.body;
  const asTest = (f: InboxFlow): boolean => !f.live && f.testable && canTest;
  const test = pick ? asTest(pick) : false;
  const body = message.trim();

  function choose(f: InboxFlow): void {
    if (!f.live && !asTest(f)) return;
    setPick(f);
    setMessage(f.default_message.slice(0, max));
    setError(null);
  }

  async function send(): Promise<void> {
    if (!pick || busy || !body) return;
    setBusy(true);
    setError(null);
    try {
      await inboxApi.sendFlow(conversationId, { flow_key: pick.key, message: body, ...(test ? { test: true } : {}) });
      onSent();
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        // Like any message: the failed send is in the chat (red or amber); the toast said so.
        onSent();
        return;
      }
      setError(humanizeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Send a form" onClose={onClose} maxWidth={560}>
      {!pick ? (
        <div style={{ display: "grid", gap: 6 }}>
          {flows.map((f) => {
            const usable = f.live || asTest(f);
            return (
              <button
                key={f.key}
                type="button"
                className={`card${usable ? " card--hoverable" : ""}`}
                style={{ textAlign: "left", padding: 10, cursor: usable ? "pointer" : "not-allowed", opacity: usable ? 1 : 0.6 }}
                disabled={!usable}
                onClick={() => choose(f)}
              >
                <div style={{ fontWeight: 700 }}>
                  {f.title}{" "}
                  {!f.live && (
                    <span className={`pill${asTest(f) ? " pill--warning" : ""}`} style={{ fontSize: 10 }}>
                      {asTest(f) ? "Send as a test" : "Not live yet"}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{f.description}</div>
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ justifySelf: "start" }}
            disabled={busy}
            onClick={() => {
              setPick(null);
              setError(null);
            }}
          >
            ← Pick another
          </button>

          <label className="field">
            <span className="field__label">Message above the button</span>
            <textarea className="textarea" rows={3} value={message} maxLength={max} onChange={(e) => setMessage(e.target.value)} />
            <span className="field__hint" style={{ textAlign: "right" }} aria-live="polite">
              {message.length}/{max}
            </span>
          </label>

          <div className="card card--soft" style={{ fontSize: 14 }}>
            <div className="t-eyebrow" style={{ marginBottom: 4 }}>Preview</div>
            <div className="ibx-msg ibx-msg--out ibx-flow-preview">
              <div>{message}</div>
              <div className="ibx-flow-cta">📋 {pick.cta}</div>
            </div>
            <div className="ibx-msg__caption">Form: {pick.title}</div>
          </div>

          {test && (
            <span className="field__hint">This form is not live yet. It goes to this customer as a test of the draft.</span>
          )}
          {!body && <span className="field__hint">Write the message that goes above the button.</span>}
          {error && (
            <div className="ibx-composer__problem" role="alert">
              {error}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" disabled={busy || !body} onClick={() => void send()}>
              {busy ? "Sending…" : test ? "Send test" : "Send form"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

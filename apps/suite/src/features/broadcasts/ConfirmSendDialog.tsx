/**
 * The one click that sends to customers (suite spec 14, 7.9; foundation rule 7). The person
 * must type the number of people. Used for confirming a draft and for resuming.
 */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import { groupThousands } from "@ms/shared";
import { BroadcastFailure, failureText } from "./broadcasts-api.js";
import { confirmCountOk } from "./broadcasts-logic.js";

export interface ConfirmSendProps {
  mode: "confirm" | "resume";
  count: number;
  templateName: string;
  listName: string;
  lineLabel: string;
  whenText: string;
  scheduled: boolean;
  exampleText: string;
  skipped: number;
  sendFrom: string;
  sendUntil: string;
  rate: number;
  /** Sends; throws a BroadcastFailure the dialog shows in place. */
  onConfirm: (count: number) => Promise<void>;
  onClose: () => void;
}

export function ConfirmSendDialog(p: ConfirmSendProps): JSX.Element {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = p.count;
  const people = `${groupThousands(n)} ${n === 1 ? "person" : "people"}`;
  const title = p.mode === "resume" ? `Send to the remaining ${people}?` : `Send to ${people}?`;
  const ok = confirmCountOk(typed, n);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await p.onConfirm(n);
    } catch (err) {
      // "The number of people changed from <old> to <new> while you were looking." comes from the server as is.
      setError(err instanceof BroadcastFailure ? err.message : failureText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={busy ? () => {} : p.onClose} maxWidth={560}>
      <div className="bc-dialog">
        <p>
          “{p.templateName}” will go to {people} on the list “{p.listName}”, from {p.lineLabel}, {p.whenText}.
        </p>
        {p.mode === "confirm" && (
          <>
            <span className="bc-faint">For example, the first person gets:</span>
            <div className="bc-quote">{p.exampleText}</div>
            <p className="bc-soft">
              {groupThousands(p.skipped)} {p.skipped === 1 ? "person" : "people"} on the list will not get it.
            </p>
          </>
        )}
        <p className="bc-soft">
          Sending happens between {p.sendFrom} and {p.sendUntil}, about {p.rate} a minute, and stops by itself if WhatsApp reports a problem.
        </p>
        <p className="bc-soft">
          <strong>You can't unsend a WhatsApp message.</strong>
        </p>
        <label className="bc-field">
          <span>Type the number of people to confirm</span>
          <input className="input bc-num" inputMode="numeric" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} aria-describedby="bc-confirm-help" />
          <small id="bc-confirm-help">Type {n} to confirm.</small>
        </label>
        {error && <p className="bc-notice bc-notice--red">{error}</p>}
        <div className="bc-row">
          <span className="bc-spacer" />
          <button type="button" className="btn" onClick={p.onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void go()} disabled={!ok || busy}>
            {busy ? "Sending…" : p.scheduled ? `Schedule for ${people}` : `Send to ${people}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

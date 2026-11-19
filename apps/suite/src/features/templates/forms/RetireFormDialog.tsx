/**
 * Retire a form (suite spec 07, 7.2 and rule 11): the form's name must be typed to confirm. Retiring the
 * only live version needs a second, explicit yes: the dialog says so up front when the list already knows,
 * and when the server asks ("only_live") it shows the server's question and the next press confirms it.
 */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import { TemplateFailure } from "../templates-api.js";
import { flowsApi, type FlowDto } from "./flows-api.js";

const ONLY_LIVE = "This is the only live version. Customers will no longer be able to open forms already sent.";

export function RetireFormDialog({
  form,
  onClose,
  onDone,
}: {
  form: FlowDto & { id: string };
  onClose: () => void;
  onDone: (form: FlowDto) => void;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sent as ?force=1. True from the start when the list says this is the only live version.
  const [force, setForce] = useState(form.only_live_version);
  // The server's own question, when it asked for the extra yes.
  const [question, setQuestion] = useState<string | null>(null);
  const matches = typed.trim() === form.title;

  async function go(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onDone(await flowsApi.retire(form.id, form.title, force));
    } catch (err) {
      if (err instanceof TemplateFailure && err.reason === "only_live" && !force) {
        setQuestion(err.message);
        setForce(true);
      } else {
        setError(err instanceof TemplateFailure ? err.message : "Something went wrong. Please check the list before trying again.");
      }
      setBusy(false);
    }
  }

  return (
    <Modal title="Retire this form?" onClose={busy ? () => undefined : onClose} maxWidth={500}>
      <p style={{ margin: "0 0 10px" }}>
        Customers will no longer be able to open “{form.title}”, including ones already sent. This cannot be undone. You can create a new copy later.
      </p>
      {(question || form.only_live_version) && (
        <p className="tpl-banner tpl-banner--amber" role="alert" style={{ margin: "0 0 10px" }}>
          {question ?? ONLY_LIVE}
        </p>
      )}
      <div className="field">
        <label className="field__label" htmlFor="tpl-form-retire-name">Type the form&apos;s name to confirm</label>
        <span className="field__hint">{form.title}</span>
        <input id="tpl-form-retire-name" className="input" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
      </div>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <div className="tpl-dialog-buttons">
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Keep it
        </button>
        <button type="button" className="btn btn--danger" disabled={busy || !matches} onClick={() => void go()}>
          {busy ? "Retiring…" : "Retire form"}
        </button>
      </div>
    </Modal>
  );
}

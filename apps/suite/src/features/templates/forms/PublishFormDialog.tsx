/**
 * Publish a form (suite spec 07, 7.2): the form's name must be typed to confirm. Nothing is published until
 * "Publish form" is pressed; the browser sends once, and a refusal stays in the dialog in the server's words.
 */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import { TemplateFailure } from "../templates-api.js";
import { flowsApi, type FlowDto } from "./flows-api.js";

export function PublishFormDialog({
  form,
  onClose,
  onDone,
}: {
  form: FlowDto & { id: string };
  onClose: () => void;
  onDone: (answer: { data: FlowDto; notice?: string }) => void;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === form.title;

  async function go(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onDone(await flowsApi.publish(form.id, form.title));
    } catch (err) {
      setError(err instanceof TemplateFailure ? err.message : "Something went wrong. Please check the list before trying again.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Publish this form?" onClose={busy ? () => undefined : onClose} maxWidth={500}>
      <p style={{ margin: "0 0 10px" }}>
        Once it is live, staff can send “{form.title}” to customers. WhatsApp checks that the business is verified and in good standing.
      </p>
      <div className="field">
        <label className="field__label" htmlFor="tpl-form-publish-name">Type the form&apos;s name to confirm</label>
        <span className="field__hint">{form.title}</span>
        <input id="tpl-form-publish-name" className="input" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
      </div>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <div className="tpl-dialog-buttons">
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Go back
        </button>
        <button type="button" className="btn btn--primary" disabled={busy || !matches} onClick={() => void go()}>
          {busy ? "Publishing…" : "Publish form"}
        </button>
      </div>
    </Modal>
  );
}

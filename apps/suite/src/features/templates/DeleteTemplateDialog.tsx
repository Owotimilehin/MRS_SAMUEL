/** Delete a template (suite spec 06, 7.6): the name must be typed to confirm. */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import { TemplateFailure, templatesApi, type TemplateRow } from "./templates-api.js";

export function DeleteTemplateDialog({
  row,
  onClose,
  onDone,
}: {
  row: TemplateRow;
  onClose: () => void;
  onDone: (row: TemplateRow) => void;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDraft = row.status === "DRAFT";

  async function go(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onDone(await templatesApi.remove(row.id, typed));
    } catch (err) {
      setError(err instanceof TemplateFailure ? err.message : "Something went wrong. Please check the list before trying again.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Delete this template?" onClose={busy ? () => undefined : onClose} maxWidth={500}>
      <p style={{ margin: "0 0 10px" }}>
        {isDraft
          ? "This draft exists only in the suite. Deleting it cannot be undone."
          : `This removes “${row.name}” (${row.language}) from WhatsApp. Messages already on their way are still delivered. You cannot reuse this name for 30 days.`}
      </p>
      {row.system_use === "missed_call" && (
        <p className="field__error" role="alert">
          The suite uses this template to message customers whose calls were missed. Those messages will stop until a new one with the same name is approved.
        </p>
      )}
      <div className="field">
        <label className="field__label" htmlFor="tpl-confirm-name">Type the name to confirm</label>
        <span className="field__hint">{row.name}</span>
        <input id="tpl-confirm-name" className="input" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
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
        <button type="button" className="btn btn--danger" disabled={busy || typed !== row.name} onClick={() => void go()}>
          {busy ? "Deleting…" : "Delete template"}
        </button>
      </div>
    </Modal>
  );
}

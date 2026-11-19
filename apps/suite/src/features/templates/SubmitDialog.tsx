/**
 * Send to WhatsApp for approval (suite spec 06, 7.5). Opens only when the draft has no errors. It shows
 * exactly what will be sent; nothing leaves until "Send to WhatsApp" is pressed (foundation rule 7). The
 * browser sends once and never retries: a failure keeps the dialog open with the server's words.
 */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import { languageName } from "@admin/lib/inbox-logic.js";
import { templateCategoryLabel, type DraftProblem, type TemplateDraft } from "@ms/shared";
import { TemplatePreview } from "./TemplatePreview.js";
import { TemplateFailure, templatesApi, type SubmitAnswer, type TemplateRow } from "./templates-api.js";

export function SubmitDialog({
  row,
  draft,
  stamp,
  warnings,
  sampleUrl,
  sampleName,
  onClose,
  onDone,
}: {
  row: TemplateRow;
  draft: TemplateDraft;
  /** The draft's `draft_updated_at`: the server refuses if someone changed it since. */
  stamp: string;
  warnings: DraftProblem[];
  sampleUrl: string | null;
  sampleName: string | null;
  onClose: () => void;
  onDone: (a: SubmitAnswer) => void;
}): JSX.Element {
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = row.status !== "DRAFT";

  async function send(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onDone(await templatesApi.submit(row.id, stamp, warnings.length > 0 && ticked));
    } catch (err) {
      setError(err instanceof TemplateFailure ? err.message : "Something went wrong. Please check the list before trying again.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Send this template to WhatsApp?" onClose={busy ? () => undefined : onClose} maxWidth={620}>
      <TemplatePreview draft={draft} sampleUrl={sampleUrl} sampleName={sampleName} />
      <table className="table tpl-facts">
        <tbody>
          <tr>
            <th scope="row">Name</th>
            <td>{row.name}</td>
          </tr>
          <tr>
            <th scope="row">Language</th>
            <td>{languageName(row.language)}</td>
          </tr>
          <tr>
            <th scope="row">Type</th>
            <td>{templateCategoryLabel(draft.category)}</td>
          </tr>
        </tbody>
      </table>
      <p>WhatsApp will check it. Most are decided in minutes; it can take up to a day. You cannot change it while it is being checked.</p>
      {editing && row.status === "APPROVED" && row.edits_left && (
        <p>
          This uses your one change for today ({row.edits_left.month} left this month). The template stays usable while WhatsApp checks the new wording.
        </p>
      )}
      {warnings.length > 0 && (
        <div className="tpl-warn-box">
          <ul className="tpl-problems">
            {warnings.map((w, i) => (
              <li key={`${w.code}-${i}`} className="tpl-problem tpl-problem--warning">
                <span className="tpl-dot" aria-hidden="true" />
                <span>{w.message}</span>
              </li>
            ))}
          </ul>
          <label className="tpl-tick">
            <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
            <span>I have read these and want to send it anyway</span>
          </label>
        </div>
      )}
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <div className="tpl-dialog-buttons">
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Go back
        </button>
        <button type="button" className="btn btn--primary" disabled={busy || (warnings.length > 0 && !ticked)} onClick={() => void send()}>
          {busy ? "Sending…" : "Send to WhatsApp"}
        </button>
      </div>
    </Modal>
  );
}

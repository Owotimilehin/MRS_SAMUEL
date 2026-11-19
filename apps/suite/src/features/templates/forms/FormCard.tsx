/**
 * One built-in form on one WhatsApp account (suite spec 07, 7.2): its name, what it asks for, where it
 * stands at WhatsApp, and the buttons that state allows. The card only reports clicks; FormsTab does the work.
 */
import { Eye } from "lucide-react";
import { TONE_PILL } from "../template-labels.js";
import type { FlowDto } from "./flows-api.js";
import { FORM_ACTION_LABEL, asksFor, formActions, formStateWording, validationMessages, type FormAction } from "./form-labels.js";

const BUTTON_CLASS: Record<FormAction, string> = {
  create: "btn btn--primary btn--sm",
  publish: "btn btn--primary btn--sm",
  preview: "btn btn--subtle btn--sm",
  upload: "btn btn--subtle btn--sm",
  upload_new: "btn btn--subtle btn--sm",
  new_copy: "btn btn--subtle btn--sm",
  retire: "btn btn--ghost btn--sm",
  delete_draft: "btn btn--ghost btn--sm",
};

export function FormCard({
  form,
  accountLabel,
  version,
  busy,
  locked,
  onAction,
}: {
  form: FlowDto;
  /** Set only when the list covers more than one WhatsApp account. */
  accountLabel: string | null;
  /** "Version 2", or null when there is nothing to tell apart. */
  version: string | null;
  /** The action running on this card now, if any. */
  busy: FormAction | null;
  /** WhatsApp refused to change this live form: its words, shown with "Create a new copy". */
  locked: string | null;
  onAction: (action: FormAction) => void;
}): JSX.Element {
  const wording = formStateWording(form.state, form.validation_errors.length);
  const asks = asksFor(form.key);
  const actions = formActions(form);
  const problems = form.state === "draft_invalid" ? validationMessages(form.validation_errors) : [];

  return (
    <li className="card tpl-formcard">
      <div className="tpl-card__top">
        <div>
          <div className="tpl-card__name">{form.title}</div>
          {(version || accountLabel) && <div className="tpl-card__raw">{[version, accountLabel].filter(Boolean).join(" · ")}</div>}
        </div>
        <div className="tpl-card__pills">
          <span className={TONE_PILL[wording.tone]}>{wording.label}</span>
        </div>
      </div>
      <div className="tpl-formcard__desc">{form.description}</div>
      {asks && <div className="tpl-card__line">{asks}</div>}
      {wording.line && <div className="tpl-card__line">{wording.line}</div>}
      {problems.length > 0 && (
        <ul className="tpl-formcard__errors">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {form.last_error && (
        <div className="tpl-note tpl-note--red" role="alert">
          {form.last_error}
        </div>
      )}
      {locked && (
        <div className="tpl-formcard__locked" role="alert">
          <span className="tpl-note tpl-note--red">{locked}</span>
          <button type="button" className="btn btn--subtle btn--sm" disabled={busy !== null} onClick={() => onAction("new_copy")}>
            {busy === "new_copy" ? "Working…" : FORM_ACTION_LABEL.new_copy}
          </button>
        </div>
      )}
      {actions.length > 0 && (
        <div className="tpl-formcard__actions">
          {actions.map((a) => (
            <button key={a} type="button" className={BUTTON_CLASS[a]} disabled={busy !== null} onClick={() => onAction(a)}>
              {a === "preview" && <Eye size={13} aria-hidden="true" />}
              {busy === a ? "Working…" : FORM_ACTION_LABEL[a]}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

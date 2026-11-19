/** New template (suite spec 06, 7.3): pick the account, a name, a language and a type, then open the editor. */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import { EMPTY_DRAFT, validateTemplateName, type DraftCategory } from "@ms/shared";
import { TemplateFailure, templatesApi, type TemplateOptions, type TemplateRow } from "./templates-api.js";
import { tidyTemplateName } from "./templates-logic.js";

const TYPES: { id: DraftCategory; title: string; text: string }[] = [
  {
    id: "UTILITY",
    title: "Order and account updates",
    text: "For a specific customer about something they did: an order, a payment, a delivery, a missed call. No selling.",
  },
  {
    id: "MARKETING",
    title: "Marketing",
    text: "News, offers, new flavours, reminders to buy. Customers can switch these off, and WhatsApp limits how many each person gets.",
  },
];

export function NewTemplateDialog({
  options,
  onClose,
  onCreated,
}: {
  options: TemplateOptions;
  onClose: () => void;
  onCreated: (row: TemplateRow) => void;
}): JSX.Element {
  const [waba, setWaba] = useState(options.accounts[0]?.waba_id ?? "");
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("en");
  const [category, setCategory] = useState<DraftCategory>("UTILITY");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameProblem = name === "" ? null : validateTemplateName(name);
  const ready = waba !== "" && name !== "" && !nameProblem;

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onCreated(await templatesApi.create({ waba_id: waba, name, language, draft: { ...EMPTY_DRAFT, category } }));
    } catch (err) {
      setError(err instanceof TemplateFailure ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <Modal title="New template" onClose={busy ? () => undefined : onClose} maxWidth={560}>
      {options.accounts.length === 0 && (
        <p className="field__error" role="alert">
          No WhatsApp account is set up yet. Add a WhatsApp number under Settings first.
        </p>
      )}
      {options.accounts.length > 1 && (
        <div className="field">
          <label className="field__label" htmlFor="tpl-account">WhatsApp account</label>
          <select id="tpl-account" className="select" value={waba} onChange={(e) => setWaba(e.target.value)}>
            {options.accounts.map((a) => (
              <option key={a.waba_id} value={a.waba_id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label className="field__label" htmlFor="tpl-name">Name</label>
        <span className="field__hint">Lowercase letters, numbers and underscores. Customers never see this. Example: order_confirmed</span>
        <input
          id="tpl-name"
          className="input"
          value={name}
          maxLength={options.limits.nameUi}
          autoComplete="off"
          onChange={(e) => setName(tidyTemplateName(e.target.value))}
        />
        {nameProblem && (
          <div className="field__error" role="alert">
            {nameProblem}
          </div>
        )}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="tpl-language">Language</label>
        <select id="tpl-language" className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
          {options.languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="tpl-types">
        <legend className="field__label">Type</legend>
        {TYPES.map((t) => (
          <label key={t.id} className={`tpl-type${category === t.id ? " is-picked" : ""}`}>
            <input type="radio" name="tpl-type" checked={category === t.id} onChange={() => setCategory(t.id)} />
            <span>
              <strong>{t.title}</strong>
              <span className="tpl-type__text">{t.text}</span>
            </span>
          </label>
        ))}
        <p className="field__hint">Login codes are a third type. The suite does not create those.</p>
      </fieldset>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <div className="tpl-dialog-buttons">
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={!ready || busy} onClick={() => void create()}>
          {busy ? "Creating…" : "Create draft"}
        </button>
      </div>
    </Modal>
  );
}

/** Add the starter set (suite spec 06, 7.7): seven drafts written for the shop. Nothing is sent to WhatsApp. */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import { toast } from "@admin/lib/toast.js";
import { STARTER_TEMPLATES, templateCategoryLabel } from "@ms/shared";
import { TemplateFailure, templatesApi, type TemplateOptions } from "./templates-api.js";

export function StarterSetDialog({
  options,
  onClose,
  onAdded,
}: {
  options: TemplateOptions;
  onClose: () => void;
  onAdded: () => void;
}): JSX.Element {
  const [waba, setWaba] = useState(options.accounts[0]?.waba_id ?? "");
  const existsHere = (key: string): boolean => options.starter.find((s) => s.key === key)?.exists_in.includes(waba) ?? false;
  const [picked, setPicked] = useState<Set<string>>(() => new Set(STARTER_TEMPLATES.map((s) => s.key)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = STARTER_TEMPLATES.filter((s) => picked.has(s.key) && !existsHere(s.key));

  async function add(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await templatesApi.addStarter(waba, chosen.map((s) => s.key));
      toast.success(`${r.created.length} draft${r.created.length === 1 ? "" : "s"} added.`);
      onAdded();
    } catch (err) {
      setError(err instanceof TemplateFailure ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Add the starter set" onClose={busy ? () => undefined : onClose} maxWidth={640}>
      <p style={{ margin: "0 0 10px" }}>
        These are drafts written for Mrs. Samuel Fruit Juice. Read each one, change the wording if you like, then send it to WhatsApp.
      </p>
      {options.accounts.length > 1 && (
        <div className="field">
          <label className="field__label" htmlFor="tpl-starter-account">WhatsApp account</label>
          <select id="tpl-starter-account" className="select" value={waba} onChange={(e) => setWaba(e.target.value)}>
            {options.accounts.map((a) => (
              <option key={a.waba_id} value={a.waba_id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <ul className="tpl-starter-list">
        {STARTER_TEMPLATES.map((s) => {
          const there = existsHere(s.key);
          return (
            <li key={s.key} className={there ? "is-there" : ""}>
              <label>
                <input
                  type="checkbox"
                  disabled={there}
                  checked={!there && picked.has(s.key)}
                  onChange={(e) =>
                    setPicked((cur) => {
                      const next = new Set(cur);
                      if (e.target.checked) next.add(s.key);
                      else next.delete(s.key);
                      return next;
                    })
                  }
                />
                <span>
                  <strong>{s.title}</strong> <span className="pill">{templateCategoryLabel(s.category)}</span>
                  {there && <span className="pill pill--accent">Already added</span>}
                  <span className="tpl-starter-body">{s.draft.body.text}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <div className="tpl-dialog-buttons">
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={busy || chosen.length === 0 || waba === ""} onClick={() => void add()}>
          {busy ? "Adding…" : "Add as drafts"}
        </button>
      </div>
    </Modal>
  );
}

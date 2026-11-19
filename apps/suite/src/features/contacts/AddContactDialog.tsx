/** Add a contact by hand (suite spec 14, 7.4). A person who already exists is opened, and nothing on them changes. */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import type { CustomerSourceValue } from "@ms/shared";
import { contactsApi, failureText } from "./contacts-api.js";
import { FIRST_REACHED, addContactProblem, lagosToday } from "./contacts-logic.js";

export function AddContactDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  /** `created` false: the person already existed and nothing was changed. */
  onDone: (r: { id: string; created: boolean; name: string | null; stopped: boolean; consentRecorded: boolean }) => void;
}): JSX.Element {
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    address: "",
    notes: "",
    source: "walkup_anonymous" as CustomerSourceValue,
    sourceLabel: "",
    consentYes: false,
    consentWording: "",
    consentDate: lagosToday(new Date()),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  async function save(): Promise<void> {
    const problem = addContactProblem(form);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await contactsApi.create({
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
        ...(form.address.trim() ? { address: form.address.trim() } : {}),
        ...(form.notes.trim() ? { notes: form.notes } : {}),
        customer_source: form.source,
        source_label: form.sourceLabel.trim(),
        ...(form.consentYes ? { consent: { wording: form.consentWording.trim(), collected_on: form.consentDate } } : {}),
      });
      onDone({ id: r.id, created: r.created, name: r.name, stopped: r.stopped, consentRecorded: r.consent_recorded });
    } catch (err) {
      setError(failureText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add contact" onClose={busy ? () => undefined : onClose} maxWidth={560}>
      <div className="ct-form">
        <div className="field">
          <label className="field__label" htmlFor="ct-add-name">Name</label>
          <input id="ct-add-name" className="input" maxLength={120} value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="ct-form__two">
          <div className="field">
            <label className="field__label" htmlFor="ct-add-phone">Phone</label>
            <input id="ct-add-phone" className="input" inputMode="tel" placeholder="0803 123 4567" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="ct-add-email">Email</label>
            <input id="ct-add-email" className="input" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="ct-add-address">Address</label>
          <input id="ct-add-address" className="input" maxLength={500} value={form.address} onChange={(e) => set({ address: e.target.value })} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="ct-add-notes">Notes</label>
          <textarea id="ct-add-notes" className="textarea" maxLength={4000} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </div>
        <div className="ct-form__two">
          <div className="field">
            <label className="field__label" htmlFor="ct-add-source">How did they first reach us?</label>
            <select id="ct-add-source" className="select" value={form.source} onChange={(e) => set({ source: e.target.value as CustomerSourceValue })}>
              {FIRST_REACHED.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="ct-add-where">Where did you get these details?</label>
            <input
              id="ct-add-where"
              className="input"
              maxLength={80}
              placeholder="For example: order book, event sign-up sheet"
              value={form.sourceLabel}
              onChange={(e) => set({ sourceLabel: e.target.value })}
            />
          </div>
        </div>
        <label className="ct-check">
          <input type="checkbox" checked={form.consentYes} onChange={(e) => set({ consentYes: e.target.checked })} /> They agreed to promotions on WhatsApp
        </label>
        {form.consentYes && (
          <>
            <div className="field">
              <label className="field__label" htmlFor="ct-add-wording">What did they agree to?</label>
              <textarea
                id="ct-add-wording"
                className="textarea"
                maxLength={1000}
                placeholder="For example: “Yes, send me offers on WhatsApp” — said at the counter"
                value={form.consentWording}
                onChange={(e) => set({ consentWording: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="ct-add-when">When?</label>
              <input id="ct-add-when" className="input" type="date" value={form.consentDate} onChange={(e) => set({ consentDate: e.target.value })} />
              <span className="field__hint">Only record a yes the customer really gave. You are named on this record.</span>
            </div>
          </>
        )}
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="ct-dialog-buttons">
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Adding…" : "Add contact"}
        </button>
      </div>
    </Modal>
  );
}

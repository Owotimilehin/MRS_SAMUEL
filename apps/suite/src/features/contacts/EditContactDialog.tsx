/** Correct a contact's name, email, address and notes (suite spec 14, 7.3). The phone number is shown but locked. */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import type { ContactDetail } from "@ms/shared";
import { contactsApi, failureText } from "./contacts-api.js";
import { editContactPatch, editContactProblem } from "./contacts-logic.js";

export function EditContactDialog({ contact, onClose, onSaved }: { contact: ContactDetail; onClose: () => void; onSaved: (c: ContactDetail) => void }): JSX.Element {
  const [form, setForm] = useState({
    name: contact.name ?? "",
    email: contact.email ?? "",
    address: contact.saved_address ?? "",
    notes: contact.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  async function save(): Promise<void> {
    const problem = editContactProblem(form);
    if (problem) {
      setError(problem);
      return;
    }
    const patch = editContactPatch(contact, form);
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await contactsApi.update(contact.id, patch));
    } catch (err) {
      setError(failureText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Edit contact" onClose={busy ? () => undefined : onClose} maxWidth={540}>
      <div className="ct-form">
        <p className="ct-note ct-note--amber">This changes the customer&apos;s record in the shop too.</p>
        <div className="field">
          <label className="field__label" htmlFor="ct-edit-name">Name</label>
          <input id="ct-edit-name" className="input" maxLength={120} value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="ct-edit-phone">Phone</label>
          <input id="ct-edit-phone" className="input" value={contact.phone ?? ""} disabled readOnly />
          <span className="field__hint">The phone number can&apos;t be changed here, because messages and orders are matched by it.</span>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="ct-edit-email">Email</label>
          <input id="ct-edit-email" className="input" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="ct-edit-address">Address</label>
          <textarea id="ct-edit-address" className="textarea" maxLength={500} value={form.address} onChange={(e) => set({ address: e.target.value })} />
          {!contact.saved_address && contact.last_delivery_address && (
            <span className="field__hint">Leave this empty to keep showing their last delivery address: {contact.last_delivery_address}</span>
          )}
        </div>
        <div className="field">
          <label className="field__label" htmlFor="ct-edit-notes">Notes</label>
          <textarea id="ct-edit-notes" className="textarea" maxLength={4000} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </div>
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
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

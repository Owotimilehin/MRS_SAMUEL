/** The automatic replies to STOP and START (suite spec 14, 7.7). */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal } from "@admin/components/Modal.js";
import { DataState } from "@admin/components/DataState.js";
import { toast } from "@admin/lib/toast.js";
import { CONTACT_LIMITS, type ContactSettings } from "@ms/shared";
import { contactKeys, contactsApi, failureText } from "./contacts-api.js";

export function ContactSettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const settings = useQuery({ queryKey: contactKeys.settings, queryFn: contactsApi.settings, refetchOnWindowFocus: false });
  return (
    <Modal title="STOP and START replies" onClose={onClose} maxWidth={560}>
      <DataState loading={settings.isLoading} error={settings.error} onRetry={() => void settings.refetch()}>
        {settings.data && <SettingsForm initial={settings.data} onClose={onClose} />}
      </DataState>
    </Modal>
  );
}

function SettingsForm({ initial, onClose }: { initial: ContactSettings; onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const [form, setForm] = useState<ContactSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (!form.stop_text.trim() || !form.start_text.trim()) {
      setError("Write both replies.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await contactsApi.saveSettings({ ...form, stop_text: form.stop_text.trim(), start_text: form.start_text.trim() });
      qc.setQueryData(contactKeys.settings, saved);
      toast.success("Saved.");
      onClose();
    } catch (err) {
      setError(failureText(err));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="ct-form">
        <label className="ct-check">
          <input type="checkbox" checked={form.stop_confirmation} onChange={(e) => setForm({ ...form, stop_confirmation: e.target.checked })} />
          Reply automatically when someone writes STOP or START
        </label>
        <div className="field">
          <label className="field__label" htmlFor="ct-set-stop">Reply to STOP</label>
          <textarea
            id="ct-set-stop"
            className="textarea"
            maxLength={CONTACT_LIMITS.settingsText}
            value={form.stop_text}
            onChange={(e) => setForm({ ...form, stop_text: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="ct-set-start">Reply to START</label>
          <textarea
            id="ct-set-start"
            className="textarea"
            maxLength={CONTACT_LIMITS.settingsText}
            value={form.start_text}
            onChange={(e) => setForm({ ...form, start_text: e.target.value })}
          />
        </div>
        <p className="ct-soft">Customers who write STOP on WhatsApp are taken off promotions straight away, whether or not this reply is on.</p>
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
    </>
  );
}

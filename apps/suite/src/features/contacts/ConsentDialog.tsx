/**
 * Record what a customer agreed to, or that they asked us to stop (suite spec 14, 7.3).
 * Turning "asked us to stop" back into "agreed" needs a tick saying the customer asked for it.
 */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import type { ConsentChannel, ConsentNow, ConsentPurpose, ConsentState } from "@ms/shared";
import { contactsApi, failureText } from "./contacts-api.js";
import { CONSENT_CHANNEL_TEXT, lagosDate, lagosToday, needsAskedAgain } from "./contacts-logic.js";

export function ConsentDialog({
  customerId,
  current,
  onClose,
  onSaved,
}: {
  customerId: string;
  current: ConsentNow[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [purpose, setPurpose] = useState<ConsentPurpose>("marketing");
  const [channel, setChannel] = useState<ConsentChannel>("whatsapp");
  const [state, setState] = useState<ConsentState>("granted");
  const [wording, setWording] = useState("");
  const [when, setWhen] = useState(() => lagosToday(new Date()));
  const [note, setNote] = useState("");
  const [askedAgain, setAskedAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = current.find((r) => r.channel === channel && r.purpose === purpose) ?? null;
  const lifting = needsAskedAgain(now, state);

  async function save(): Promise<void> {
    if (state === "granted" && !wording.trim()) {
      setError("Say what the customer agreed to.");
      return;
    }
    if (lifting && !askedAgain) {
      setError("Tick the box to confirm they asked to get promotions again.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await contactsApi.recordConsent(customerId, {
        channel,
        purpose,
        state,
        ...(state === "granted" ? { wording: wording.trim(), collected_on: when } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(lifting ? { asked_again: true } : {}),
      });
      onSaved();
    } catch (err) {
      setError(failureText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Record consent" onClose={busy ? () => undefined : onClose} maxWidth={540}>
      <div className="ct-form">
        <div className="ct-form__two">
          <div className="field">
            <label className="field__label" htmlFor="ct-consent-purpose">What for</label>
            <select id="ct-consent-purpose" className="select" value={purpose} onChange={(e) => setPurpose(e.target.value as ConsentPurpose)}>
              <option value="marketing">Promotions</option>
              <option value="service">Order and service messages</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="ct-consent-channel">Where</label>
            <select id="ct-consent-channel" className="select" value={channel} onChange={(e) => setChannel(e.target.value as ConsentChannel)}>
              {(["whatsapp", "sms", "email", "phone"] as const).map((c) => (
                <option key={c} value={c}>
                  {CONSENT_CHANNEL_TEXT[c]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset className="ct-radios">
          <legend className="field__label">They</legend>
          <label className={`ct-radio${state === "granted" ? " is-picked" : ""}`}>
            <input type="radio" name="ct-consent-state" checked={state === "granted"} onChange={() => setState("granted")} /> Agreed
          </label>
          <label className={`ct-radio${state === "withdrawn" ? " is-picked" : ""}`}>
            <input type="radio" name="ct-consent-state" checked={state === "withdrawn"} onChange={() => setState("withdrawn")} /> Asked us to stop
          </label>
        </fieldset>
        {state === "granted" && (
          <>
            <div className="field">
              <label className="field__label" htmlFor="ct-consent-wording">What did they agree to?</label>
              <textarea
                id="ct-consent-wording"
                className="textarea"
                maxLength={1000}
                placeholder="For example: “Yes, send me offers on WhatsApp” — said at the counter"
                value={wording}
                onChange={(e) => setWording(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="ct-consent-when">When?</label>
              <input id="ct-consent-when" className="input" type="date" value={when} onChange={(e) => setWhen(e.target.value)} />
            </div>
          </>
        )}
        <div className="field">
          <label className="field__label" htmlFor="ct-consent-note">Note (optional)</label>
          <input id="ct-consent-note" className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <p className="ct-soft">Only record a yes the customer really gave. You are named on this record.</p>
        {lifting && now && (
          <div className="ct-note ct-note--amber">
            <p style={{ margin: "0 0 8px" }}>
              This customer asked us to stop on {lagosDate(now.recorded_at)}. Only change this if they have clearly asked to get promotions again.
            </p>
            <label className="ct-check">
              <input type="checkbox" checked={askedAgain} onChange={(e) => setAskedAgain(e.target.checked)} /> They asked to get promotions again
            </label>
          </div>
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
        <button type="button" className="btn btn--primary" disabled={busy || (lifting && !askedAgain)} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

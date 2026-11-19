/**
 * "Turn on" and "Change daily budget" (suite spec 12, 7.10). Both show what the
 * server worked out from Meta just now (the daily amount, the end date, the
 * most it can still spend, and the cap) and need that total typed to confirm.
 * The server checks the typed total again itself.
 */
import { useEffect, useState } from "react";
import { money } from "@ms/shared";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { InlineLoader } from "@admin/components/Spinner.js";
import { humanizeError } from "@admin/lib/api.js";
import { adsApi, type TurnOnPreview } from "./ads-api.js";
import { capLine, dateTime, parseTyped } from "./ads-logic.js";

export function TurnOnDialog({
  campaignId,
  name,
  currency,
  onClose,
  onDone,
}: {
  campaignId: string;
  name: string;
  currency: string;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [preview, setPreview] = useState<TurnOnPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    adsApi
      .turnOnPreview(campaignId)
      .then((p) => live && setPreview(p))
      .catch((e: unknown) => live && setError(humanizeError(e)));
    return () => {
      live = false;
    };
  }, [campaignId]);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await adsApi.turnOn(campaignId, typed);
      onDone();
    } catch (e) {
      setError(humanizeError(e));
      setBusy(false);
    }
  }

  const ready = !!preview && preview.cap.ok && parseTyped(typed) === preview.confirm_text;
  return (
    <ConfirmModal
      title={`Turn on "${name}"?`}
      confirmLabel="Turn on"
      busyLabel="Turning on…"
      onConfirm={() => void confirm()}
      onCancel={onClose}
      busy={busy}
      confirmDisabled={!ready}
      tone="danger"
      maxWidth={640}
    >
      {!preview && !error ? <InlineLoader /> : null}
      {preview ? (
        <div className="ads-card">
          <p style={{ margin: 0 }}>
            From now until {dateTime(preview.end_time)} it can spend up to {money(preview.daily, currency)} a day:{" "}
            <strong>{money(preview.remaining_max, currency)} in total</strong>. Meta will check the advert first, which usually takes under a day.
          </p>
          <p className="ads-fine">{capLine(preview.cap, currency)}</p>
          {!preview.cap.ok ? (
            <div className="ads-strip ads-strip--bad">
              This would take live daily budgets to {money(preview.cap.already_committed + preview.cap.requested, currency)}, over your cap of{" "}
              {money(preview.cap.cap, currency)}. Lower the amount, pause another advert, or ask the owner to raise the cap.
            </div>
          ) : (
            <label className="field">
              <span className="field__label">Type the total ({preview.confirm_text}) to confirm</span>
              <input className="input ads-confirm-input" inputMode="numeric" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </label>
          )}
        </div>
      ) : null}
      {error ? <div className="ads-strip ads-strip--bad" style={{ marginTop: 10 }}>{error}</div> : null}
    </ConfirmModal>
  );
}

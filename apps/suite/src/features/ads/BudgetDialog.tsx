/** Change an advert's daily budget (suite spec 12, 7.10): the new total is worked out by the server and must be typed. */
import { useState } from "react";
import { money } from "@ms/shared";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { humanizeError } from "@admin/lib/api.js";
import { adsApi, type BudgetPreview } from "./ads-api.js";
import { capLine, dateTime, parseTyped } from "./ads-logic.js";

export function BudgetDialog({
  adsetId,
  name,
  currency,
  currentDaily,
  onClose,
  onDone,
}: {
  adsetId: string;
  name: string;
  currency: string;
  currentDaily: number | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [amount, setAmount] = useState(currentDaily ? String(currentDaily) : "");
  const [preview, setPreview] = useState<BudgetPreview | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const daily = Number(amount);
  const validAmount = /^\d+$/.test(amount.trim()) && daily >= 1;

  async function check(): Promise<void> {
    setBusy(true);
    setError(null);
    setTyped("");
    try {
      setPreview(await adsApi.budgetPreview(adsetId, daily));
    } catch (e) {
      setPreview(null);
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await adsApi.changeBudget(adsetId, preview.new_daily, typed);
      onDone();
    } catch (e) {
      setError(humanizeError(e));
      setBusy(false);
    }
  }

  const ready = !!preview && preview.new_daily === daily && preview.cap.ok && parseTyped(typed) === preview.confirm_text;
  return (
    <ConfirmModal
      title={`Change the daily budget of "${name}"`}
      confirmLabel="Change budget"
      busyLabel="Working…"
      onConfirm={() => void confirm()}
      onCancel={onClose}
      busy={busy}
      confirmDisabled={!ready}
      tone="danger"
      maxWidth={640}
    >
      <div className="ads-card">
        <label className="field">
          <span className="field__label">New daily budget ({currency}), whole numbers only</span>
          <input
            className="input"
            inputMode="numeric"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <div>
          <button type="button" className="btn btn--subtle btn--sm" disabled={!validAmount || busy} onClick={() => void check()}>
            Work out the total
          </button>
        </div>
        {preview ? (
          <>
            <p style={{ margin: 0 }}>
              Now {money(preview.current_daily, currency)} a day. New: {money(preview.new_daily, currency)} a day until {dateTime(preview.end_time)}:{" "}
              <strong>{money(preview.remaining_max, currency)} at most from now</strong>.
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
          </>
        ) : null}
        {error ? <div className="ads-strip ads-strip--bad">{error}</div> : null}
      </div>
    </ConfirmModal>
  );
}

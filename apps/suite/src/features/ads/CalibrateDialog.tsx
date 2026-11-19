/**
 * "Check the budget unit" (suite spec 12, 5.9 and 7.7). Meta's system sends
 * budgets as plain numbers and does not say whether ₦2,000 is written 2000 or
 * 200000, so the owner checks one ad set against what Ads Manager shows.
 * Nothing can be created or turned on until this has been done.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "@admin/components/Modal.js";
import { InlineLoader } from "@admin/components/Spinner.js";
import { humanizeError } from "@admin/lib/api.js";
import { adsApi } from "./ads-api.js";

export function CalibrateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const q = useQuery({ queryKey: ["ads", "calibration"], queryFn: adsApi.calibration, retry: false, staleTime: 0 });
  const [adset, setAdset] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [factor, setFactor] = useState<number | null>(null);
  const adsets = q.data?.adsets ?? [];
  const chosen = adset || adsets[0]?.external_id || "";
  const value = Number(amount);

  async function check(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await adsApi.calibrate(chosen, value);
      setFactor(res.budget_factor);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Check the budget unit" onClose={factor ? onDone : onClose} maxWidth={560}>
      <div className="ads-card">
        {factor ? (
          <>
            <div className="ads-strip">Checked. Meta writes ₦1 as {factor}.</div>
            <div>
              <button type="button" className="btn btn--primary" onClick={onDone}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              Meta&apos;s system sends budgets as plain numbers, and we need to be certain how it writes them. Pick an ad set below, look it up in Meta Ads
              Manager, and type the daily budget shown there.
            </p>
            {q.isLoading ? <InlineLoader /> : null}
            {q.error ? <div className="ads-strip ads-strip--bad">{humanizeError(q.error)}</div> : null}
            {q.data && adsets.length === 0 ? (
              <div className="ads-strip ads-strip--warn">
                There is no ad set with a daily budget to check against. In Meta Ads Manager create one ad set, switched off, with a daily budget you will
                recognise, then come back.
              </div>
            ) : null}
            {adsets.length > 0 ? (
              <>
                <label className="field">
                  <span className="field__label">Ad set</span>
                  <select className="select" value={chosen} onChange={(e) => setAdset(e.target.value)}>
                    {adsets.map((a) => (
                      <option key={a.external_id} value={a.external_id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">Daily budget shown in Ads Manager ({q.data?.currency ?? ""})</span>
                  <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </label>
              </>
            ) : null}
            {error ? <div className="ads-strip ads-strip--bad">{error}</div> : null}
            <div className="ads-actions">
              <button type="button" className="btn btn--subtle" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary" disabled={busy || !chosen || !(value > 0)} onClick={() => void check()}>
                {busy ? "Checking…" : "Check"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

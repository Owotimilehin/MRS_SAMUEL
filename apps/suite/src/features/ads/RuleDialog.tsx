/** A rule: "pause if a chat costs more than X" (suite spec 12, 7.11). Rules can only pause. */
import { useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import { humanizeError } from "@admin/lib/api.js";
import { adsApi, type AdRule, type RuleInput } from "./ads-api.js";

export function RuleDialog({
  rule,
  currency,
  campaigns,
  onClose,
  onDone,
}: {
  rule: AdRule | null;
  currency: string;
  campaigns: { external_id: string; name: string | null }[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [name, setName] = useState(rule?.name ?? "");
  const [threshold, setThreshold] = useState(rule ? String(rule.threshold) : "");
  const [days, setDays] = useState<1 | 3 | 7>(rule?.lookback_days ?? 3);
  const [minSpend, setMinSpend] = useState(rule ? String(rule.min_spend) : "0");
  const [scope, setScope] = useState(rule?.scope_campaign_external_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim().length > 0 && Number(threshold) > 0 && Number(minSpend) >= 0 && minSpend.trim() !== "";

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    const body: RuleInput = {
      name: name.trim(),
      threshold: Number(threshold),
      lookback_days: days,
      min_spend: Number(minSpend),
      scope_campaign_external_id: scope || null,
      is_active: rule?.is_active ?? true,
    };
    try {
      if (rule) await adsApi.updateRule(rule.id, body);
      else await adsApi.createRule(body);
      onDone();
    } catch (e) {
      setError(humanizeError(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={rule ? "Edit rule" : "New rule"} onClose={onClose} maxWidth={560}>
      <div className="ads-form">
        <label className="field">
          <span className="field__label">Name</span>
          <input className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Pause when a chat costs more than ({currency})</span>
          <input className="input" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Looking at the last</span>
          <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value) as 1 | 3 | 7)}>
            <option value={1}>1 day</option>
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Only after this much has been spent ({currency})</span>
          <input className="input" inputMode="decimal" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Applies to</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">All adverts made in the suite</option>
            {campaigns.map((c) => (
              <option key={c.external_id} value={c.external_id}>
                {c.name ?? c.external_id}
              </option>
            ))}
          </select>
        </label>
        <p className="ads-fine">Rules can only pause. Nothing turns an advert on by itself.</p>
        {error ? <div className="ads-strip ads-strip--bad">{error}</div> : null}
        <div className="ads-actions">
          <button type="button" className="btn btn--subtle" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={busy || !valid} onClick={() => void save()}>
            {busy ? "Saving…" : "Save rule"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

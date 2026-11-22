/** Broadcast settings (suite spec 14, 7.9): the owner switch, sending hours, speed and who may be sent promotions. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal } from "@admin/components/Modal.js";
import { toast } from "@admin/lib/toast.js";
import { groupThousands, type BroadcastSettings, type BroadcastSettingsView } from "@ms/shared";
import { broadcastKeys, broadcastsApi, failureText } from "./broadcasts-api.js";
import { mmText, qualityText } from "./broadcasts-logic.js";

export function BroadcastSettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const q = useQuery({ queryKey: broadcastKeys.settings, queryFn: broadcastsApi.settings });
  return (
    <Modal title="Broadcast settings" onClose={onClose} maxWidth={620}>
      {q.data ? <SettingsForm view={q.data} onClose={onClose} /> : <p className="bc-soft">{q.error ? failureText(q.error) : "Loading…"}</p>}
    </Modal>
  );
}

function SettingsForm({ view, onClose }: { view: BroadcastSettingsView; onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const [s, setS] = useState<BroadcastSettings>({
    enabled: view.enabled,
    send_from: view.send_from,
    send_until: view.send_until,
    rate_per_minute: view.rate_per_minute,
    min_days_between: view.min_days_between,
    attribution_days: view.attribution_days,
    audience_rule: view.audience_rule,
    recent_customer_months: view.recent_customer_months,
    daily_share: view.daily_share,
    route: view.route,
  });
  const [legal, setLegal] = useState(view.audience_rule !== "consent_only");
  const [askEnable, setAskEnable] = useState(false);
  const [clearBlock, setClearBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof BroadcastSettings>(k: K, v: BroadcastSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

  const save = async (confirmEnable: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await broadcastsApi.saveSettings({
        ...s,
        ...(confirmEnable ? { confirm_enable: true } : {}),
        ...(s.audience_rule !== "consent_only" ? { confirm_legal: legal } : {}),
        ...(clearBlock ? { clear_account_block: true } : {}),
      });
      await qc.invalidateQueries({ queryKey: broadcastKeys.all });
      toast.success("Saved.");
      onClose();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => {
    if (s.enabled && !view.enabled) {
      setAskEnable(true);
      return;
    }
    void save(false);
  };

  if (askEnable) {
    return (
      <div className="bc-dialog">
        <p>
          <strong>Switch on broadcasts?</strong> Messages will be sent to customers when you, or anyone you have given this permission, confirm a broadcast.
        </p>
        {error && <p className="bc-notice bc-notice--red">{error}</p>}
        <div className="bc-row">
          <span className="bc-spacer" />
          <button type="button" className="btn" onClick={() => setAskEnable(false)} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save(true)} disabled={busy}>
            {busy ? "Saving…" : "Switch on"}
          </button>
        </div>
      </div>
    );
  }

  const wider = s.audience_rule !== "consent_only";
  return (
    <div className="bc-dialog">
      <label className="bc-switch">
        <input type="checkbox" checked={s.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Allow broadcasts
      </label>
      <p className="bc-soft">Off by default. While it is off you can prepare and test a broadcast, but nothing is sent to customers. Switching it off stops anything going out at once.</p>
      {view.account_block && (
        <div className="bc-notice bc-notice--red">
          <span>
            <strong>WhatsApp has restricted the business account</strong> ({view.account_block.event}). Broadcasts stay stopped until this is cleared.
          </span>
          <label className="bc-check">
            <input type="checkbox" checked={clearBlock} onChange={(e) => setClearBlock(e.target.checked)} /> It has been fixed in WhatsApp Manager: clear the block
          </label>
        </div>
      )}
      <div className="bc-grid2">
        <label className="bc-field">
          <span>Send from (Lagos time)</span>
          <input className="input" type="time" value={s.send_from} onChange={(e) => set("send_from", e.target.value)} />
        </label>
        <label className="bc-field">
          <span>Send until (Lagos time)</span>
          <input className="input" type="time" value={s.send_until} onChange={(e) => set("send_until", e.target.value)} />
        </label>
        <label className="bc-field">
          <span>Speed (messages a minute)</span>
          <input className="input" type="number" min={6} max={60} value={Number.isFinite(s.rate_per_minute) ? s.rate_per_minute : ""} onChange={(e) => set("rate_per_minute", num(e.target.value))} />
        </label>
        <label className="bc-field">
          <span>Leave at least this many days between broadcasts to the same person</span>
          <input className="input" type="number" min={0} max={90} value={Number.isFinite(s.min_days_between) ? s.min_days_between : ""} onChange={(e) => set("min_days_between", num(e.target.value))} />
        </label>
        <label className="bc-field">
          <span>Count an order as coming from a broadcast if placed within (days)</span>
          <input className="input" type="number" min={1} max={30} value={Number.isFinite(s.attribution_days) ? s.attribution_days : ""} onChange={(e) => set("attribution_days", num(e.target.value))} />
        </label>
        <label className="bc-field">
          <span>Use only this share of the daily WhatsApp limit (%)</span>
          <input
            className="input"
            type="number"
            min={10}
            max={100}
            value={Number.isFinite(s.daily_share) ? Math.round(s.daily_share * 100) : ""}
            onChange={(e) => set("daily_share", num(e.target.value) / 100)}
          />
        </label>
      </div>
      <fieldset className="bc-field" style={{ border: 0, padding: 0, margin: 0 }}>
        <span>Who may be sent promotions</span>
        <label className="bc-check">
          <input type="radio" name="audience" checked={!wider} onChange={() => set("audience_rule", "consent_only")} /> Only people who have agreed (recommended)
        </label>
        <label className="bc-check">
          <input type="radio" name="audience" checked={wider} onChange={() => set("audience_rule", "consent_or_recent_customer")} /> People who have agreed, and customers who ordered in the last
          <input
            className="input"
            type="number"
            min={1}
            max={24}
            style={{ width: 70, height: 30 }}
            value={Number.isFinite(s.recent_customer_months) ? s.recent_customer_months : ""}
            onChange={(e) => set("recent_customer_months", num(e.target.value))}
            aria-label="Months"
          />
          months
        </label>
        {wider && (
          <div className="bc-notice bc-notice--amber">
            <span>Check with a lawyer before choosing this. It sends promotions to people who have not said yes.</span>
            <label className="bc-check">
              <input type="checkbox" checked={legal} onChange={(e) => setLegal(e.target.checked)} /> I have checked this is allowed
            </label>
          </div>
        )}
      </fieldset>
      <div className="bc-quote" style={{ whiteSpace: "normal" }}>
        <div>
          WhatsApp daily limit:{" "}
          {view.limit ? `${groupThousands(view.limit.per_day)} new conversations (${view.limit.tier ?? "not set"})` : "no WhatsApp number yet"}
        </div>
        <div>Number quality: {qualityText(view.quality_rating)}</div>
        <div>Meta's marketing route: {mmText(view.mm_status)}</div>
        <label className="bc-check" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={s.route === "mm"} disabled={view.mm_status !== "ONBOARDED" && s.route !== "mm"} onChange={(e) => set("route", e.target.checked ? "mm" : "cloud")} />
          Send promotions through Meta's marketing route
        </label>
      </div>
      {error && <p className="bc-notice bc-notice--red">{error}</p>}
      <div className="bc-row">
        <span className="bc-spacer" />
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" onClick={onSave} disabled={busy || (wider && !legal)}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

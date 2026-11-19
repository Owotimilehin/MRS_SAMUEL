/**
 * Ads → Settings (suite spec 12, 7.7). Owner only. Three switches live here and
 * every one starts off: reporting purchases to Meta, creating adverts from the
 * suite, and rules that pause by themselves. Turning one ON asks first, with
 * what it means in plain words.
 */
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { money } from "@ms/shared";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { humanizeError } from "@admin/lib/api.js";
import { toast } from "@admin/lib/toast.js";
import { adsApi, adsKeys, type AdsSettings as Settings, type AdsStatus } from "./ads-api.js";
import { dateTime } from "./ads-logic.js";
import { CalibrateDialog } from "./CalibrateDialog.js";
import { LinkAccountDialog } from "./LinkAccountDialog.js";

const CAPI_TEXT =
  "When a customer who came from a WhatsApp advert pays for an order, the suite tells Meta that a purchase of that amount happened. This helps Meta show what your adverts earn. We send only the amount, the time, and the click code Meta gave that advert tap. We never send names, phone numbers or what was bought.";
const PRIVACY_TICK = "Our privacy policy tells customers that we share purchase information with Meta to measure our adverts.";
const MANAGE_TEXT =
  "This can spend money from your ad account. Only people you have given the 'manage ads' permission can use it. Everything is recorded in the activity log.";
const RULES_TEXT = "Rules can only pause. Nothing turns an advert on by itself.";
const CAP_HELP =
  "The suite refuses to turn on an advert or raise a budget if that would take the total above this. It counts every running advert in the ad account, including ones made in Meta Ads Manager. Set 0 to stop anything being turned on. Meta can spend a little over a daily budget on a busy day, so also set an account spending limit in Meta Ads Manager.";

type SwitchKey = "capi_enabled" | "manage_enabled" | "rules_enabled";
const SWITCH: Record<SwitchKey, { label: string; text: string }> = {
  capi_enabled: { label: "Report purchases to Meta", text: CAPI_TEXT },
  manage_enabled: { label: "Allow adverts to be created and changed from the suite", text: MANAGE_TEXT },
  rules_enabled: { label: "Let rules pause adverts by themselves", text: RULES_TEXT },
};

function Row({ label, children, control }: { label: string; children: ReactNode; control: ReactNode }): JSX.Element {
  return (
    <div className="ads-row">
      <div className="ads-row__text">
        <span className="ads-row__label">{label}</span>
        {children}
      </div>
      <div className="ads-actions">{control}</div>
    </div>
  );
}

export function AdsSettings({ status }: { status: AdsStatus }): JSX.Element {
  const qc = useQueryClient();
  const { account, settings } = status;
  const [dialog, setDialog] = useState<"link" | "calibrate" | "unlink" | null>(null);
  const [turningOn, setTurningOn] = useState<SwitchKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(String(settings.attribution_window_days));
  const [cap, setCap] = useState(String(settings.daily_cap));
  const currency = account?.currency ?? "NGN";
  const reload = () => qc.invalidateQueries({ queryKey: adsKeys.all });

  async function save(patch: Partial<Settings>, done?: string): Promise<boolean> {
    setBusy(true);
    try {
      await adsApi.saveSettings(patch);
      await reload();
      if (done) toast.success(done);
      return true;
    } catch (e) {
      toast.error(humanizeError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Turning a switch off is immediate; turning it on asks first. */
  function flip(key: SwitchKey, on: boolean): void {
    if (on) setTurningOn(key);
    else void save({ [key]: false });
  }

  async function unlink(): Promise<void> {
    setBusy(true);
    try {
      await adsApi.unlink();
      setDialog(null);
      await reload();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  const daysValue = Number(days);
  const daysValid = /^\d+$/.test(days.trim()) && daysValue >= 1 && daysValue <= 28;
  const capValue = Number(cap);
  const capValid = /^\d+$/.test(cap.trim()) && capValue >= 0;
  const canManageHere = !!account && account.budget_calibrated && account.manageable_currency;

  return (
    <div className="ads-page">
      <section className="card ads-card">
        <h2 className="ads-h">Ad account</h2>
        {account ? (
          <Row
            label={account.name}
            control={
              <>
                <button type="button" className="btn btn--subtle btn--sm" onClick={() => setDialog("link")}>
                  Change
                </button>
                <button type="button" className="btn btn--subtle btn--sm" onClick={() => setDialog("unlink")}>
                  Unlink
                </button>
              </>
            }
          >
            <span className="ads-sub">
              {account.ad_account_id} · {account.currency} · {account.timezone_name}
            </span>
            <span className="ads-sub">Last updated {account.last_synced_at ? dateTime(account.last_synced_at) : "not yet"}</span>
            {account.problem ? <span className="ads-strip ads-strip--warn">{account.problem}</span> : null}
          </Row>
        ) : (
          <Row
            label="No ad account is linked yet"
            control={
              <button type="button" className="btn btn--primary btn--sm" onClick={() => setDialog("link")}>
                Choose ad account
              </button>
            }
          >
            <ol className="ads-steps">
              <li>In Meta Business Settings, open Users → System users → NEWUSERSYSTEM.</li>
              <li>Choose Assign assets → Ad accounts, pick your ad account and allow it to view performance.</li>
              <li>Come back and press &apos;Choose ad account&apos;.</li>
            </ol>
          </Row>
        )}
      </section>

      <section className="card ads-card">
        <h2 className="ads-h">Counting orders</h2>
        <Row
          label="Count an order when it comes within this many days of the advert tap"
          control={
            <>
              <input className="input" style={{ width: 80 }} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Days" />
              <button
                type="button"
                className="btn btn--subtle btn--sm"
                disabled={busy || !daysValid || daysValue === settings.attribution_window_days}
                onClick={() => void save({ attribution_window_days: daysValue }, "Saved")}
              >
                Save
              </button>
            </>
          }
        >
          <span className="ads-sub">Between 1 and 28 days. Changing this affects orders counted from now on.</span>
        </Row>
      </section>

      <section className="card ads-card">
        <h2 className="ads-h">Tell Meta about purchases</h2>
        <Row
          label={SWITCH.capi_enabled.label}
          control={
            <label className="ads-switch">
              <input
                type="checkbox"
                checked={settings.capi_enabled}
                disabled={busy || (!settings.capi_enabled && !settings.capi_privacy_confirmed)}
                onChange={(e) => flip("capi_enabled", e.target.checked)}
                aria-label={SWITCH.capi_enabled.label}
              />
              <span>{settings.capi_enabled ? "On" : "Off"}</span>
            </label>
          }
        >
          <span className="ads-sub">{CAPI_TEXT}</span>
          <label className="ads-check">
            <input
              type="checkbox"
              checked={settings.capi_privacy_confirmed}
              disabled={busy}
              onChange={(e) => void save({ capi_privacy_confirmed: e.target.checked })}
            />
            <span>{PRIVACY_TICK}</span>
          </label>
          {!settings.capi_privacy_confirmed ? <span className="ads-sub">Tick the statement above before this can be turned on.</span> : null}
        </Row>
      </section>

      <section className="card ads-card">
        <h2 className="ads-h">Creating adverts from the suite</h2>
        <Row
          label={SWITCH.manage_enabled.label}
          control={
            <label className="ads-switch">
              <input
                type="checkbox"
                checked={settings.manage_enabled}
                disabled={busy || (!settings.manage_enabled && !canManageHere)}
                onChange={(e) => flip("manage_enabled", e.target.checked)}
                aria-label={SWITCH.manage_enabled.label}
              />
              <span>{settings.manage_enabled ? "On" : "Off"}</span>
            </label>
          }
        >
          <span className="ads-sub">{MANAGE_TEXT}</span>
          {account && !account.manageable_currency ? (
            <span className="ads-strip ads-strip--warn">The suite can only manage adverts for an ad account in naira. This one is in {account.currency}.</span>
          ) : null}
          {account && account.manageable_currency ? (
            <span className="ads-actions">
              <span className="ads-sub">
                {account.budget_calibrated ? `Budget unit checked: Meta writes ₦1 as ${account.budget_factor}.` : "The budget unit has not been checked yet."}
              </span>
              <button type="button" className="btn btn--subtle btn--sm" onClick={() => setDialog("calibrate")}>
                Check the budget unit
              </button>
            </span>
          ) : null}
          {!account ? <span className="ads-sub">Link the ad account first.</span> : null}
        </Row>
        <Row
          label={`Daily cap (${currency})`}
          control={
            <>
              <input className="input" style={{ width: 130 }} inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Daily cap" />
              <button
                type="button"
                className="btn btn--subtle btn--sm"
                disabled={busy || !capValid || capValue === settings.daily_cap}
                onClick={() => void save({ daily_cap: capValue }, `Daily cap set to ${money(capValue, currency)}`)}
              >
                Save
              </button>
            </>
          }
        >
          <span>The most all running adverts together may be set to spend in a day. Now {money(settings.daily_cap, currency)}.</span>
          <span className="ads-sub">{CAP_HELP}</span>
        </Row>
        <Row
          label={SWITCH.rules_enabled.label}
          control={
            <label className="ads-switch">
              <input type="checkbox" checked={settings.rules_enabled} disabled={busy} onChange={(e) => flip("rules_enabled", e.target.checked)} aria-label={SWITCH.rules_enabled.label} />
              <span>{settings.rules_enabled ? "On" : "Off"}</span>
            </label>
          }
        >
          <span className="ads-sub">{RULES_TEXT}</span>
        </Row>
      </section>

      {dialog === "link" ? (
        <LinkAccountDialog
          currentId={account?.ad_account_id ?? null}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void reload();
          }}
        />
      ) : null}
      {dialog === "calibrate" ? (
        <CalibrateDialog
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void reload();
          }}
        />
      ) : null}
      {dialog === "unlink" ? (
        <ConfirmModal title="Unlink the ad account?" confirmLabel="Unlink" busyLabel="Unlinking…" onConfirm={() => void unlink()} onCancel={() => setDialog(null)} busy={busy} tone="danger">
          <p style={{ margin: 0 }}>Stop reading this ad account? Figures already collected are kept.</p>
        </ConfirmModal>
      ) : null}
      {turningOn ? (
        <ConfirmModal
          title={`Turn on '${SWITCH[turningOn].label}'?`}
          confirmLabel="Turn on"
          busyLabel="Turning on…"
          busy={busy}
          tone={turningOn === "manage_enabled" ? "danger" : "primary"}
          onCancel={() => setTurningOn(null)}
          onConfirm={() => {
            const key = turningOn;
            void save({ [key]: true }).then(() => setTurningOn(null));
          }}
        >
          <p style={{ margin: 0 }}>{SWITCH[turningOn].text}</p>
          {turningOn === "manage_enabled" ? (
            <p style={{ marginBottom: 0 }}>
              Your daily cap is {money(settings.daily_cap, currency)}.{settings.daily_cap === 0 ? " With a cap of 0, nothing can be turned on until you set one." : ""}
            </p>
          ) : null}
        </ConfirmModal>
      ) : null}
    </div>
  );
}

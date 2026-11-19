/**
 * One advert (suite spec 12, 7.5): its words, state and figures, the chats it
 * started, and (for someone with the manage-ads permission) Pause, and for an
 * advert made in the suite, Turn on and Change daily budget. An advert made in
 * Meta Ads Manager can only be paused from here.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { money } from "@ms/shared";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { DataState } from "@admin/components/DataState.js";
import { Stat } from "@admin/components/Stat.js";
import { ngn } from "@admin/lib/analytics-theme.js";
import { humanizeError } from "@admin/lib/api.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { lagosDaysAgo } from "@admin/lib/inbox-logic.js";
import { toast } from "@admin/lib/toast.js";
import "@admin/components/inbox/inbox.css";
import "./ads.css";
import { adsApi, adsKeys } from "./ads-api.js";
import { dateTime, dayZoneCaption, destinationLabel, statusLabel, statusTone } from "./ads-logic.js";
import { AdChatsTable } from "./AdChatsTable.js";
import { SpendChart } from "./AdsOverview.js";
import { BudgetDialog } from "./BudgetDialog.js";
import { TurnOnDialog } from "./TurnOnDialog.js";

export function AdvertPage({ adId }: { adId: string }): JSX.Element {
  const can = useCan();
  const qc = useQueryClient();
  const canManage = can("ads.manage");
  const [from, setFrom] = useState(() => lagosDaysAgo(29));
  const [to, setTo] = useState(() => lagosDaysAgo(0));
  const [dialog, setDialog] = useState<"on" | "pause" | "budget" | null>(null);
  const [busy, setBusy] = useState(false);
  const status = useQuery({ queryKey: adsKeys.status, queryFn: adsApi.status });
  const q = useQuery({ queryKey: adsKeys.advert(adId, from, to), queryFn: () => adsApi.advert(adId, from, to), enabled: from <= to });
  const a = q.data;
  const reload = () => qc.invalidateQueries({ queryKey: adsKeys.all });

  async function pause(): Promise<void> {
    if (!a?.campaign_external_id) return;
    setBusy(true);
    try {
      // For any advert, pausing its campaign stops it spending.
      await adsApi.pause("campaign", a.campaign_external_id);
      setDialog(null);
      toast.success("Paused. It stops spending within a few minutes.");
      await reload();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  const name = a?.name ?? `Advert ${adId}`;
  const currency = a?.currency ?? "NGN";
  const running = a?.campaign_status === "ACTIVE";
  const manageOn = status.data?.settings.manage_enabled === true;

  return (
    <Frame title={name} crumb="Ads">
      <div className="ads-page">
        <div>
          <Link to="/ads" className="ads-link">
            ← All adverts
          </Link>
        </div>
        <div className="ads-bar">
          <label className="field">
            <span className="field__label">From</span>
            <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">To</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
          {a ? (
            <>
              <section className="card ads-card">
                <div className="ads-actions" style={{ justifyContent: "space-between" }}>
                  <div>
                    <span className={`ads-tag ads-tag--${statusTone(a.effective_status)}`}>{statusLabel(a.effective_status)}</span>{" "}
                    {a.created_by_suite ? <span className="ads-tag ads-tag--suite">Made in the suite</span> : null}
                  </div>
                  {canManage && a.campaign_external_id ? (
                    <div className="ads-actions">
                      {a.created_by_suite && !running ? (
                        <button type="button" className="btn btn--primary btn--sm" disabled={!manageOn} onClick={() => setDialog("on")}>
                          Turn on
                        </button>
                      ) : null}
                      {running ? (
                        <button type="button" className="btn btn--subtle btn--sm" onClick={() => setDialog("pause")}>
                          Pause
                        </button>
                      ) : null}
                      {a.created_by_suite && a.adset_external_id ? (
                        <button type="button" className="btn btn--subtle btn--sm" disabled={!manageOn} onClick={() => setDialog("budget")}>
                          Change daily budget
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="ads-name">{a.creative.title ?? "No headline"}</div>
                <div>{a.creative.body ?? ""}</div>
                <div className="ads-sub">
                  Opens: {destinationLabel(a.destination)}
                  {a.start_time ? ` · Starts ${dateTime(a.start_time)}` : ""}
                  {a.budget?.end_time ? ` · Ends ${dateTime(a.budget.end_time)}` : ""}
                  {a.budget ? ` · Daily budget ${money(a.budget.daily, currency)}` : ""}
                </div>
                {canManage && !a.created_by_suite ? (
                  <p className="ads-fine">This advert was made in Meta Ads Manager. To turn it on or change it, use Ads Manager.</p>
                ) : null}
                {canManage && a.created_by_suite && !manageOn ? (
                  <p className="ads-fine">Creating and changing adverts is switched off. The owner can turn it on in Ads → Settings. Pausing still works.</p>
                ) : null}
              </section>
              <div className="ibx-stats">
                <Stat label="Spent" value={money(a.spend, currency)} tone="accent" />
                <Stat label="Times shown" value={a.impressions.toLocaleString("en-NG")} />
                <Stat label="Taps" value={a.clicks.toLocaleString("en-NG")} />
                <Stat label="Chats started (Meta's count)" value={String(a.conversations_started)} />
                <Stat label="Chats we saw" value={String(a.chats_seen)} />
                <Stat label="Cost per chat" value={a.cost_per_conversation === null ? "—" : money(Math.round(a.cost_per_conversation), currency)} />
                <Stat label="Orders traced to this advert" value={String(a.orders)} tone="good" />
                <Stat label="Sales from those orders" value={ngn(a.order_value_ngn)} tone="good" />
              </div>
              <section className="card">
                <h2 className="t-h2" style={{ marginBottom: 2 }}>Spend and chats by day</h2>
                <p className="ads-chartcap">{dayZoneCaption(a.day_zone)}</p>
                <SpendChart days={a.per_day} currency={currency} />
              </section>
            </>
          ) : null}
        </DataState>
        <section className="card ads-card">
          <h2 className="ads-h">Chats from this advert</h2>
          <AdChatsTable key={`${from}:${to}`} from={from} to={to} ad={adId} canManage={canManage} />
        </section>
      </div>
      {dialog === "on" && a?.campaign_external_id ? (
        <TurnOnDialog
          campaignId={a.campaign_external_id}
          name={name}
          currency={currency}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            toast.success("Turned on. Meta will check the advert before it runs.");
            void reload();
          }}
        />
      ) : null}
      {dialog === "budget" && a?.adset_external_id ? (
        <BudgetDialog
          adsetId={a.adset_external_id}
          name={name}
          currency={currency}
          currentDaily={a.budget?.daily ?? null}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            toast.success("Budget changed.");
            void reload();
          }}
        />
      ) : null}
      {dialog === "pause" ? (
        <ConfirmModal title={`Pause "${name}"?`} confirmLabel="Pause" busyLabel="Pausing…" onConfirm={() => void pause()} onCancel={() => setDialog(null)} busy={busy}>
          <p style={{ margin: 0 }}>It stops spending within a few minutes.</p>
        </ConfirmModal>
      ) : null}
    </Frame>
  );
}

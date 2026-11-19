/**
 * Ads (suite spec 12, section 7): what the adverts cost and what they brought
 * in. Reading needs the "see ad results" permission. The Rules tab and every
 * button that can change an advert need "manage ads"; Settings is the owner's.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { InlineLoader } from "@admin/components/Spinner.js";
import { humanizeError } from "@admin/lib/api.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useAuthUser, useCan } from "@admin/lib/auth.js";
import { lagosDaysAgo } from "@admin/lib/inbox-logic.js";
import { toast } from "@admin/lib/toast.js";
import "@admin/components/inbox/inbox.css";
import "./ads.css";
import { adsApi, adsKeys, type AdsStatus } from "./ads-api.js";
import { dateTime, tabsFor, type AdsTab } from "./ads-logic.js";
import { AdChatsTable } from "./AdChatsTable.js";
import { AdsLog } from "./AdsLog.js";
import { AdsOverview, HowWeCount } from "./AdsOverview.js";
import { AdsSettings } from "./AdsSettings.js";
import { AdvertsTable } from "./AdvertsTable.js";
import { RulesTab } from "./RulesTab.js";

const PRESETS = [
  { label: "7 days", days: 6 },
  { label: "30 days", days: 29 },
  { label: "90 days", days: 89 },
] as const;

/** 7.2: shown on Overview and Adverts while no ad account is linked. */
function NotLinked({ isOwner, onChoose }: { isOwner: boolean; onChoose: () => void }): JSX.Element {
  return (
    <section className="card ads-card">
      <h2 className="ads-h">No ad account is linked yet</h2>
      {isOwner ? (
        <>
          <ol className="ads-steps">
            <li>In Meta Business Settings, open Users → System users → NEWUSERSYSTEM.</li>
            <li>Choose Assign assets → Ad accounts, pick your ad account and allow it to view performance.</li>
            <li>Come back and press &apos;Choose ad account&apos;.</li>
          </ol>
          <div>
            <button type="button" className="btn btn--primary" onClick={onChoose}>
              Choose ad account
            </button>
          </div>
        </>
      ) : (
        <p style={{ margin: 0 }}>The owner needs to link the ad account first.</p>
      )}
    </section>
  );
}

function Screen({ status }: { status: AdsStatus }): JSX.Element {
  const user = useAuthUser();
  const can = useCan();
  const qc = useQueryClient();
  const isOwner = user.role === "owner";
  const canManage = can("ads.manage");
  const tabs = tabsFor({ canManage, isOwner });
  const [tab, setTab] = useState<AdsTab>("overview");
  const [from, setFrom] = useState(() => lagosDaysAgo(29));
  const [to, setTo] = useState(() => lagosDaysAgo(0));
  const [refreshing, setRefreshing] = useState(false);
  const today = lagosDaysAgo(0);
  const linked = !!status.account;
  const dated = tab === "overview" || tab === "adverts" || tab === "chats";

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      await adsApi.refresh();
      toast.success("Asked Meta for fresh figures. They arrive within a few minutes.");
      await qc.invalidateQueries({ queryKey: adsKeys.status });
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="ads-page">
      <div className="ibx-tabs" role="tablist" aria-label="Ads sections" style={{ flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`ibx-tab${tab === t.id ? " is-active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {dated ? (
        <div className="ads-bar">
          <label className="field">
            <span className="field__label">From</span>
            <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">To</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
          <div className="ibx-tabs" role="group" aria-label="Quick date ranges">
            {PRESETS.map((p) => {
              const on = to === today && from === lagosDaysAgo(p.days);
              return (
                <button
                  key={p.label}
                  type="button"
                  className={`ibx-tab${on ? " is-active" : ""}`}
                  aria-pressed={on}
                  onClick={() => {
                    setFrom(lagosDaysAgo(p.days));
                    setTo(lagosDaysAgo(0));
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          {linked ? (
            <div className="ads-bar__right">
              <span className="ads-fine">Last updated {status.account?.last_synced_at ? dateTime(status.account.last_synced_at) : "not yet"}</span>
              <button type="button" className="btn btn--subtle btn--sm" disabled={refreshing} onClick={() => void refresh()}>
                <RefreshCw size={14} /> Refresh figures
              </button>
              <a className="btn btn--subtle btn--sm" href={adsApi.exportUrl(from, to)} download>
                <Download size={14} /> Download spreadsheet
              </a>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "overview" ? (
        linked ? (
          <AdsOverview from={from} to={to} status={status} />
        ) : (
          <>
            <NotLinked isOwner={isOwner} onChoose={() => setTab("settings")} />
            <HowWeCount windowDays={status.settings.attribution_window_days} />
          </>
        )
      ) : null}
      {tab === "adverts" ? linked ? <AdvertsTable from={from} to={to} status={status} canManage={canManage} /> : <NotLinked isOwner={isOwner} onChoose={() => setTab("settings")} /> : null}
      {tab === "chats" ? (
        <section className="card ads-card">
          <AdChatsTable key={`${from}:${to}`} from={from} to={to} canManage={canManage} />
        </section>
      ) : null}
      {tab === "rules" && canManage ? <RulesTab currency={status.account?.currency ?? "NGN"} /> : null}
      {tab === "log" ? <AdsLog /> : null}
      {tab === "settings" && isOwner ? <AdsSettings status={status} /> : null}
    </div>
  );
}

export function AdsPage(): JSX.Element {
  const can = useCan();
  const status = useQuery({ queryKey: adsKeys.status, queryFn: adsApi.status, enabled: can("ads.view"), refetchInterval: 60_000 });
  let body: JSX.Element;
  if (!can("ads.view")) {
    body = <div className="card">You don&apos;t have access to ad results. Ask the owner.</div>;
  } else if (status.isLoading) {
    body = <InlineLoader />;
  } else if (status.error || !status.data) {
    body = (
      <div className="empty" style={{ display: "grid", gap: 12, justifyItems: "center" }}>
        <div>We couldn&apos;t load Ads. Check your connection and try again.</div>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void status.refetch()}>
          Try again
        </button>
      </div>
    );
  } else {
    body = <Screen status={status.data} />;
  }
  return <Frame title="Ads">{body}</Frame>;
}

/**
 * Insights (suite spec 11, section 7): figures from Facebook, Instagram and WhatsApp for
 * the dates picked, with the suite's own inbox numbers beside them, never added to them.
 * Everything shown was stored by the daily collection; this page only reads it. The one
 * thing it can change at Meta is behind the owner's dialog in the WhatsApp section.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { DataState } from "@admin/components/DataState.js";
import { StatHero } from "@admin/components/StatHero.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useAuthUser, useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import "@admin/components/inbox/inbox.css";
import { EXPORT_URL, insightKeys, insightsApi } from "./insights-api.js";
import { FIXED, lastUpdatedText, presetRange, rangeDays, validRange } from "./insights-logic.js";
import { InsightTiles } from "./InsightTiles.js";
import { SourceNotices } from "./SourceNotices.js";
import { TopPostsTable } from "./TopPostsTable.js";
import { TrendChart, type FigureOption } from "./TrendChart.js";
import { InboxMessagesChart, WhatsAppMessagesChart, WhatsAppPanel } from "./WhatsAppPanel.js";
import "./insights.css";

const PRESETS = [7, 30, 90] as const;

const one = (label: string, metric: string, as: "bar" | "line" = "bar"): FigureOption => ({ label, as, series: [{ metric, name: label }] });

const FACEBOOK_FIGURES: FigureOption[] = [
  one("Views", "page_media_view"),
  one("People who saw our content", "page_total_media_view_unique"),
  one("Reactions, comments and shares", "page_post_engagements"),
  one("Page visits", "page_views_total"),
  one("New followers", "page_daily_follows_unique"),
  one("Followers", "page_follows", "line"),
];

const INSTAGRAM_FIGURES: FigureOption[] = [
  one("Views", "views"),
  { label: "Views by type", as: "bar", allParts: true, series: [{ metric: "views", name: "Views" }] },
  one("Accounts reached", "reach"),
  one("Likes, comments, shares and saves", "total_interactions"),
  {
    label: "New followers and unfollows",
    as: "bar",
    emptyNote: FIXED.noFollowerFigures,
    series: [
      { metric: "follows_and_unfollows", breakdown: "follow_type=FOLLOWER", name: "New followers" },
      { metric: "follows_and_unfollows", breakdown: "follow_type=NON_FOLLOWER", name: "Unfollows" },
    ],
  },
  one("Followers", "followers_count", "line"),
];

/** After "Refresh figures": look every 10 seconds, for at most 5 minutes. */
const POLL_MS = 10_000;
const POLL_FOR_MS = 5 * 60_000;

export function InsightsPage(): JSX.Element {
  const can = useCan();
  if (!can("insights.view")) {
    return (
      <Frame title="Insights">
        <div className="empty">
          <div className="empty__title">No access</div>
          Ask the owner if you need to see statistics.
        </div>
      </Frame>
    );
  }
  return <Loaded />;
}

function Loaded(): JSX.Element {
  const can = useCan();
  const user = useAuthUser();
  const qc = useQueryClient();
  const [{ from, to }, setRange] = useState(() => presetRange(30));
  const ok = validRange(from, to);
  const days = ok ? rangeDays(from, to) : 0;

  // While waiting for a refresh: what "last updated" said when the button was pressed, and when that was.
  const [waiting, setWaiting] = useState<{ since: number; lastRunAt: string | null } | null>(null);
  const [asking, setAsking] = useState(false);

  const summary = useQuery({ queryKey: insightKeys.summary(from, to), queryFn: () => insightsApi.summary(from, to), enabled: ok });
  const status = useQuery({ queryKey: insightKeys.status, queryFn: insightsApi.status, refetchInterval: waiting ? POLL_MS : false });

  useEffect(() => {
    if (!waiting) return;
    if (status.data && status.data.last_run_at !== waiting.lastRunAt) {
      setWaiting(null);
      toast.success("The figures are up to date.");
      void qc.invalidateQueries({ queryKey: insightKeys.all });
      return;
    }
    const left = waiting.since + POLL_FOR_MS - Date.now();
    const stop = setTimeout(() => setWaiting(null), Math.max(0, left));
    return () => clearTimeout(stop);
  }, [waiting, status.data, qc]);

  async function refresh(): Promise<void> {
    setAsking(true);
    try {
      await insightsApi.refresh();
      setWaiting({ since: Date.now(), lastRunAt: status.data?.last_run_at ?? null });
      toast.success("Fetching the latest figures. This takes a minute or two.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setAsking(false);
    }
  }

  const refreshButton = (
    <button type="button" className="btn btn--subtle btn--sm" onClick={() => void refresh()} disabled={asking || waiting !== null}>
      <RefreshCw size={14} /> {waiting ? "Fetching…" : "Refresh figures"}
    </button>
  );
  const s = summary.data;
  const nothingYet = !!s && !!status.data && status.data.last_run_at === null && s.tiles.every((t) => t.value === null);
  const hasSource = (source: string): boolean => (s?.sources ?? []).some((x) => x.source === source && x.account_key !== "");
  const preset = PRESETS.find((d) => {
    const p = presetRange(d);
    return p.from === from && p.to === to;
  });

  return (
    <Frame title="Insights">
      <StatHero eyebrow="Insights" title="How we are doing" sub="Figures from Facebook, Instagram and WhatsApp, with our own inbox numbers beside them." />

      <div className="ins-page">
        <div className="toolbar ins-bar">
          <label className="field">
            <span className="field__label">From</span>
            <input className="input" type="date" value={from} max={to} onChange={(e) => setRange({ from: e.target.value, to })} />
          </label>
          <label className="field">
            <span className="field__label">To</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => setRange({ from, to: e.target.value })} />
          </label>
          <div className="ibx-tabs" role="group" aria-label="Quick date ranges">
            {PRESETS.map((d) => (
              <button key={d} type="button" className={`ibx-tab${preset === d ? " is-active" : ""}`} aria-pressed={preset === d} onClick={() => setRange(presetRange(d))}>
                {d} days
              </button>
            ))}
          </div>
          {refreshButton}
          {ok && (
            <a className="btn btn--subtle btn--sm" href={EXPORT_URL(from, to)} download title="Download every figure for these dates as a spreadsheet (CSV)">
              <Download size={14} /> Download spreadsheet
            </a>
          )}
          <span className="ins-updated">Last updated {lastUpdatedText(status.data?.last_run_at ?? null)}</span>
        </div>

        {!ok ? (
          <div className="ins-notice ins-notice--bad">Pick a range of up to 400 days, with the first date before the second.</div>
        ) : (
          <>
            <DataState loading={summary.isLoading} error={summary.error} onRetry={() => void summary.refetch()}>
              {s && (
                <>
                  <SourceNotices sources={s.sources} canManageChannels={can("channels.manage")} />
                  {nothingYet ? (
                    <div className="card ins-first">
                      <p>{FIXED.nothingYet}</p>
                      {refreshButton}
                    </div>
                  ) : (
                    <InsightTiles tiles={s.tiles} sources={s.sources} days={days} currency={s.cost_currency} />
                  )}
                </>
              )}
            </DataState>

            <div className="ins-grid">
              {hasSource("facebook_page") && (
                <TrendChart title="Facebook" network="Facebook" source="facebook_page" options={FACEBOOK_FIGURES} from={from} to={to} dimNewest={1} />
              )}
              {hasSource("instagram_account") && (
                <TrendChart title="Instagram" network="Instagram" source="instagram_account" options={INSTAGRAM_FIGURES} from={from} to={to} dimNewest={2} />
              )}
              <WhatsAppMessagesChart from={from} to={to} />
              {can("inbox.reports") && <InboxMessagesChart from={from} to={to} />}
            </div>

            {(hasSource("facebook_page") || hasSource("instagram_account")) && <TopPostsTable from={from} to={to} />}
            <WhatsAppPanel from={from} to={to} isOwner={user.role === "owner"} showInbox={can("inbox.reports") && can("inbox.view")} />
          </>
        )}
        <p className="ins-fine ins-bottom">{FIXED.bottom}</p>
      </div>
    </Frame>
  );
}

/**
 * Posts (suite spec 09, 7.1): what is scheduled, drafted, posted and what needs
 * attention, as a list or a month calendar in Lagos time.
 *
 * People who hold only social.publish have no live stream (foundation ruling 9.2.12),
 * so the list refreshes itself: every 20 seconds while something is going out, else
 * every 30 seconds.
 */
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Film, Link as LinkIcon, Settings, Type } from "lucide-react";
import { DataState } from "@admin/components/DataState.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useAuthUser } from "@admin/lib/auth.js";
import { postsApi, postsKeys, type PostJson, type PostListStatus } from "./posts-api.js";
import {
  calendarTime,
  calendarWeeks,
  captionStart,
  dayTitle,
  lagosDay,
  lagosTime,
  monthTitle,
  statusLabel,
  statusTone,
  targetShort,
  timeLine,
} from "./posts-logic.js";
import { NetworkIcon } from "./PostPreview.js";
import { PostsSettingsDialog } from "./PostsSettingsDialog.js";
import "./posts.css";

type Tab = Exclude<PostListStatus, "all">;
const TABS: { tab: Tab; label: string; emptyTitle: string; emptyHint: string }[] = [
  { tab: "scheduled", label: "Scheduled", emptyTitle: "Nothing scheduled", emptyHint: "Schedule a post and it will show here." },
  { tab: "draft", label: "Drafts", emptyTitle: "No drafts", emptyHint: "Drafts you save show here." },
  { tab: "posted", label: "Posted", emptyTitle: "Nothing posted yet", emptyHint: "Posts you send from the suite show here." },
  { tab: "problems", label: "Needs attention", emptyTitle: "Nothing needs attention", emptyHint: "Posts that fail or need checking show here." },
];

const refreshEvery = (posts: PostJson[] | undefined): number => (posts?.some((p) => p.status === "publishing") ? 20_000 : 30_000);

function Thumb({ post }: { post: PostJson }): JSX.Element {
  const first = post.media[0];
  if (first?.preview_url && first.mime.startsWith("image/")) return <img className="po-thumb" src={first.preview_url} alt="" />;
  const Icon = first ? Film : post.kind === "link" ? LinkIcon : Type;
  return (
    <div className="po-thumb">
      <Icon size={20} aria-hidden="true" />
    </div>
  );
}

function Row({ post }: { post: PostJson }): JSX.Element {
  return (
    <li>
      <Link to="/posts/$postId" params={{ postId: post.id }} className="card po-row">
        <Thumb post={post} />
        <div className="po-row__text">
          <div className="po-row__caption">{captionStart(post.caption)}</div>
          <div className="po-row__meta">
            {post.targets.map((t) => (
              <span key={t.id} title={targetShort(t)} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <NetworkIcon network={t.network} size={14} />
                {targetShort(t)}
              </span>
            ))}
            <span>{timeLine(post)}</span>
            {post.created_by && <span>{post.created_by.name}</span>}
          </div>
        </div>
        <span className={`po-tone po-tone--${statusTone(post.status)}`}>{statusLabel(post.status)}</span>
      </Link>
    </li>
  );
}

function ListView({ tab }: { tab: Tab }): JSX.Element {
  const meta = TABS.find((t) => t.tab === tab)!;
  const q = useQuery({
    queryKey: postsKeys.list({ status: tab }),
    queryFn: () => postsApi.list({ status: tab, limit: 100 }),
    refetchInterval: (query) => refreshEvery(query.state.data),
  });
  return (
    <DataState
      loading={q.isLoading}
      error={q.error}
      onRetry={() => void q.refetch()}
      isEmpty={(q.data?.length ?? 0) === 0}
      emptyTitle={meta.emptyTitle}
      emptyHint={meta.emptyHint}
    >
      <ul className="po-list">{q.data?.map((p) => <Row key={p.id} post={p} />)}</ul>
    </DataState>
  );
}

function Chip({ post }: { post: PostJson }): JSX.Element {
  return (
    <Link
      to="/posts/$postId"
      params={{ postId: post.id }}
      className={`po-chip po-tone--${statusTone(post.status)}`}
      title={`${statusLabel(post.status)}: ${captionStart(post.caption)}`}
    >
      {lagosTime(calendarTime(post))} · {captionStart(post.caption, 40)}
    </Link>
  );
}

function CalendarView(): JSX.Element {
  const navigate = useNavigate();
  const today = lagosDay(new Date());
  const [ym, setYm] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }));
  const weeks = calendarWeeks(ym.year, ym.month);
  const from = weeks[0]![0]!;
  const to = weeks[weeks.length - 1]![6]!;
  const filter = { status: "all" as const, from, to, limit: 100 };
  const q = useQuery({
    queryKey: postsKeys.list(filter),
    queryFn: () => postsApi.list(filter),
    refetchInterval: (query) => refreshEvery(query.state.data),
  });
  const byDay = new Map<string, PostJson[]>();
  for (const p of q.data ?? []) {
    const day = lagosDay(calendarTime(p));
    byDay.set(day, [...(byDay.get(day) ?? []), p]);
  }
  for (const list of byDay.values()) list.sort((a, b) => calendarTime(a).localeCompare(calendarTime(b)));
  const step = (by: number): void =>
    setYm(({ year, month }) => {
      const m = month + by;
      return m < 1 ? { year: year - 1, month: 12 } : m > 12 ? { year: year + 1, month: 1 } : { year, month: m };
    });
  const inMonth = (day: string): boolean => Number(day.slice(5, 7)) === ym.month;
  const newOn = (day: string): void => void navigate({ to: "/posts/new", search: { day } });
  const daysWithPosts = weeks.flat().filter((d) => inMonth(d) && byDay.has(d));

  return (
    <div className="po-block">
      <div className="po-cal__head">
        <button type="button" className="btn btn--subtle btn--sm" onClick={() => step(-1)}>
          Earlier
        </button>
        <h2 className="po-h">{monthTitle(ym.year, ym.month)}</h2>
        <button type="button" className="btn btn--subtle btn--sm" onClick={() => step(1)}>
          Later
        </button>
      </div>
      <p className="po-fine">Times are Lagos time. Press + on a day to write a post for it.</p>
      <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        <div className="po-cal__grid">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="po-cal__dow">
              {d}
            </div>
          ))}
          {weeks.flat().map((day) => (
            <div key={day} className={`po-cal__day${inMonth(day) ? "" : " po-cal__day--out"}${day === today ? " po-cal__day--today" : ""}`}>
              <div className="po-cal__num">
                <span>{Number(day.slice(8, 10))}</span>
                {day > today && (
                  <button type="button" className="po-cal__add" aria-label={`New post for ${dayTitle(day)}`} onClick={() => newOn(day)}>
                    +
                  </button>
                )}
              </div>
              {(byDay.get(day) ?? []).map((p) => (
                <Chip key={p.id} post={p} />
              ))}
            </div>
          ))}
        </div>
        <div className="po-cal__list">
          {daysWithPosts.length === 0 ? (
            <div className="empty">
              <div className="empty__title">Nothing this month</div>
              Posts for {monthTitle(ym.year, ym.month)} show here.
            </div>
          ) : (
            daysWithPosts.map((day) => (
              <div key={day} className="po-block">
                <strong>{dayTitle(day)}</strong>
                {(byDay.get(day) ?? []).map((p) => (
                  <Chip key={p.id} post={p} />
                ))}
              </div>
            ))
          )}
        </div>
      </DataState>
    </div>
  );
}

export function PostsPage(): JSX.Element {
  const user = useAuthUser();
  const [tab, setTab] = useState<Tab>("scheduled");
  const [view, setView] = useState<"list" | "calendar">("list");
  const [settings, setSettings] = useState(false);
  // Stable, so the dialog's focus handling is not restarted when the lists behind it refresh.
  const closeSettings = useCallback(() => setSettings(false), []);
  const accounts = useQuery({ queryKey: postsKeys.accounts, queryFn: postsApi.accounts, refetchOnWindowFocus: false });
  const problems = useQuery({
    queryKey: postsKeys.list({ status: "problems" }),
    queryFn: () => postsApi.list({ status: "problems", limit: 100 }),
    refetchInterval: 30_000,
  });
  const problemCount = problems.data?.length ?? 0;

  return (
    <Frame
      title="Posts"
      actions={
        <>
          {user.role === "owner" && (
            <button type="button" className="btn btn--subtle btn--sm" onClick={() => setSettings(true)} aria-label="Settings" title="Settings">
              <Settings size={16} aria-hidden="true" />
            </button>
          )}
          <Link to="/posts/new" className="btn btn--primary btn--sm">
            New post
          </Link>
        </>
      }
    >
      <div className="po-page">
        {accounts.data && accounts.data.data.length === 0 && (
          <div className="po-strip po-strip--warn">
            No Facebook Page or Instagram account is connected yet. <Link to="/channels">Connect one in Channels.</Link>
          </div>
        )}
        <div className="po-bar">
          <div className="po-tabs" role="tablist" aria-label="Posts">
            {TABS.map((t) => (
              <button
                key={t.tab}
                type="button"
                role="tab"
                aria-selected={view === "list" && tab === t.tab}
                className={`po-tab${view === "list" && tab === t.tab ? " po-tab--on" : ""}`}
                onClick={() => {
                  setTab(t.tab);
                  setView("list");
                }}
              >
                {t.label}
                {t.tab === "problems" && problemCount > 0 && <span className="po-badge">{problemCount > 99 ? "99+" : problemCount}</span>}
              </button>
            ))}
          </div>
          <div className="po-tabs" aria-label="View">
            <button type="button" className={`po-tab${view === "list" ? " po-tab--on" : ""}`} aria-pressed={view === "list"} onClick={() => setView("list")}>
              List
            </button>
            <button
              type="button"
              className={`po-tab${view === "calendar" ? " po-tab--on" : ""}`}
              aria-pressed={view === "calendar"}
              onClick={() => setView("calendar")}
            >
              Calendar
            </button>
          </div>
        </div>
        {view === "list" ? <ListView tab={tab} /> : <CalendarView />}
      </div>
      {settings && <PostsSettingsDialog onClose={closeSettings} />}
    </Frame>
  );
}

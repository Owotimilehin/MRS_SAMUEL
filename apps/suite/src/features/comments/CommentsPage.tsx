/**
 * Comments (suite spec 03, 7): every comment on our Facebook Page posts and
 * Instagram posts, the post beside it, and the tools to answer, hide, delete
 * and message privately.
 *
 * People without the Inbox get no live stream (ruling 9.2.12), so the lists
 * also refresh every 30 seconds.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { networkName } from "@ms/shared";
import { DataState } from "@admin/components/DataState.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { useInboxEvents } from "@admin/lib/inbox-stream.js";
import { toast } from "@admin/lib/toast.js";
import "./comments.css";
import { ThreadList } from "./ThreadList.js";
import { ThreadView } from "./ThreadView.js";
import { commentKeys, commentsApi } from "./comments-api.js";
import { COMMENT_TABS, emptyText, threadQuery, type CommentTab } from "./comments-logic.js";

export function CommentsPage({ threadId }: { threadId?: string }): JSX.Element {
  const can = useCan();
  if (!can("social.comments")) {
    return (
      <Frame title="Comments">
        <div className="empty">
          <div className="empty__title">No access</div>
          Ask the owner if you need to answer comments.
        </div>
      </Frame>
    );
  }
  return <Comments threadId={threadId ?? null} />;
}

function Comments({ threadId }: { threadId: string | null }): JSX.Element {
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<CommentTab>("open");
  const [account, setAccount] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [syncing, setSyncing] = useState<string | null>(null);

  // Search a moment after the person stops typing.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const accounts = useQuery({ queryKey: commentKeys.accounts, queryFn: commentsApi.accounts, refetchInterval: 60_000 });
  const query = threadQuery({ tab, account, q });
  const threads = useQuery({
    queryKey: commentKeys.threads(query),
    queryFn: () => commentsApi.threads(query),
    refetchInterval: 30_000,
    enabled: (accounts.data?.length ?? 0) > 0,
  });

  // Live updates for people who also have the Inbox; everyone else gets the 30-second refresh.
  useInboxEvents((e) => {
    if (e.event.startsWith("comment.") || e.event === "reconnected") void qc.invalidateQueries({ queryKey: commentKeys.all });
  }, can("inbox.view"));

  const open = (id: string): void => void navigate({ to: "/comments/$threadId", params: { threadId: id } });
  const close = (): void => void navigate({ to: "/comments" });

  async function tryAgain(accountId: string): Promise<void> {
    setSyncing(accountId);
    try {
      await commentsApi.resync(accountId);
      toast.success("Fetching comments again. This can take a few minutes.");
      await qc.invalidateQueries({ queryKey: commentKeys.accounts });
    } catch {
      /* toast shown by api() */
    } finally {
      setSyncing(null);
    }
  }

  const all = accounts.data ?? [];
  const active = all.filter((a) => a.is_active);
  const rows = threads.data?.data ?? [];
  const empty = emptyText(tab, q.length > 0);

  if (accounts.isLoading || accounts.error || all.length === 0) {
    return (
      <Frame title="Comments">
        <DataState loading={accounts.isLoading} error={accounts.error} onRetry={() => void accounts.refetch()}>
          <div className="empty">
            <div className="empty__title">No Facebook Page or Instagram account yet</div>
            Connect one in Channels and comments will appear here.
            {can("channels.manage") && (
              <div className="cmt-empty-action">
                <Link to="/channels" className="btn btn--primary btn--sm">
                  Open Channels
                </Link>
              </div>
            )}
          </div>
        </DataState>
      </Frame>
    );
  }

  return (
    <Frame title="Comments">
      <div className={`cmt-page${threadId ? " has-thread" : ""}`}>
        {active.length > 0 && active.every((a) => !a.comments_ready) && (
          <p className="cmt-banner cmt-banner--grey">Fetching the last 30 days of comments. This can take a few minutes.</p>
        )}
        {all
          .filter((a) => a.last_error)
          .map((a) => (
            <p key={a.id} className="cmt-banner cmt-banner--red" role="alert">
              Comments from {a.label} are not updating. {a.last_error}{" "}
              {can("channels.manage") && (
                <button type="button" className="btn btn--subtle btn--sm" disabled={syncing === a.id} onClick={() => void tryAgain(a.id)}>
                  {syncing === a.id ? "Trying…" : "Try again"}
                </button>
              )}
            </p>
          ))}
        <div className="cmt-filters">
          <div className="cmt-tabs" role="tablist" aria-label="Which comments to show">
            {COMMENT_TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "is-active" : ""} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="cmt-filters__right">
            <select className="input" aria-label="Account" value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">All accounts</option>
              {all.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} ({networkName(a.network)})
                </option>
              ))}
            </select>
            <input
              className="input"
              type="search"
              aria-label="Search comments"
              placeholder="Search by name or words"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="cmt-cols">
          <section className="cmt-col cmt-col--list card" aria-label="Comments">
            <DataState
              loading={threads.isLoading}
              error={threads.error}
              onRetry={() => void threads.refetch()}
              isEmpty={rows.length === 0}
              emptyTitle={empty.title}
              emptyHint={empty.text}
            >
              <ThreadList threads={rows} selectedId={threadId} onOpen={open} />
              {threads.data?.has_more && <p className="cmt-list__more">Showing the newest 50. Search or pick a tab to narrow the list.</p>}
            </DataState>
          </section>
          <section className="cmt-col cmt-col--thread card" aria-label="The open comment">
            {threadId ? (
              <ThreadView key={threadId} threadId={threadId} onBack={close} />
            ) : (
              <div className="empty cmt-pick">Choose a comment on the left to read and answer it.</div>
            )}
          </section>
        </div>
      </div>
    </Frame>
  );
}

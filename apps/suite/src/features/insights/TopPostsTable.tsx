import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DataState } from "@admin/components/DataState.js";
import { insightKeys, insightsApi } from "./insights-api.js";
import { formatFigure, postDate, postTitle, sortPosts, type PostSortKey } from "./insights-logic.js";

const NETWORKS = [
  { key: "all", label: "All" },
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
] as const;

const COLUMNS: { key: PostSortKey; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "views", label: "Views" },
  { key: "reach", label: "Reached" },
  { key: "interactions", label: "Likes and reactions" },
  { key: "comments", label: "Comments" },
  { key: "clicks", label: "Link clicks" },
];

/** Posts published in the dates picked, best first. Each row is one post's own figures; rows are never added up. */
export function TopPostsTable({ from, to }: { from: string; to: string }): JSX.Element {
  const [network, setNetwork] = useState<(typeof NETWORKS)[number]["key"]>("all");
  const [sort, setSort] = useState<{ key: PostSortKey; descending: boolean }>({ key: "views", descending: true });
  const q = useQuery({ queryKey: insightKeys.posts(from, to, network), queryFn: () => insightsApi.posts(from, to, network) });
  const rows = useMemo(() => sortPosts(q.data ?? [], sort.key, sort.descending), [q.data, sort]);
  const pick = (key: PostSortKey): void => setSort((s) => (s.key === key ? { key, descending: !s.descending } : { key, descending: true }));

  return (
    <section className="card ins-card">
      <div className="ins-card__head">
        <h2 className="t-h2">Top posts</h2>
        <div className="ibx-tabs" role="group" aria-label="Which network">
          {NETWORKS.map((n) => (
            <button key={n.key} type="button" className={`ibx-tab${network === n.key ? " is-active" : ""}`} aria-pressed={network === n.key} onClick={() => setNetwork(n.key)}>
              {n.label}
            </button>
          ))}
        </div>
      </div>
      <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {rows.length === 0 ? (
          <div className="empty">No posts in these dates.</div>
        ) : (
          <div className="table-wrap">
            <table className="table ins-posts">
              <thead>
                <tr>
                  <th>Post</th>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className={c.key === "date" ? undefined : "table__num"} aria-sort={sort.key === c.key ? (sort.descending ? "descending" : "ascending") : "none"}>
                      <button type="button" className="ins-sort" onClick={() => pick(c.key)}>
                        {c.label}
                        {sort.key === c.key ? (sort.descending ? " ▼" : " ▲") : ""}
                      </button>
                    </th>
                  ))}
                  <th>
                    <span className="sr-only">Link</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={`${p.network}:${p.subject_id}`}>
                    <td data-label="Post">
                      <span className={`ins-net ins-net--${p.network}`}>{p.network === "facebook" ? "Facebook" : "Instagram"}</span> {postTitle(p)}
                      {p.from_suite && <span className="ins-tag">Posted from the suite</span>}
                      {p.removed && <span className="ins-tag ins-tag--muted">Removed</span>}
                    </td>
                    <td data-label="Date">{postDate(p.published_at)}</td>
                    <td data-label="Views" className="table__num">{formatFigure(p.views)}</td>
                    <td data-label="Reached" className="table__num">{formatFigure(p.reach)}</td>
                    <td data-label="Likes and reactions" className="table__num">{formatFigure(p.interactions)}</td>
                    <td data-label="Comments" className="table__num">{formatFigure(p.comments)}</td>
                    <td data-label="Link clicks" className="table__num">{formatFigure(p.clicks)}</td>
                    <td data-label="">
                      {p.permalink && !p.removed ? (
                        <a href={p.permalink} target="_blank" rel="noreferrer" className="ins-link">
                          View
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataState>
      <p className="ins-fine">Each line is that post's own total so far. A dash means Meta has given no figure for it.</p>
    </section>
  );
}

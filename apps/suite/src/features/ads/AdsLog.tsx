/** Ads → Activity log (suite spec 12, 7.11): everything the suite did to the ad account, by a person or by a rule. It cannot be edited. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DataState } from "@admin/components/DataState.js";
import { humanizeError } from "@admin/lib/api.js";
import { toast } from "@admin/lib/toast.js";
import { adsApi, adsKeys, type AdLogRow } from "./ads-api.js";
import { actorLabel, dateTime, outcomeLabel, outcomeTone } from "./ads-logic.js";

export function AdsLog(): JSX.Element {
  const q = useQuery({ queryKey: adsKeys.log, queryFn: () => adsApi.log(), refetchInterval: 30_000 });
  const [more, setMore] = useState<AdLogRow[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const rows = [...(q.data?.data ?? []), ...more];
  const next = cursor === undefined ? (q.data?.next_cursor ?? null) : cursor;

  async function loadMore(): Promise<void> {
    if (!next) return;
    try {
      const page = await adsApi.log(next);
      setMore((m) => [...m, ...page.data]);
      setCursor(page.next_cursor);
    } catch (e) {
      toast.error(humanizeError(e));
    }
  }

  return (
    <section className="card ads-card">
      <DataState
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        isEmpty={rows.length === 0}
        emptyTitle="Nothing yet"
        emptyHint="Nothing has been done to the ad account from the suite yet."
      >
        <div className="ads-log">
          {rows.map((r) => (
            <div key={r.request_id} className="ads-log__row">
              <div className="ads-log__meta">
                {dateTime(r.at)} · {actorLabel(r.actor_kind, r.actor_name)}
              </div>
              <div>{r.summary}</div>
              <div>
                <span className={`ads-tag ads-tag--${outcomeTone(r.outcome)}`}>{outcomeLabel(r.outcome, r.meta_message)}</span>
              </div>
            </div>
          ))}
        </div>
        {next ? (
          <div style={{ textAlign: "center" }}>
            <button type="button" className="btn btn--subtle btn--sm" onClick={() => void loadMore()}>
              Show more
            </button>
          </div>
        ) : null}
      </DataState>
      <p className="ads-fine">This log cannot be edited or deleted.</p>
    </section>
  );
}

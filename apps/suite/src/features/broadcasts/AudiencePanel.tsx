/** Who will get it (suite spec 14, 7.9): the headline, one line per reason, and the names 50 at a time. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { groupThousands, type BroadcastAudience } from "@ms/shared";
import { broadcastKeys, broadcastsApi, failureText } from "./broadcasts-api.js";
import { audienceHeadline, estimateLine, reasonLines } from "./broadcasts-logic.js";

function People({ broadcastId, group }: { broadcastId: string; group: string }): JSX.Element {
  const [pages, setPages] = useState<(string | null)[]>([null]);
  return (
    <ul className="bc-people">
      {pages.map((cursor, i) => (
        <PeoplePage key={cursor ?? "first"} broadcastId={broadcastId} group={group} cursor={cursor} last={i === pages.length - 1} onMore={(next) => setPages((p) => [...p, next])} />
      ))}
    </ul>
  );
}

function PeoplePage({ broadcastId, group, cursor, last, onMore }: { broadcastId: string; group: string; cursor: string | null; last: boolean; onMore: (c: string) => void }): JSX.Element {
  const q = useQuery({ queryKey: [...broadcastKeys.audience(broadcastId, group), cursor], queryFn: () => broadcastsApi.audience(broadcastId, group, cursor), refetchOnWindowFocus: false });
  if (q.isLoading) return <li>Loading…</li>;
  if (q.error) return <li>{failureText(q.error)}</li>;
  return (
    <>
      {(q.data?.people ?? []).map((p) => (
        <li key={p.customer_id}>
          {p.name?.trim() || "No name"} {p.phone ? `· ${p.phone}` : ""}
        </li>
      ))}
      {last && q.data?.next_cursor && (
        <li>
          <button type="button" className="bc-link" onClick={() => onMore(q.data!.next_cursor!)}>
            Show 50 more
          </button>
        </li>
      )}
    </>
  );
}

export function AudiencePanel({ broadcastId, audience, loading, error }: { broadcastId: string; audience: BroadcastAudience | undefined; loading: boolean; error: unknown }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  if (loading) return <p className="bc-soft">Working out who will get it…</p>;
  if (error || !audience) return <p className="bc-notice bc-notice--red">{error ? failureText(error) : "We couldn't work out who will get it."}</p>;
  const lines = reasonLines(audience.counts.skipped, audience.gap_days);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <p className="bc-headline bc-num">{audienceHeadline(audience)}</p>
      <ul className="bc-reasons">
        <li className="bc-reason">
          <button type="button" aria-expanded={open === "will_send"} onClick={() => setOpen(open === "will_send" ? null : "will_send")}>
            <span>{groupThousands(audience.counts.will_send)} · Will get it</span>
            <span aria-hidden="true">{open === "will_send" ? "−" : "+"}</span>
          </button>
          {open === "will_send" && <People broadcastId={broadcastId} group="will_send" />}
        </li>
        {lines.map((l) => (
          <li className="bc-reason" key={l.reason}>
            <button type="button" aria-expanded={open === l.reason} onClick={() => setOpen(open === l.reason ? null : l.reason)}>
              <span>{l.text}</span>
              <span aria-hidden="true">{open === l.reason ? "−" : "+"}</span>
            </button>
            {open === l.reason && <People broadcastId={broadcastId} group={l.reason} />}
          </li>
        ))}
      </ul>
      <p className="bc-soft">{estimateLine(audience.estimate.per_day, Math.min(audience.estimate.days, 999))}</p>
      <p className="bc-soft">WhatsApp decides the final delivery. It may hold back a promotion from someone who has had too many lately.</p>
      <p className="bc-soft">WhatsApp charges for each message delivered. This broadcast is {groupThousands(audience.counts.will_send)} messages.</p>
    </div>
  );
}

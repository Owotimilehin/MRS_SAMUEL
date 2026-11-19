/**
 * Chats that started from an advert (suite spec 12, 7.6). This comes from our
 * own inbox, so it works with no ad account linked. A customer's name and the
 * link to their chat are shown only to staff who may see that conversation.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DataState } from "@admin/components/DataState.js";
import { ngn } from "@admin/lib/analytics-theme.js";
import { humanizeError } from "@admin/lib/api.js";
import { toast } from "@admin/lib/toast.js";
import { adsApi, adsKeys, type AdChat } from "./ads-api.js";
import { dateTime, destinationLabel, reportedLabel } from "./ads-logic.js";

export function AdChatsTable({ from, to, ad, canManage }: { from: string; to: string; ad?: string; canManage: boolean }): JSX.Element {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: adsKeys.chats(from, to, ad ?? ""), queryFn: () => adsApi.chats(from, to, ad), enabled: from <= to });
  const [more, setMore] = useState<AdChat[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = [...(q.data?.data ?? []), ...more];
  const next = cursor === undefined ? (q.data?.next_cursor ?? null) : cursor;
  const reportingOn = q.data?.reporting_on ?? false;

  async function loadMore(): Promise<void> {
    if (!next) return;
    try {
      const page = await adsApi.chats(from, to, ad, next);
      setMore((m) => [...m, ...page.data]);
      setCursor(page.next_cursor);
    } catch (e) {
      toast.error(humanizeError(e));
    }
  }

  async function setBlocked(row: AdChat, block: boolean): Promise<void> {
    setBusy(row.id);
    try {
      await adsApi.blockReporting(row.id, block);
      setMore([]);
      setCursor(undefined);
      await qc.invalidateQueries({ queryKey: ["ads", "chats"] });
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <DataState
      loading={q.isLoading}
      error={q.error}
      onRetry={() => void q.refetch()}
      isEmpty={rows.length === 0}
      emptyTitle="No chats from adverts"
      emptyHint="No chats have come from adverts in these dates."
    >
      <div className="table-wrap">
        <table className="table ibx-stack">
          <thead>
            <tr>
              <th>When</th>
              <th>Channel</th>
              <th>Advert</th>
              <th>Customer</th>
              <th>Order</th>
              <th>Reported to Meta</th>
              {canManage ? <th aria-label="Actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-label="When">{dateTime(r.touched_at)}</td>
                <td data-label="Channel">{destinationLabel(r.channel)}</td>
                <td data-label="Advert">{r.headline ?? (r.ad_external_id ? `Advert ${r.ad_external_id}` : "Advert")}</td>
                <td data-label="Customer">
                  {r.conversation_id ? (
                    <Link to="/inbox/$conversationId" params={{ conversationId: r.conversation_id }} className="ads-link">
                      {r.customer_name ?? "Customer"}
                    </Link>
                  ) : (
                    <span className="ads-sub">Not visible to you</span>
                  )}
                </td>
                <td data-label="Order">{r.order ? `${r.order.order_number} · ${ngn(r.order.value_ngn)}` : "—"}</td>
                <td data-label="Reported to Meta">
                  {r.reporting_blocked && !r.order ? "No — A staff member chose not to report this customer." : r.order ? reportedLabel(r.order.reported, r.order.reported_note, reportingOn) : ""}
                </td>
                {canManage ? (
                  <td data-label="">
                    <button type="button" className="btn btn--subtle btn--sm" disabled={busy === r.id} onClick={() => void setBlocked(r, !r.reporting_blocked)}>
                      {r.reporting_blocked ? "Allow reporting again" : "Do not report this customer to Meta"}
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next ? (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button type="button" className="btn btn--subtle btn--sm" onClick={() => void loadMore()}>
            Show more
          </button>
        </div>
      ) : null}
    </DataState>
  );
}

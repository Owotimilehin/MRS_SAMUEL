/** Ads → Adverts (suite spec 12, 7.4): one row per advert with Meta's figures beside our own. */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { money } from "@ms/shared";
import { DataState } from "@admin/components/DataState.js";
import { ngn } from "@admin/lib/analytics-theme.js";
import { adsApi, adsKeys, type AdsStatus } from "./ads-api.js";
import { dateTime, destinationLabel, statusLabel, statusTone } from "./ads-logic.js";

const DRAFT_STATE: Record<string, string> = {
  draft: "Not sent yet",
  failed: "Stopped part-way",
  needs_check: "Needs checking",
  creating: "Being created",
};

export function AdvertsTable({ from, to, status, canManage }: { from: string; to: string; status: AdsStatus; canManage: boolean }): JSX.Element {
  const q = useQuery({ queryKey: adsKeys.adverts(from, to), queryFn: () => adsApi.adverts(from, to), enabled: from <= to });
  const canCreate = canManage && status.settings.manage_enabled;
  const drafts = useQuery({ queryKey: ["ads", "drafts"], queryFn: adsApi.drafts, enabled: canCreate, retry: false });
  const currency = q.data?.currency ?? status.account?.currency ?? "NGN";
  const rows = q.data?.data ?? [];
  const unfinished = (drafts.data ?? []).filter((d) => d.status !== "created");

  return (
    <>
      {canCreate ? (
        <div className="ads-actions" style={{ justifyContent: "flex-end" }}>
          <Link to="/ads/new" className="btn btn--primary btn--sm">
            New advert
          </Link>
        </div>
      ) : null}
      {unfinished.length > 0 ? (
        <section className="card ads-card">
          <h2 className="ads-h">Adverts not finished</h2>
          {unfinished.map((d) => (
            <div key={d.id} className="ads-row">
              <div className="ads-row__text">
                <span className="ads-row__label">{d.spec.name}</span>
                <span className="ads-sub">
                  {DRAFT_STATE[d.status] ?? d.status} · last changed {dateTime(d.updated_at)}
                </span>
                {d.error_message ? <span className="ads-sub">{d.error_message}</span> : null}
              </div>
              <Link to="/ads/drafts/$draftId" params={{ draftId: d.id }} className="btn btn--subtle btn--sm">
                Open
              </Link>
            </div>
          ))}
        </section>
      ) : null}
      <section className="card ads-card">
        <DataState
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          isEmpty={rows.length === 0}
          emptyTitle="No adverts"
          emptyHint="No adverts in these dates."
        >
          <div className="table-wrap">
            <table className="table ibx-stack">
              <thead>
                <tr>
                  <th>Advert</th>
                  <th>Opens</th>
                  <th>State</th>
                  <th className="table__num">Spent</th>
                  <th className="table__num">Shown</th>
                  <th className="table__num">Taps</th>
                  <th className="table__num">Chats (Meta)</th>
                  <th className="table__num">Chats we saw</th>
                  <th className="table__num">Cost per chat</th>
                  <th className="table__num">Orders</th>
                  <th className="table__num">Sales</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ad_external_id}>
                    <td data-label="Advert">
                      <Link to="/ads/adverts/$adId" params={{ adId: r.ad_external_id }} className="ads-link ads-name">
                        {r.name ?? `Advert ${r.ad_external_id}`}
                      </Link>
                      <div className="ads-sub">{r.campaign_name ?? ""}</div>
                      {r.created_by_suite ? <span className="ads-tag ads-tag--suite">Made in the suite</span> : null}
                    </td>
                    <td data-label="Opens">{destinationLabel(r.destination)}</td>
                    <td data-label="State">
                      <span className={`ads-tag ads-tag--${statusTone(r.effective_status)}`}>{statusLabel(r.effective_status)}</span>
                    </td>
                    <td className="table__num" data-label="Spent">{money(r.spend, currency)}</td>
                    <td className="table__num" data-label="Shown">{r.impressions.toLocaleString("en-NG")}</td>
                    <td className="table__num" data-label="Taps">{r.clicks.toLocaleString("en-NG")}</td>
                    <td className="table__num" data-label="Chats (Meta)">{r.conversations_started}</td>
                    <td className="table__num" data-label="Chats we saw">{r.chats_seen}</td>
                    <td className="table__num" data-label="Cost per chat">{r.cost_per_conversation === null ? "—" : money(Math.round(r.cost_per_conversation), currency)}</td>
                    <td className="table__num" data-label="Orders">{r.orders}</td>
                    <td className="table__num" data-label="Sales">{ngn(r.order_value_ngn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataState>
        <p className="ads-fine">
          &apos;Chats (Meta)&apos; is Meta&apos;s count of chats started within 7 days of a tap. &apos;Chats we saw&apos; is how many first messages reached our
          inbox marked as coming from this advert. The two are counted differently and will not always match.
        </p>
      </section>
    </>
  );
}

/**
 * Leads report (suite spec 13, 7.5): how many leads each form and advert
 * brought, how fast we answered, and how many we won. Plain CSS bars.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DataState } from "@admin/components/DataState.js";
import { Modal } from "@admin/components/Modal.js";
import { leadKeys, leadsApi, type ReportRow } from "./leads-api.js";
import { barHeights, lagosDayAgo, minutesText, winRateText } from "./leads-logic.js";

export function LeadsReport({ onClose }: { onClose: () => void }): JSX.Element {
  const [from, setFrom] = useState(() => lagosDayAgo(29));
  const [to, setTo] = useState(() => lagosDayAgo(0));
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const q = useQuery({ queryKey: leadKeys.report(from, to), queryFn: () => leadsApi.report(from, to), enabled: valid });
  const r = q.data;
  const bars = barHeights(r?.by_day ?? []);

  return (
    <Modal title="Leads report" onClose={onClose} maxWidth={860}>
      <div style={{ display: "grid", gap: 14 }}>
        <div className="ld-dates">
          <label className="field" style={{ margin: 0 }}>
            <span className="field__label">From</span>
            <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span className="field__label">To</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        {!valid ? (
          <div className="empty">Choose a start date that is not after the end date.</div>
        ) : (
          <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
            {r && r.totals.leads === 0 ? (
              <div className="empty">No leads in these dates.</div>
            ) : r ? (
              <>
                <div className="ld-tiles">
                  <Tile label="Leads" value={String(r.totals.leads)} />
                  <Tile label="Contacted" value={String(r.totals.contacted)} />
                  <Tile label="Won" value={String(r.totals.won)} />
                  <Tile label="Lost" value={String(r.totals.lost)} />
                  <Tile label="Win rate" value={winRateText(r.totals.win_rate)} />
                  <Tile label="Typical time to first contact" value={minutesText(r.totals.median_minutes_to_first_contact)} />
                </div>

                <section className="ld-section">
                  <div className="t-eyebrow">Leads per day</div>
                  <div className="ld-bars" role="img" aria-label="Leads per day">
                    {bars.map((b) => (
                      <div key={b.day} className="ld-bar" style={{ height: `${b.pct}%` }} title={`${b.day}: ${b.leads}`} />
                    ))}
                  </div>
                  {bars.length > 0 && (
                    <div className="ld-bars__axis">
                      <span>{bars[0]!.day}</span>
                      <span>{bars[bars.length - 1]!.day}</span>
                    </div>
                  )}
                </section>

                <ReportTable title="By form" first="Form" rows={r.by_form.map((f) => ({ key: f.form_id, name: f.form_name, ...f }))} />
                <ReportTable
                  title="By advert"
                  first="Advert"
                  empty="None of these leads came from an advert we can name."
                  rows={r.by_ad.map((a) => ({
                    key: a.ad_id,
                    name: [a.ad_name ?? `Advert ${a.ad_id}`, a.campaign_name].filter(Boolean).join(" · "),
                    ...a,
                  }))}
                />
              </>
            ) : null}
          </DataState>
        )}
        <p className="ld-fine">Test leads are left out. Advert spend is on the Ads page.</p>
      </div>
    </Modal>
  );
}

function Tile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="ld-tile">
      <div className="ld-tile__label">{label}</div>
      <div className="ld-tile__value">{value}</div>
    </div>
  );
}

function ReportTable({
  title,
  first,
  rows,
  empty,
}: {
  title: string;
  first: string;
  rows: (ReportRow & { key: string; name: string })[];
  empty?: string;
}): JSX.Element {
  return (
    <section className="ld-section">
      <div className="t-eyebrow">{title}</div>
      {rows.length === 0 ? (
        <div className="ld-fine">{empty ?? "Nothing to show."}</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{first}</th>
                <th className="table__num">Leads</th>
                <th className="table__num">Contacted</th>
                <th className="table__num">Won</th>
                <th className="table__num">Lost</th>
                <th className="table__num">Win rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.key}>
                  <td style={{ overflowWrap: "anywhere" }}>{x.name}</td>
                  <td className="table__num">{x.leads}</td>
                  <td className="table__num">{x.contacted}</td>
                  <td className="table__num">{x.won}</td>
                  <td className="table__num">{x.lost}</td>
                  <td className="table__num">{winRateText(x.win_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

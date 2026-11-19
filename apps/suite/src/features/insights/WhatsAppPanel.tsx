/**
 * The WhatsApp parts of the Insights screen (suite spec 11, section 7.1 items 5 and 7):
 * the messages chart, charges by type of message, how each template did, the owner's
 * "turn on template figures" dialog, and the suite's own counts beside (never added to) Meta's.
 */
import { useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { DataState } from "@admin/components/DataState.js";
import { Modal } from "@admin/components/Modal.js";
import { SERIES_COLORS } from "@admin/lib/analytics-theme.js";
import { inboxApi, inboxKeys } from "@admin/lib/inbox-api.js";
import { settingsApi } from "@admin/lib/inbox-settings-api.js";
import { fillDays } from "@admin/lib/inbox-logic.js";
import { toast } from "@admin/lib/toast.js";
import { insightKeys, insightsApi, type WhatsAppFigures } from "./insights-api.js";
import { FIXED, categoryLabel, formatFigure, pricingTypeLabel, rateText, zoneNote } from "./insights-logic.js";
import { ChartCard, DayChart, type ChartRow, type ChartSeries } from "./TrendChart.js";

const useWhatsApp = (from: string, to: string) => useQuery({ queryKey: insightKeys.whatsapp(from, to), queryFn: () => insightsApi.whatsapp(from, to) });

const WA_SERIES: ChartSeries[] = [
  { key: "template", name: "Templates", color: SERIES_COLORS[0]!, as: "bar", stack: "sent" },
  { key: "free_form", name: "Ordinary replies", color: SERIES_COLORS[2]!, as: "bar", stack: "sent" },
  { key: "delivered", name: "Delivered", color: SERIES_COLORS[1]!, as: "line" },
];

/** Stacked bars of what was sent, by type, with a line for what was delivered. One source, one axis. */
export function WhatsAppMessagesChart({ from, to }: { from: string; to: string }): JSX.Element {
  const q = useWhatsApp(from, to);
  const rows: ChartRow[] = (q.data?.by_type ?? []).map((d) => ({ day: d.day, template: d.template, free_form: d.free_form, delivered: d.delivered }));
  const empty = rows.every((r) => r.template === null && r.free_form === null && r.delivered === null);
  return (
    <ChartCard title="WhatsApp messages" note={[empty && q.data ? "No figures from WhatsApp for these dates yet." : "", zoneNote(q.data?.day_zone ?? "UTC")].filter(Boolean).join(" ")}>
      <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        <DayChart rows={rows} series={WA_SERIES} network="WhatsApp" />
      </DataState>
    </ChartCard>
  );
}

const INBOX_SERIES: ChartSeries[] = [
  { key: "inbound", name: "Customers wrote", color: SERIES_COLORS[0]!, as: "bar" },
  { key: "outbound", name: "We replied", color: SERIES_COLORS[2]!, as: "bar" },
];

/** The suite's own message counts (from /v1/inbox/reports). Shown only to people with inbox.reports. */
export function InboxMessagesChart({ from, to }: { from: string; to: string }): JSX.Element {
  const q = useQuery({ queryKey: ["inbox", "report", from, to, ""], queryFn: () => settingsApi.report({ from, to }) });
  // The suite counts every day itself, so a day with no messages here really is zero.
  const rows: ChartRow[] = q.data ? fillDays(from, to, q.data.messages_per_day, ["inbound", "outbound"] as const).map((d) => ({ ...d })) : [];
  return (
    <ChartCard title="From our inbox" note={`${FIXED.inboxChart} Days are Lagos days.`}>
      <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        <DayChart rows={rows} series={INBOX_SERIES} network="the inbox" />
      </DataState>
    </ChartCard>
  );
}

/** "Customers wrote: n · We replied: n" for the WhatsApp numbers the viewer can see. */
function InboxWhatsAppRow({ from, to }: { from: string; to: string }): JSX.Element | null {
  const me = useQuery({ queryKey: inboxKeys.me, queryFn: inboxApi.me, staleTime: 60_000 });
  const numbers = (me.data?.numbers ?? []).filter((n) => (n.kind ?? "phone") === "phone" && n.channels !== "voice");
  const reports = useQueries({
    queries: numbers.map((n) => ({
      queryKey: ["inbox", "report", from, to, n.id],
      queryFn: () => settingsApi.report({ from, to, number: n.id }),
    })),
  });
  if (me.isLoading || reports.some((r) => r.isLoading)) return <p className="ins-fine">Counting our own inbox messages…</p>;
  // If any number's count could not be read, say nothing rather than a total that is too low.
  if (me.error || numbers.length === 0 || reports.some((r) => !r.data)) return null;
  let wrote = 0;
  let replied = 0;
  for (const r of reports) for (const d of r.data!.messages_per_day) {
    wrote += d.inbound;
    replied += d.outbound;
  }
  return (
    <div className="ins-ours">
      <div>
        <strong>From our inbox.</strong> Customers wrote: {formatFigure(wrote)} · We replied: {formatFigure(replied)}
      </div>
      <p className="ins-fine">{FIXED.inboxRow}</p>
    </div>
  );
}

/** The owner's permanent switch. Nothing is sent until the box is ticked and "Turn on" is pressed. */
function TurnOnDialog({ wabaId, onClose, onDone }: { wabaId: string; onClose: () => void; onDone: () => void }): JSX.Element {
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function turnOn(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await insightsApi.enableTemplateFigures(wabaId);
      toast.success("Template figures are on. They will appear after the next update.");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Turn on template figures" onClose={busy ? () => undefined : onClose} maxWidth={520}>
      <p>
        This asks WhatsApp to start counting how many people receive, read and tap each template. <strong>It cannot be turned off again.</strong> WhatsApp will
        also track taps on links in your templates and use anonymous chat data to improve its service.
      </p>
      <label className="ins-check">
        <input type="checkbox" checked={understood} disabled={busy} onChange={(e) => setUnderstood(e.target.checked)} />
        <span>I understand this cannot be undone.</span>
      </label>
      {error && (
        <div className="ins-notice ins-notice--bad" role="alert">
          {error}
        </div>
      )}
      <div className="ins-dialog__foot">
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Not now
        </button>
        <button type="button" className="btn btn--danger" onClick={() => void turnOn()} disabled={busy || !understood}>
          {busy ? "Turning on…" : "Turn on"}
        </button>
      </div>
    </Modal>
  );
}

function Charges({ data }: { data: WhatsAppFigures }): JSX.Element {
  return (
    <div>
      <h3 className="ins-h3">Charges by type of message</h3>
      {data.pricing.length === 0 ? (
        <div className="empty">No charges reported by WhatsApp for these dates.</div>
      ) : (
        <div className="table-wrap">
          <table className="table ins-cards">
            <thead>
              <tr>
                <th>Category</th>
                <th>Type</th>
                <th className="table__num">Messages</th>
                <th className="table__num">Charge</th>
              </tr>
            </thead>
            <tbody>
              {data.pricing.map((p) => (
                <tr key={`${p.category}|${p.type}`}>
                  <td data-label="Category">{categoryLabel(p.category)}</td>
                  <td data-label="Type">{pricingTypeLabel(p.type)}</td>
                  <td data-label="Messages" className="table__num">{formatFigure(p.volume)}</td>
                  <td data-label="Charge" className="table__num">{formatFigure(p.cost, { money: true, currency: data.cost_currency })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="ins-fine">{FIXED.charges}</p>
    </div>
  );
}

function Templates({ data, isOwner, onTurnOn }: { data: WhatsAppFigures; isOwner: boolean; onTurnOn: () => void }): JSX.Element {
  const off = data.template_analytics !== "on";
  const canTurnOn = isOwner && data.accounts.some((a) => a.template_analytics === "off");
  return (
    <div>
      <h3 className="ins-h3">How each template did</h3>
      {off && (
        <div className="ins-notice">
          {FIXED.templatesOff}{" "}
          {canTurnOn ? (
            <button type="button" className="btn btn--subtle btn--sm" onClick={onTurnOn}>
              Turn on template figures…
            </button>
          ) : isOwner ? null : (
            "The owner can turn them on."
          )}
        </div>
      )}
      {data.templates.length === 0 ? (
        !off && <div className="empty">No template figures for these dates. WhatsApp keeps them for 90 days.</div>
      ) : (
        <div className="table-wrap">
          <table className="table ins-cards">
            <thead>
              <tr>
                <th>Template</th>
                <th className="table__num">Sent</th>
                <th className="table__num">Delivered</th>
                <th className="table__num">Read</th>
                <th className="table__num">Read rate</th>
                <th className="table__num">Button taps</th>
              </tr>
            </thead>
            <tbody>
              {data.templates.map((t) => (
                <tr key={t.template_id}>
                  <td data-label="Template">{t.name}</td>
                  <td data-label="Sent" className="table__num">{formatFigure(t.sent)}</td>
                  <td data-label="Delivered" className="table__num">{formatFigure(t.delivered)}</td>
                  <td data-label="Read" className="table__num">{formatFigure(t.read)}</td>
                  <td data-label="Read rate" className="table__num">{rateText(t.read_rate)}</td>
                  <td data-label="Button taps" className="table__num">{formatFigure(t.clicked)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function WhatsAppPanel({ from, to, isOwner, showInbox }: { from: string; to: string; isOwner: boolean; showInbox: boolean }): JSX.Element {
  const qc = useQueryClient();
  const q = useWhatsApp(from, to);
  const [asking, setAsking] = useState(false);
  const firstOff = q.data?.accounts.find((a) => a.template_analytics === "off")?.waba_id ?? null;
  return (
    <section className="card ins-card">
      <div className="ins-card__head">
        <h2 className="t-h2">WhatsApp</h2>
      </div>
      <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {q.data && (
          <div className="ins-wa">
            <Charges data={q.data} />
            <Templates data={q.data} isOwner={isOwner} onTurnOn={() => setAsking(true)} />
            {showInbox && <InboxWhatsAppRow from={from} to={to} />}
          </div>
        )}
      </DataState>
      {asking && firstOff && (
        <TurnOnDialog
          wabaId={firstOff}
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            void qc.invalidateQueries({ queryKey: insightKeys.all });
          }}
        />
      )}
    </section>
  );
}

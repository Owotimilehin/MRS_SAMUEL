/**
 * Calls (22 Nov 2026): calls have their own section, separate from the Inbox.
 * Three tabs: To call back (missed calls nobody has returned), Call log (every call),
 * Metrics (answer rate, time to answer, returns, busiest times, per staff).
 * Built to docs/design/business-suite-ui-spec.md.
 */
import { Fragment, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChevronDown, ChevronRight, Clock, Phone, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Timer, Undo2 } from "lucide-react";
import { toE164 } from "@ms/shared";
import { DataState } from "@admin/components/DataState.js";
import { RecordingBlock } from "@admin/components/inbox/Timeline.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { COLOR_AXIS, COLOR_GRID, shortDate } from "@admin/lib/analytics-theme.js";
import { contactName, listTime, prettyPhone } from "@admin/lib/inbox-logic.js";
import { startCall, useVoice } from "@admin/lib/inbox-voice.js";
import "@admin/components/inbox/inbox.css";
import { callKeys, callsApi, type CallFilters, type CallRow } from "./calls-api.js";
import {
  PERIODS,
  WEEKDAYS,
  heatHours,
  heatLevel,
  hourLabel,
  outcomeText,
  percent,
  periodRange,
  shortDuration,
  talkTime,
  waitingFor,
  type CallPeriod,
} from "./calls-logic.js";
import "./calls.css";

type Tab = "callback" | "log" | "metrics";

/** ?customer=<id> (from "Calls with this customer" in the Inbox) opens the log for that customer. */
function customerFromAddress(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const id = new URLSearchParams(window.location.search).get("customer");
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
}

export function CallsPage(): JSX.Element {
  const can = useCan();
  const [customer, setCustomer] = useState<string | undefined>(customerFromAddress);
  const [tab, setTab] = useState<Tab>(customer ? "log" : "callback");
  const [period, setPeriod] = useState<CallPeriod>("7");
  const callbacks = useQuery({ queryKey: callKeys.callbacks, queryFn: callsApi.callbacks, refetchInterval: 60_000 });
  const waiting = callbacks.data?.count ?? 0;

  const tabs: { key: Tab; label: string }[] = [
    { key: "callback", label: waiting ? `To call back (${waiting})` : "To call back" },
    { key: "log", label: "Call log" },
    ...(can("inbox.reports") ? [{ key: "metrics" as const, label: "Metrics" }] : []),
  ];

  return (
    <Frame
      title="Calls"
      actions={
        tab === "callback" ? undefined : (
          <div className="ibx-tabs" role="tablist" aria-label="Period">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                type="button"
                role="tab"
                aria-selected={period === p.key}
                className={`ibx-tab${period === p.key ? " is-active" : ""}`}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
        )
      }
    >
      <div className="cl-page">
        <div className="ibx-tabs" role="tablist" aria-label="Calls">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`ibx-tab${tab === t.key ? " is-active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "callback" && <CallBackTab />}
        {tab === "log" && <CallLogTab period={period} customer={customer} onClearCustomer={() => setCustomer(undefined)} />}
        {tab === "metrics" && <MetricsTab period={period} />}
      </div>
    </Frame>
  );
}

// ── To call back ────────────────────────────────────────────────────────────

function CallBackTab(): JSX.Element {
  const can = useCan();
  const q = useQuery({ queryKey: callKeys.callbacks, queryFn: callsApi.callbacks, refetchInterval: 60_000 });
  const rows = q.data?.data ?? [];
  return (
    <div className="card cl-card">
      <div className="cl-card__head">
        <div>
          <h3>Missed calls waiting for a call back</h3>
          <p className="cl-sub">
            Customers who called in the last {q.data?.window_days ?? 14} days and haven't been returned yet, longest waiting
            first. Calling them back, or them getting through on a later call, takes them off this list.
          </p>
        </div>
      </div>
      <DataState
        loading={q.isLoading}
        error={q.error}
        isEmpty={rows.length === 0}
        emptyTitle="Everyone has been called back"
        emptyHint="Missed calls and voicemails will wait here until someone returns them."
        onRetry={() => void q.refetch()}
      >
        <div className="table-wrap cl-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Last tried</th>
                <th className="table__num">Tries</th>
                <th>Result</th>
                <th>What they want</th>
                <th>
                  <span className="sr-only">Call back</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const summary = r.recordings.find((rec) => rec.summary)?.summary;
                const o = outcomeText(r.outcome, r.direction);
                return (
                  <tr key={r.id}>
                    <td>
                      <Who row={r} />
                    </td>
                    <td>
                      <b className={`cl-wait${ageHours(r.started_at) >= 2 ? " is-late" : ""}`}>{waitingFor(r.started_at)}</b>
                      <small className="cl-meta">{listTime(r.started_at)} · {r.line}</small>
                    </td>
                    <td className="table__num">{r.attempts}</td>
                    <td>
                      <span className={`pill pill--${o.tone}`}>{o.label}</span>
                      {r.followup_sent_at && <small className="cl-meta">WhatsApp follow-up sent</small>}
                    </td>
                    <td className="cl-reason">
                      {summary ? (
                        <>
                          <b>{summary.call_reason}</b>
                          <small className="cl-meta">{summary.summary}</small>
                        </>
                      ) : (
                        <span className="cl-meta">No voicemail left</span>
                      )}
                    </td>
                    <td className="table__num">{can("calls.outbound") && <CallBackButton row={r} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </DataState>
    </div>
  );
}

function ageHours(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

function CallBackButton({ row }: { row: CallRow }): JSX.Element {
  const onCall = useVoice((s) => s.active !== null);
  const to = toE164(row.customer.phone) ?? (row.direction === "in" ? row.from_e164 : row.to_e164);
  const who = contactName(row.customer.name, row.customer.phone, null);
  return (
    <button
      type="button"
      className="btn btn--sm btn--primary"
      disabled={onCall}
      title={onCall ? "Finish your current call first" : `Call ${who}`}
      onClick={() => void startCall({ to, numberId: row.phone_number_id, who })}
    >
      <PhoneCall size={15} /> Call back
    </button>
  );
}

// ── Call log ────────────────────────────────────────────────────────────────

type DirFilter = "all" | "in" | "out";

function CallLogTab({
  period,
  customer,
  onClearCustomer,
}: {
  period: CallPeriod;
  customer: string | undefined;
  onClearCustomer: () => void;
}): JSX.Element {
  const can = useCan();
  const qc = useQueryClient();
  const [dir, setDir] = useState<DirFilter>("all");
  const [outcome, setOutcome] = useState<string>("");
  const [open, setOpen] = useState<string | null>(null);
  const range = periodRange(period);
  // A customer's history is shown in full, not cut to the period.
  const filters: CallFilters = {
    ...(customer ? {} : range),
    ...(dir !== "all" ? { direction: dir } : {}),
    ...(outcome ? { outcome } : {}),
    ...(customer ? { customer } : {}),
  };
  const q = useInfiniteQuery({
    queryKey: callKeys.list(filters),
    queryFn: ({ pageParam }) => callsApi.list(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  const customerName = customer && rows[0] ? contactName(rows[0].customer.name, rows[0].customer.phone, null) : null;

  return (
    <div className="card cl-card">
      <div className="cl-card__head">
        <div>
          <h3>{customer ? `Calls with ${customerName ?? "this customer"}` : "Every call"}</h3>
          <p className="cl-sub">
            {customer ? (
              <>
                All of this customer's calls.{" "}
                <button type="button" className="cl-link" onClick={onClearCustomer}>
                  Show everyone's calls
                </button>
              </>
            ) : (
              "Newest first. Open a call to hear the recording or read the voicemail."
            )}
          </p>
        </div>
        <div className="cl-filters">
          <div className="ibx-tabs" role="tablist" aria-label="Direction">
            {(
              [
                ["all", "All"],
                ["in", "Incoming"],
                ["out", "Outgoing"],
              ] as [DirFilter, string][]
            ).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={dir === k} className={`ibx-tab${dir === k ? " is-active" : ""}`} onClick={() => setDir(k)}>
                {label}
              </button>
            ))}
          </div>
          <select className="select cl-select" value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Result">
            <option value="">Any result</option>
            <option value="answered">Answered</option>
            <option value="missed">Missed</option>
            <option value="voicemail">Voicemail</option>
            <option value="after_hours">After hours</option>
            <option value="information">Heard a message</option>
            <option value="failed">Failed</option>
          </select>
        </div>
      </div>
      <DataState
        loading={q.isLoading}
        error={q.error}
        isEmpty={rows.length === 0}
        emptyTitle="No calls here"
        emptyHint="Try a longer period, or another filter."
        onRetry={() => void q.refetch()}
      >
        <div className="table-wrap cl-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>
                  <span className="sr-only">Open</span>
                </th>
                <th>When</th>
                <th>Customer</th>
                <th>Call</th>
                <th>Result</th>
                <th>Who</th>
                <th className="table__num">Wait</th>
                <th className="table__num">Length</th>
                <th>Returned</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const o = outcomeText(r.outcome, r.direction);
                const missedIn = r.direction === "in" && ["missed", "voicemail", "after_hours", "failed"].includes(r.outcome);
                const isOpen = open === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr className="is-clickable" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
                      <td className="cl-chev">{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
                      <td>
                        <b>{listTime(r.started_at)}</b>
                        <small className="cl-meta">{timeOnly(r.started_at)}</small>
                      </td>
                      <td>
                        <Who row={r} />
                      </td>
                      <td>
                        <span className="cl-dir">
                          {r.direction === "in" ? (missedIn ? <PhoneMissed size={15} /> : <PhoneIncoming size={15} />) : <PhoneOutgoing size={15} />}
                          {r.direction === "in" ? "Incoming" : "Outgoing"}
                        </span>
                        <small className="cl-meta">
                          {r.line}
                          {r.ivr_choice ? ` · pressed ${r.ivr_choice}` : ""}
                        </small>
                      </td>
                      <td>
                        <span className={`pill pill--${o.tone}`}>{o.label}</span>
                      </td>
                      <td>{r.answered_by ?? <span className="cl-meta">—</span>}</td>
                      <td className="table__num">{shortDuration(r.wait_s)}</td>
                      <td className="table__num">{shortDuration(r.duration_s)}</td>
                      <td>
                        {missedIn ? (
                          r.returned_at ? (
                            <span className="cl-returned">
                              <Undo2 size={14} /> after {shortDuration((new Date(r.returned_at).getTime() - new Date(r.started_at).getTime()) / 1000)}
                            </span>
                          ) : (
                            <span className="cl-notyet">Not yet</span>
                          )
                        ) : (
                          <span className="cl-meta">—</span>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="cl-detail">
                        <td />
                        <td colSpan={8}>
                          {r.recordings.length === 0 ? (
                            <span className="cl-meta">No recording or voicemail for this call.</span>
                          ) : (
                            r.recordings.map((rec) => (
                              <RecordingBlock
                                key={rec.id}
                                rec={rec}
                                canDownload={can("recordings.download")}
                                canDelete={can("recordings.delete")}
                                onChanged={() => void qc.invalidateQueries({ queryKey: callKeys.all })}
                              />
                            ))
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {q.hasNextPage && (
          <div className="cl-more">
            <button type="button" className="btn btn--sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {q.isFetchingNextPage ? "Loading…" : "Show older calls"}
            </button>
          </div>
        )}
      </DataState>
    </div>
  );
}

function timeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit" });
}

/** Customer cell: initials avatar, name, phone. */
function Who({ row }: { row: CallRow }): JSX.Element {
  const name = contactName(row.customer.name, row.customer.phone, null);
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter((ch) => ch && /[a-z]/i.test(ch))
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="cl-who">
      <span className="cl-avatar" aria-hidden="true">
        {initials || <Phone size={13} />}
      </span>
      <span>
        <b>{name}</b>
        <small className="cl-meta">{prettyPhone(row.customer.phone ?? (row.direction === "in" ? row.from_e164 : row.to_e164))}</small>
      </span>
    </span>
  );
}

// ── Metrics ─────────────────────────────────────────────────────────────────

function MetricsTab({ period }: { period: CallPeriod }): JSX.Element {
  const { from, to } = periodRange(period);
  const q = useQuery({ queryKey: callKeys.metrics(from, to), queryFn: () => callsApi.metrics(from, to) });
  const m = q.data;
  const t = m?.totals;
  // Calls where the menu only played a message are neither answered nor missed.
  const reachable = t ? t.inbound - t.information : 0;
  const maxHeat = Math.max(0, ...(m?.heat ?? []).map((c) => c.calls));
  const hours = heatHours(m?.heat ?? []);
  const heatAt = (dow: number, hour: number) => m?.heat.find((c) => c.dow === dow && c.hour === hour);

  return (
    <DataState loading={q.isLoading} error={q.error} isEmpty={!t || t.total === 0} emptyTitle="No calls in this period" emptyHint="Pick a longer period." onRetry={() => void q.refetch()}>
      {m && t && (
        <div className="cl-metrics">
          <div className="cl-kpis">
            <Kpi
              icon={<PhoneIncoming size={15} />}
              tone="green"
              label="Answer rate"
              value={percent(t.answered_in, reachable)}
              foot={`${t.answered_in} of ${reachable} incoming calls answered`}
            />
            <Kpi
              icon={<Timer size={15} />}
              tone="accent"
              label="Time to answer"
              value={shortDuration(t.avg_wait_s)}
              foot="Average ring time before someone picked up"
            />
            <Kpi
              icon={<Undo2 size={15} />}
              tone={t.missed_in && t.returned < t.missed_in ? "amber" : "green"}
              label="Missed calls returned"
              value={percent(t.returned, t.missed_in)}
              chip={t.missed_in - t.returned > 0 ? `${t.missed_in - t.returned} not returned` : undefined}
              foot={
                t.missed_in
                  ? `${t.returned} of ${t.missed_in} missed${t.median_return_s != null ? ` · usually within ${shortDuration(t.median_return_s)}` : ""}`
                  : "No missed calls"
              }
            />
            <Kpi
              icon={<Clock size={15} />}
              tone="pink"
              label="Talk time"
              value={talkTime(t.talk_s)}
              foot={`Average call ${shortDuration(t.avg_duration_s)}`}
            />
          </div>

          <div className="cl-row">
            <div className="card cl-card">
              <div className="cl-card__head">
                <div>
                  <h3>Calls per day</h3>
                  <p className="cl-sub">
                    {t.inbound} incoming · {t.outbound} outgoing
                  </p>
                </div>
              </div>
              <div className="cl-legend">
                <span><i style={{ background: "#1f7a44" }} /> Answered</span>
                <span><i style={{ background: "#e8536a" }} /> Missed</span>
                <span><i style={{ background: "#e85d1c" }} /> Outgoing</span>
              </div>
              <div className="cl-chart">
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={m.per_day} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid stroke={COLOR_GRID} strokeDasharray="3 4" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={shortDate} tick={{ fontSize: 11, fill: COLOR_AXIS }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: COLOR_AXIS }} axisLine={false} tickLine={false} />
                    <Tooltip labelFormatter={(d) => shortDate(String(d))} />
                    <Bar dataKey="answered" name="Answered" stackId="in" fill="#1f7a44" isAnimationActive={false} maxBarSize={28} />
                    <Bar dataKey="missed" name="Missed" stackId="in" fill="#e8536a" radius={[5, 5, 0, 0]} isAnimationActive={false} maxBarSize={28} />
                    <Line dataKey="outbound" name="Outgoing" stroke="#e85d1c" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="card cl-card">
              <div className="cl-card__head">
                <div>
                  <h3>Busiest times</h3>
                  <p className="cl-sub">Incoming calls by day and hour, Lagos time. Darker = more calls.</p>
                </div>
              </div>
              <div className="cl-heat" style={{ gridTemplateColumns: `34px repeat(${hours.length}, 1fr)` }}>
                <span />
                {hours.map((h) => (
                  <span key={h} className="cl-heat__h">
                    {h % 3 === 0 ? hourLabel(h) : ""}
                  </span>
                ))}
                {WEEKDAYS.map((d) => (
                  <Fragment key={d.dow}>
                    <span className="cl-heat__d">{d.label}</span>
                    {hours.map((h) => {
                      const c = heatAt(d.dow, h);
                      const lvl = heatLevel(c?.calls ?? 0, maxHeat);
                      return (
                        <span
                          key={h}
                          className="cl-heat__c"
                          style={{ background: lvl ? `rgba(232, 93, 28, ${lvl})` : undefined }}
                          title={`${d.label} ${hourLabel(h)}: ${c?.calls ?? 0} calls${c?.missed ? `, ${c.missed} missed` : ""}`}
                        />
                      );
                    })}
                  </Fragment>
                ))}
              </div>
            </div>
          </div>

          <div className="cl-row cl-row--3">
            <div className="card cl-card">
              <div className="cl-card__head">
                <div>
                  <h3>By staff</h3>
                  <p className="cl-sub">Calls answered and made</p>
                </div>
              </div>
              {m.staff.length === 0 ? (
                <p className="cl-pad cl-meta">No one has answered or made a call in this period.</p>
              ) : (
                <div className="table-wrap cl-table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Staff</th>
                        <th className="table__num">Answered</th>
                        <th className="table__num">Made</th>
                        <th className="table__num">Talk time</th>
                        <th className="table__num">Time to answer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.staff.map((s) => (
                        <tr key={s.user_id}>
                          <td>{s.name}</td>
                          <td className="table__num">{s.answered}</td>
                          <td className="table__num">{s.made}</td>
                          <td className="table__num">{talkTime(s.talk_s)}</td>
                          <td className="table__num">{shortDuration(s.avg_wait_s)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card cl-card">
              <div className="cl-card__head">
                <div>
                  <h3>How calls ended</h3>
                  <p className="cl-sub">Incoming calls</p>
                </div>
              </div>
              <div className="cl-bars">
                {(
                  [
                    ["Answered", t.answered_in, "#1f7a44"],
                    ["Missed", t.missed_in - t.voicemail - t.after_hours, "#e8536a"],
                    ["Voicemail", t.voicemail, "#c98a12"],
                    ["After hours", t.after_hours, "#9a8d7f"],
                    ["Heard a message", t.information, "#e85d1c"],
                  ] as [string, number, string][]
                ).map(([label, n, c]) => (
                  <div key={label}>
                    <div className="cl-bars__t">
                      <span>{label}</span>
                      <b>{n}</b>
                    </div>
                    <div className="cl-bar">
                      <i style={{ width: `${t.inbound ? (n / t.inbound) * 100 : 0}%`, background: c }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card cl-card">
              <div className="cl-card__head">
                <div>
                  <h3>Phone menu choices</h3>
                  <p className="cl-sub">What callers pressed</p>
                </div>
              </div>
              {m.menu.length === 0 ? (
                <p className="cl-pad cl-meta">No menu choices in this period.</p>
              ) : (
                <div className="cl-bars">
                  {m.menu.map((x) => (
                    <div key={x.choice ?? "none"}>
                      <div className="cl-bars__t">
                        <span>Pressed {x.choice}</span>
                        <b>{x.calls}</b>
                      </div>
                      <div className="cl-bar">
                        <i style={{ width: `${(x.calls / Math.max(...m.menu.map((y) => y.calls))) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <p className="cl-defs">
            <b>Missed</b>: {m.definitions.missed} <b>Returned</b>: {m.definitions.returned}
          </p>
        </div>
      )}
    </DataState>
  );
}

function Kpi({
  icon,
  tone,
  label,
  value,
  foot,
  chip,
}: {
  icon: JSX.Element;
  tone: "green" | "accent" | "amber" | "pink";
  label: string;
  value: string;
  foot: string;
  chip?: string | undefined;
}): JSX.Element {
  return (
    <div className="card cl-kpi">
      <div className="cl-kpi__lbl">
        <span className={`cl-kpi__ic cl-kpi__ic--${tone}`}>{icon}</span>
        {label}
        {chip && <span className="cl-chip">{chip}</span>}
      </div>
      <div className="cl-kpi__val tabular-nums">{value}</div>
      <div className="cl-kpi__foot">{foot}</div>
    </div>
  );
}

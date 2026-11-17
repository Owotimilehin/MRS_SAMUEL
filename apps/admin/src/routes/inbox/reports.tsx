import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { Download } from "lucide-react";
import { Shell } from "../../components/Shell.js";
import { StatHero } from "../../components/StatHero.js";
import { Stat } from "../../components/Stat.js";
import { DataState } from "../../components/DataState.js";
import "../../components/inbox/inbox.css";
import { useCan } from "../../lib/auth.js";
import { CONTACTS_CSV_URL, inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import { settingsApi } from "../../lib/inbox-settings-api.js";
import { axisDays, fillDays, formatDuration, formatSpan, lagosDaysAgo, staffLabel } from "../../lib/inbox-logic.js";
import { COLOR_AXIS, COLOR_GRID, SERIES_COLORS, shortDate } from "../../lib/analytics-theme.js";

const tooltipStyle = {
  background: "rgba(255,255,255,0.96)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  boxShadow: "var(--shadow-card)",
  fontSize: 12,
  padding: "8px 12px",
} as const;
const labelStyle = { fontWeight: 700, color: "#1b2a20", marginBottom: 2 } as const;

const PRESETS = [
  { label: "7 days", days: 6 },
  { label: "30 days", days: 29 },
  { label: "90 days", days: 89 },
] as const;

export function InboxReportsPage(): JSX.Element {
  const can = useCan();
  const [from, setFrom] = useState(() => lagosDaysAgo(29));
  const [to, setTo] = useState(() => lagosDaysAgo(0));
  const [number, setNumber] = useState("");
  const allowed = can("inbox.reports");

  const me = useQuery({ queryKey: inboxKeys.me, queryFn: inboxApi.me, enabled: allowed && can("inbox.view"), staleTime: 60_000 });
  const staff = useQuery({ queryKey: inboxKeys.staff, queryFn: inboxApi.staff, enabled: allowed && can("inbox.view"), staleTime: 5 * 60_000 });
  const report = useQuery({
    queryKey: ["inbox", "report", from, to, number],
    queryFn: () => settingsApi.report({ from, to, ...(number ? { number } : {}) }),
    enabled: allowed && !!from && !!to && from <= to,
  });

  const r = report.data;
  const messages = useMemo(() => (r ? fillDays(from, to, r.messages_per_day, ["inbound", "outbound"]) : []), [r, from, to]);
  const calls = useMemo(
    () =>
      r
        ? fillDays(from, to, r.calls_per_day, ["total", "answered", "missed", "after_hours"]).map((d) => ({
            ...d,
            other: Math.max(0, d.total - d.answered - d.missed - d.after_hours),
          }))
        : [],
    [r, from, to],
  );

  // Everyone who replied or answered, with names (call-only staff come back as ids).
  const staffRows = useMemo(() => {
    if (!r) return [];
    const nameOf = (id: string | null): string =>
      staffLabel((id && staff.data?.find((s) => s.id === id)?.name) || r.staff.find((s) => s.user_id === id)?.name, "Unknown");
    const rows = new Map<string, { id: string; name: string; replies: number; calls: number; talk_s: number }>();
    for (const s of r.staff) rows.set(s.user_id, { id: s.user_id, name: staffLabel(s.name), replies: s.replies, calls: s.calls ?? 0, talk_s: s.talk_s ?? 0 });
    for (const c of r.staff_calls) {
      if (!c.user_id || rows.has(c.user_id)) continue;
      rows.set(c.user_id, { id: c.user_id, name: nameOf(c.user_id), replies: 0, calls: c.calls, talk_s: c.talk_s });
    }
    return [...rows.values()].sort((a, b) => b.replies + b.calls - (a.replies + a.calls));
  }, [r, staff.data]);

  if (!allowed) {
    return (
      <Shell title="Inbox reports">
        <div className="empty">
          <div className="empty__title">No access</div>
          Ask an owner if you need inbox reports.
        </div>
      </Shell>
    );
  }

  const totalIn = messages.reduce((s, d) => s + d.inbound, 0);
  const totalCalls = calls.reduce((s, d) => s + d.total, 0);
  const missedCalls = calls.reduce((s, d) => s + d.missed + d.after_hours, 0);
  const resp = r?.response;
  // Both charts cover the same days, so they share the same date marks.
  const ticks = axisDays(messages.map((d) => d.day), 6);
  const today = lagosDaysAgo(0);
  const noReplies = resp?.median_first_response_s == null;
  const noneClosed = resp?.median_resolution_s == null;

  return (
    <Shell
      title="Inbox reports"
      crumb="Inbox"
      actions={
        can("inbox.export") ? (
          <a className="btn btn--subtle btn--sm" href={CONTACTS_CSV_URL} download title="Download every contact as a spreadsheet (CSV)">
            <Download size={14} /> Export contacts
          </a>
        ) : undefined
      }
    >
      <StatHero
        eyebrow="Inbox"
        title="Inbox reports"
        sub="How quickly customers get answers on WhatsApp and the phone."
        loading={report.isLoading}
        chips={[
          { label: "Messages in", value: totalIn },
          { label: "Calls in", value: totalCalls },
          { label: "Missed calls", value: missedCalls, tone: missedCalls > 0 ? "warn" : "good" },
        ]}
      />

      <div className="ibx-report">
      <div className="toolbar ibx-report__bar">
        <label className="field">
          <span className="field__label">From</span>
          <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">To</span>
          <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(me.data?.numbers.length ?? 0) > 1 && (
          <label className="field">
            <span className="field__label">Number</span>
            <select className="select" value={number} onChange={(e) => setNumber(e.target.value)}>
              <option value="">All numbers</option>
              {me.data!.numbers.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ibx-tabs" role="group" aria-label="Quick date ranges">
          {PRESETS.map((p) => {
            const on = to === today && from === lagosDaysAgo(p.days);
            return (
            <button
              key={p.label}
              type="button"
              className={`ibx-tab${on ? " is-active" : ""}`}
              aria-pressed={on}
              onClick={() => {
                setFrom(lagosDaysAgo(p.days));
                setTo(lagosDaysAgo(0));
              }}
            >
              {p.label}
            </button>
            );
          })}
        </div>
      </div>

      <DataState loading={report.isLoading} error={report.error} onRetry={() => void report.refetch()}>
        {r && (
          <>
            <div className="ibx-stats">
              <Stat label="New conversations" value={String(resp?.conversations ?? 0)} />
              {resp && resp.conversations > 0 ? (
                <Stat
                  label="Got a reply"
                  value={`${Math.round((resp.responded / resp.conversations) * 100)}%`}
                  hint={`${resp.responded} of ${resp.conversations} new conversations had a reply from staff`}
                  tone="good"
                />
              ) : (
                <div className="is-none" style={{ display: "contents" }}>
                  <Stat label="Got a reply" value="None yet" hint="No new conversations in these dates" tone="good" />
                </div>
              )}
              <div className={noReplies ? "is-none" : undefined} style={{ display: "contents" }}>
                <Stat
                  label="Typical first reply"
                  value={noReplies ? "None yet" : formatSpan(resp?.median_first_response_s)}
                  hint={noReplies ? "No new conversation has had a staff reply in these dates" : "Median time to first answer"}
                  tone="accent"
                />
              </div>
              <div className={noneClosed ? "is-none" : undefined} style={{ display: "contents" }}>
                <Stat
                  label="Typical time to close"
                  value={noneClosed ? "None yet" : formatSpan(resp?.median_resolution_s)}
                  hint={noneClosed ? "No new conversation has been closed in these dates" : "Median, closed chats only"}
                />
              </div>
            </div>

            <div className="l-split l-split--dash" style={{ marginBottom: 16 }}>
              <section className="card">
                <h2 className="t-h2" style={{ marginBottom: 2 }}>WhatsApp messages per day</h2>
                <p style={{ color: "var(--ink-soft)", fontSize: 12, margin: "0 0 8px" }}>"From us" counts staff replies and automatic messages.</p>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={messages} margin={{ top: 8, right: 22, left: -12, bottom: 0 }}>
                    <CartesianGrid stroke={COLOR_GRID} vertical={false} />
                    <XAxis dataKey="day" ticks={ticks} interval={0} tickFormatter={shortDate} tick={{ fontSize: 11, fill: COLOR_AXIS }} tickLine={false} axisLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: COLOR_AXIS }} tickLine={false} axisLine={false} width={40} />
                    <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} labelFormatter={(l) => shortDate(String(l))} cursor={{ fill: "rgba(31,122,68,0.06)" }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="inbound" name="From customers" stackId="m" fill={SERIES_COLORS[0]} isAnimationActive={false} maxBarSize={36} />
                    <Bar dataKey="outbound" name="From us" stackId="m" fill={SERIES_COLORS[2]} radius={[6, 6, 0, 0]} isAnimationActive={false} maxBarSize={36} />
                  </BarChart>
                </ResponsiveContainer>
              </section>
              <section className="card">
                <h2 className="t-h2" style={{ marginBottom: 8 }}>Incoming calls per day</h2>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={calls} margin={{ top: 8, right: 22, left: -12, bottom: 0 }}>
                    <CartesianGrid stroke={COLOR_GRID} vertical={false} />
                    <XAxis dataKey="day" ticks={ticks} interval={0} tickFormatter={shortDate} tick={{ fontSize: 11, fill: COLOR_AXIS }} tickLine={false} axisLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: COLOR_AXIS }} tickLine={false} axisLine={false} width={40} />
                    <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} labelFormatter={(l) => shortDate(String(l))} cursor={{ fill: "rgba(31,122,68,0.06)" }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="answered" name="Answered" stackId="c" fill={SERIES_COLORS[0]} isAnimationActive={false} maxBarSize={36} />
                    <Bar dataKey="missed" name="Missed / voicemail" stackId="c" fill={SERIES_COLORS[1]} isAnimationActive={false} maxBarSize={36} />
                    <Bar dataKey="after_hours" name="After hours" stackId="c" fill={SERIES_COLORS[5]} isAnimationActive={false} maxBarSize={36} />
                    <Bar dataKey="other" name="Other" stackId="c" fill="#b8c2bb" radius={[6, 6, 0, 0]} isAnimationActive={false} maxBarSize={36} />
                  </BarChart>
                </ResponsiveContainer>
              </section>
            </div>

            <div className="l-split l-split--dash">
              <section className="card">
                <h2 className="t-h2" style={{ marginBottom: 8 }}>By staff member</h2>
                {staffRows.length === 0 ? (
                  <div className="empty">No replies or answered calls in this period.</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th className="table__num">WhatsApp replies</th>
                          <th className="table__num">Calls answered</th>
                          <th className="table__num">Talk time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {staffRows.map((s) => (
                          <tr key={s.id}>
                            <td style={{ fontWeight: 600 }}>{s.name}</td>
                            <td className="table__num">{s.replies}</td>
                            <td className="table__num">{s.calls}</td>
                            <td className="table__num">{s.talk_s ? formatDuration(s.talk_s) : "None"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section className="card">
                <h2 className="t-h2" style={{ marginBottom: 8 }}>By number</h2>
                {r.per_number.length === 0 ? (
                  <div className="empty">No conversations in this period.</div>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Number</th>
                          <th className="table__num">New conversations</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...r.per_number]
                          .sort((a, b) => b.conversations - a.conversations)
                          .map((n) => (
                            <tr key={n.number_id}>
                              <td style={{ fontWeight: 600 }}>{n.label}</td>
                              <td className="table__num">{n.conversations}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </DataState>
      </div>
    </Shell>
  );
}

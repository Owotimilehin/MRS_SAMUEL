/**
 * Overview: the suite's home page, laid out exactly like docs/mockups/dashboard-v2-mrs-samuel.html
 * (greeting, "at a glance" panel, four number cards, a chart beside a ranked list, a table beside
 * a feed, then three small cards). Every figure comes from data the suite already has:
 * the inbox reports, the calls metrics, the unread counts and the conversation list, and
 * (for people with reports.view) the shop's own sales reports, plus advert results for ads.view.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Banknote,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Phone,
  PhoneMissed,
  Sparkles,
  Timer,
  Undo2,
} from "lucide-react";
import { money } from "@ms/shared";
import { Frame } from "@admin/lib/app-frame.js";
import { useAuthUser, useCan } from "@admin/lib/auth.js";
import { COLOR_AXIS, COLOR_GRID, shortDate } from "@admin/lib/analytics-theme.js";
import { inboxApi, inboxKeys } from "@admin/lib/inbox-api.js";
import { channelName, contactName, listTime } from "@admin/lib/inbox-logic.js";
import { settingsApi } from "@admin/lib/inbox-settings-api.js";
import { waitWords } from "@ms/shared";
import { callKeys, callsApi } from "../calls/calls-api.js";
import {
  PERIODS,
  lagosToday,
  outcomeText,
  percent,
  periodRange,
  shortDuration,
  waitingFor,
  type CallPeriod,
} from "../calls/calls-logic.js";
import { commentKeys, commentsApi } from "../comments/comments-api.js";
import { adsApi, adsKeys } from "../ads/ads-api.js";
import { salesApi, salesKeys } from "./overview-api.js";
import {
  compare,
  nairaFull,
  nairaShort,
  nairaTick,
  ordersText,
  previousRange,
  salesByChannel,
  salesTotals,
} from "./overview-logic.js";
import "./overview.css";

function greeting(h: number): string {
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

const AVATAR_COLOURS = ["#e85d1c", "#1f7a44", "#e8536a", "#c98a12", "#6b4ea8"];

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((w) => w[0])
      .filter((ch) => ch && /[a-z]/i.test(ch))
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

export function OverviewPage(): JSX.Element {
  const user = useAuthUser();
  const can = useCan();
  const canReports = can("inbox.reports");
  // Sales figures need the same permission as the shop's own sales reports.
  const canSales = can("reports.view");
  const canAds = can("ads.view");
  const [period, setPeriod] = useState<CallPeriod>("7");
  const { from, to } = periodRange(period);
  const prev = previousRange(from, to);

  const unread = useQuery({
    queryKey: inboxKeys.unread,
    queryFn: async () => (await inboxApi.unread()).messages,
    refetchInterval: 60_000,
  });
  const callbacks = useQuery({
    queryKey: callKeys.callbacks,
    queryFn: callsApi.callbacks,
    refetchInterval: 60_000,
  });
  const comments = useQuery({
    queryKey: commentKeys.unread,
    queryFn: commentsApi.unread,
    enabled: can("social.comments"),
    retry: false,
  });
  const report = useQuery({
    queryKey: ["overview", "report", from, to],
    queryFn: () => settingsApi.report({ from, to }),
    enabled: canReports,
  });
  const calls = useQuery({
    queryKey: callKeys.metrics(from, to),
    queryFn: () => callsApi.metrics(from, to),
    enabled: canReports,
  });
  const revenue = useQuery({
    queryKey: salesKeys.revenue(from, to),
    queryFn: () => salesApi.revenue(from, to),
    enabled: canSales,
    retry: false,
  });
  const prevRevenue = useQuery({
    queryKey: salesKeys.revenue(prev.from, prev.to),
    queryFn: () => salesApi.revenue(prev.from, prev.to),
    enabled: canSales,
    retry: false,
  });
  const salesDays = useQuery({
    queryKey: salesKeys.days(from, to),
    queryFn: () => salesApi.days(from, to),
    enabled: canSales,
    retry: false,
  });
  const chatOrders = useQuery({
    queryKey: salesKeys.chat(from, to),
    queryFn: () => salesApi.chat(from, to),
    enabled: canSales,
    retry: false,
  });
  const ads = useQuery({
    queryKey: adsKeys.overview(from, to),
    queryFn: () => adsApi.overview(from, to),
    enabled: canSales && canAds,
    retry: false,
  });
  const replyTarget = useQuery({ queryKey: inboxKeys.replyTarget, queryFn: inboxApi.replyTarget, refetchInterval: 60_000, retry: false });
  const remindersDue = useQuery({ queryKey: inboxKeys.remindersDue, queryFn: inboxApi.remindersDue, refetchInterval: 60_000, retry: false });
  const latestFilters = { status: "open" as const, view: "all" as const, chatsOnly: true };
  const latest = useQuery({
    queryKey: inboxKeys.listFirstPage(latestFilters),
    queryFn: () => inboxApi.conversations(latestFilters),
  });

  const handle = user.email?.split("@")[0] ?? "";
  const name = handle ? handle.charAt(0).toUpperCase() + handle.slice(1) : "there";
  const today = new Date().toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const hour = Number(
    new Date().toLocaleTimeString("en-GB", {
      timeZone: "Africa/Lagos",
      hour: "2-digit",
      hour12: false,
    }),
  );

  const waitingChats = unread.data ?? 0;
  const toCallBack = callbacks.data?.data ?? [];
  const waitingComments = comments.data ?? 0;
  const r = report.data;
  const t = calls.data?.totals ?? null;
  const msgIn = useMemo(() => (r?.messages_per_day ?? []).reduce((a, d) => a + d.inbound, 0), [r]);
  const msgOut = useMemo(
    () => (r?.messages_per_day ?? []).reduce((a, d) => a + d.outbound, 0),
    [r],
  );
  const days = Math.max(1, r?.messages_per_day.length ?? 1);
  const reachable = t ? t.inbound - t.information : 0;
  const staff = [...(r?.staff ?? [])].sort((a, b) => b.replies - a.replies).slice(0, 6);
  const maxReplies = Math.max(1, ...staff.map((s) => s.replies));
  const rows = (latest.data?.data ?? []).slice(0, 6);
  const periodLabel = PERIODS.find((p) => p.key === period)!.label.toLowerCase();
  const before = period === "today" ? "yesterday" : `the ${periodLabel} before`;

  const sales = revenue.data ? salesTotals(revenue.data) : null;
  const prevSales = prevRevenue.data ? salesTotals(prevRevenue.data) : null;
  const salesChange = sales && prevSales ? compare(sales.net, prevSales.net) : null;
  const split = useMemo(
    () => (revenue.data ? salesByChannel(revenue.data, chatOrders.data) : []),
    [revenue.data, chatOrders.data],
  );
  const maxSlice = Math.max(1, ...split.map((s) => s.net));
  const dayRows = salesDays.data ?? [];
  const todayIso = lagosToday();
  const ad = ads.data && ads.data.currency ? ads.data : null;

  const brief: JSX.Element[] = [];
  if (waitingChats > 0)
    brief.push(
      <li key="chats">
        <strong>
          {waitingChats} unread {waitingChats === 1 ? "message" : "messages"}
        </strong>{" "}
        from customers are waiting in the Inbox.
      </li>,
    );
  if (toCallBack.length > 0)
    brief.push(
      <li key="calls">
        <strong>
          {toCallBack.length} missed {toCallBack.length === 1 ? "call" : "calls"}
        </strong>{" "}
        to return. The longest has been waiting since {waitingFor(toCallBack[0]!.started_at)}.
      </li>,
    );
  // Suite spec 15: chats over the reply-time target (only when the owner turned it on).
  const late = replyTarget.data;
  if (late?.target_minutes && late.late > 0)
    brief.push(
      <li key="late">
        <strong>
          {late.late} {late.late === 1 ? "chat has" : "chats have"}
        </strong>{" "}
        waited longer than your {late.target_minutes}-minute reply target.
        {late.longest_minutes != null && <> The longest has waited {waitWords(late.longest_minutes)}.</>}
      </li>,
    );
  if ((remindersDue.data ?? 0) > 0)
    brief.push(
      <li key="reminders">
        <strong>
          {remindersDue.data} {remindersDue.data === 1 ? "reminder is" : "reminders are"}
        </strong>{" "}
        due. <Link to="/tasks">Open Tasks</Link>.
      </li>,
    );
  if (waitingComments > 0)
    brief.push(
      <li key="comments">
        <strong>
          {waitingComments} comment {waitingComments === 1 ? "thread" : "threads"}
        </strong>{" "}
        on your posts need an answer.
      </li>,
    );

  return (
    <Frame
      title={`${greeting(hour)}, ${name}`}
      pageName="Overview"
      subtitle={`Here's how your ${canSales ? "sales and " : ""}customer conversations are doing · ${today}`}
      actions={
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
      }
    >
      <div className="ov">
        <div className="ov-brief">
          <span className="ov-brief__ic">
            <Sparkles size={18} />
          </span>
          <div>
            <b>Today at a glance</b>
            {brief.length > 0 ? (
              <ul>{brief}</ul>
            ) : (
              <p>Nothing is waiting. Every chat, call and comment has been answered.</p>
            )}
          </div>
          <Link to="/inbox" className="btn btn--subtle ov-brief__btn">
            Open inbox
          </Link>
        </div>

        {(canReports || canSales) && (
          <div className="ov-kpis">
            {canSales && (
              <Kpi
                tone="accent"
                icon={<Banknote size={15} />}
                label="Sales"
                chip={
                  salesChange ? { text: salesChange.text, tone: salesChange.direction } : undefined
                }
                value={sales ? nairaShort(sales.net) : "—"}
                foot={
                  sales
                    ? `${ordersText(sales.orders)} paid, after refunds${prevSales ? ` · ${nairaShort(prevSales.net)} ${before}` : ""}`
                    : "Paid shop orders, after refunds"
                }
              />
            )}
            {canReports && !canSales && (
              <Kpi
                tone="accent"
                icon={<MessagesSquare size={15} />}
                label="Messages in"
                chip={
                  waitingChats > 0 ? { text: `${waitingChats} unread`, tone: "warn" } : undefined
                }
                value={String(msgIn)}
                foot={`${msgOut} sent by us · in the last ${periodLabel}`}
              />
            )}
            {canReports && (
              <Kpi
                tone="green"
                icon={<Timer size={15} />}
                label="Chats answered"
                chip={
                  canSales && waitingChats > 0
                    ? { text: `${waitingChats} unread`, tone: "warn" }
                    : undefined
                }
                value={r?.response ? percent(r.response.responded, r.response.conversations) : "—"}
                foot={[
                  r?.response?.median_first_response_s != null
                    ? `Typical first reply ${shortDuration(r.response.median_first_response_s)}`
                    : `${r?.response?.conversations ?? 0} new conversations`,
                  // With Sales in the first card (four across, per the UI spec), the message counts move here.
                  ...(canSales ? [`${msgIn} messages in, ${msgOut} sent`] : []),
                ].join(" · ")}
              />
            )}
            {canReports && (
              <Kpi
                tone="pink"
                icon={<Phone size={15} />}
                label="Calls answered"
                chip={
                  toCallBack.length > 0
                    ? { text: `${toCallBack.length} to call back`, tone: "warn" }
                    : undefined
                }
                value={t ? percent(t.answered_in, reachable) : "—"}
                foot={
                  t
                    ? `${t.answered_in} of ${reachable} incoming · rang ${shortDuration(t.avg_wait_s)}`
                    : "No calls yet"
                }
              />
            )}
            {canReports && (
              <Kpi
                tone="amber"
                icon={<Undo2 size={15} />}
                label="Missed calls returned"
                value={t ? percent(t.returned, t.missed_in) : "—"}
                foot={
                  t && t.missed_in
                    ? `${t.returned} of ${t.missed_in} missed calls`
                    : "No missed calls"
                }
              />
            )}
          </div>
        )}

        {canSales && (
          <div className="ov-row ov-row--2">
            <div className="card ov-card">
              <div className="ov-card__h">
                <div>
                  <h3>Takings, {period === "today" ? "today" : `last ${periodLabel}`}</h3>
                  <div className="ov-sub">Paid orders after refunds, by Lagos day</div>
                </div>
              </div>
              <div className="ov-legend">
                <span>
                  <i style={{ background: "var(--accent-fill)" }} /> Takings
                </span>
                {sales && (
                  <span className="ov-legend__tot">
                    Daily average {nairaFull(sales.net / Math.max(1, dayRows.length))}
                  </span>
                )}
              </div>
              <div className="ov-chart">
                {!sales || (sales.orders === 0 && sales.net === 0) ? (
                  <p className="ov-empty">
                    {revenue.isLoading ? "Loading sales…" : "No paid orders in this period."}
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={dayRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke={COLOR_GRID} strokeDasharray="3 4" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickFormatter={shortDate}
                        tick={{ fontSize: 11, fill: COLOR_AXIS }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tickFormatter={nairaTick}
                        width={52}
                        tick={{ fontSize: 11, fill: COLOR_AXIS }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        labelFormatter={(d) => shortDate(String(d))}
                        formatter={(v, _n, item) => [
                          `${nairaFull(Number(v))} · ${ordersText(Number((item.payload as { orders?: number } | undefined)?.orders ?? 0))}`,
                          "Takings",
                        ]}
                        cursor={{ fill: "var(--surface-soft)" }}
                      />
                      <Bar
                        dataKey="net_ngn"
                        name="Takings"
                        fill="var(--accent-fill)"
                        radius={[5, 5, 0, 0]}
                        isAnimationActive={false}
                        maxBarSize={30}
                      >
                        {dayRows.map((d) => (
                          // Today is not over yet, so its bar is lighter (UI spec, Charts).
                          <Cell
                            key={d.date}
                            fill="var(--accent-fill)"
                            fillOpacity={d.date === todayIso && dayRows.length > 1 ? 0.55 : 1}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
              <p className="ov-note">
                Counts shop orders that were paid (till, website, WhatsApp, phone and Chowdeck),
                less refunds completed on the same days. Unpaid and cancelled orders are left out.
              </p>
            </div>

            <div className="card ov-card">
              <div className="ov-card__h">
                <div>
                  <h3>Where sales came from</h3>
                  <div className="ov-sub">Takings by where the order was made</div>
                </div>
                {sales && <span className="ov-chip ov-chip--or">{ordersText(sales.orders)}</span>}
              </div>
              <div className="ov-pk">
                {split.length === 0 && <p className="ov-empty">No paid orders in this period.</p>}
                {split.map((s) => (
                  <div key={s.key}>
                    <div className="ov-pk__t">
                      {s.label}
                      <span className="tabular-nums">
                        {nairaShort(s.net)} · {ordersText(s.orders)}
                      </span>
                    </div>
                    <div className="ov-bar">
                      <i style={{ width: `${Math.max(0, (s.net / maxSlice) * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="ov-src">
                <div className="ov-srow">
                  <MessageCircle size={15} />
                  <span className="n">Orders from WhatsApp chats</span>
                  <span className="q tabular-nums">
                    {chatOrders.data ? chatOrders.data.orders : "—"}
                  </span>
                </div>
                <p className="ov-note ov-note--tight">
                  {chatOrders.data && chatOrders.data.orders > 0
                    ? `${nairaShort(chatOrders.data.gross_ngn)} · `
                    : ""}
                  Carts customers sent in a WhatsApp chat that the team placed as an order and that
                  were paid. Counted in WhatsApp above.
                </p>
                {canAds && ad && (
                  <>
                    <div className="ov-srow">
                      <Megaphone size={15} />
                      <span className="n">Orders from adverts</span>
                      <span className="q tabular-nums">{ad.totals.orders}</span>
                    </div>
                    <p className="ov-note ov-note--tight">
                      {ad.totals.orders > 0 ? `${nairaShort(ad.totals.order_value_ngn)} · ` : ""}
                      Spent {money(Math.round(ad.totals.spend), ad.currency!)}
                      {ad.totals.cost_per_order != null
                        ? `, ${money(ad.totals.cost_per_order, ad.currency!)} per order`
                        : ""}
                      . Paid orders from customers who tapped a Meta advert first; spend is what
                      Meta reports for these days{ad.has_figures ? "" : " (none reported yet)"}.{" "}
                      <Link to="/ads" className="ov-link">
                        Open Ads
                      </Link>
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {canReports && (
          <div className="ov-row ov-row--2">
            <div className="card ov-card">
              <div className="ov-card__h">
                <div>
                  <h3>Messages, last {periodLabel}</h3>
                  <div className="ov-sub">WhatsApp, Messenger and Instagram</div>
                </div>
              </div>
              <div className="ov-legend">
                <span>
                  <i style={{ background: "var(--accent-fill)" }} /> From customers
                </span>
                <span>
                  <i style={{ background: "var(--success)" }} /> From us
                </span>
                <span className="ov-legend__tot">
                  Daily average {Math.round((msgIn + msgOut) / days)}
                </span>
              </div>
              <div className="ov-chart">
                {msgIn + msgOut === 0 ? (
                  <p className="ov-empty">No messages in this period.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart
                      data={r?.messages_per_day ?? []}
                      margin={{ top: 8, right: 8, left: -18, bottom: 0 }}
                    >
                      <CartesianGrid stroke={COLOR_GRID} strokeDasharray="3 4" vertical={false} />
                      <XAxis
                        dataKey="day"
                        tickFormatter={shortDate}
                        tick={{ fontSize: 11, fill: COLOR_AXIS }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fontSize: 11, fill: COLOR_AXIS }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        labelFormatter={(d) => shortDate(String(d))}
                        cursor={{ fill: "rgba(60,40,20,0.04)" }}
                      />
                      <Bar
                        dataKey="inbound"
                        name="From customers"
                        stackId="m"
                        fill="var(--accent-fill)"
                        isAnimationActive={false}
                        maxBarSize={30}
                      />
                      <Bar
                        dataKey="outbound"
                        name="From us"
                        stackId="m"
                        fill="var(--success)"
                        radius={[5, 5, 0, 0]}
                        isAnimationActive={false}
                        maxBarSize={30}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="card ov-card">
              <div className="ov-card__h">
                <div>
                  <h3>Team this period</h3>
                  <div className="ov-sub">Replies sent and calls handled</div>
                </div>
                <span className="ov-chip ov-chip--or">{msgOut} replies</span>
              </div>
              <div className="ov-list">
                {staff.length === 0 && (
                  <p className="ov-empty">No replies or calls in this period.</p>
                )}
                {staff.map((s, i) => (
                  <div className="ov-rank" key={s.user_id}>
                    <span
                      className="ov-avatar"
                      style={{ background: AVATAR_COLOURS[i % AVATAR_COLOURS.length] }}
                    >
                      {initialsOf(s.name)}
                    </span>
                    <div className="ov-rank__meta">
                      <div className="ov-rank__t">
                        {s.name}
                        <span>
                          {s.replies} replies · {s.calls} calls
                        </span>
                      </div>
                      <div className="ov-bar">
                        <i style={{ width: `${(s.replies / maxReplies) * 100}%` }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="ov-row ov-row--3">
          <div className="card ov-card">
            <div className="ov-card__h">
              <div>
                <h3>Latest conversations</h3>
                <div className="ov-sub">Open chats, newest first</div>
              </div>
              <Link to="/inbox" className="btn btn--sm btn--subtle ov-card__r">
                View all chats
              </Link>
            </div>
            {rows.length === 0 ? (
              <p className="ov-empty ov-pad">No open chats right now.</p>
            ) : (
              <div className="ov-tblwrap">
                <table className="ov-table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Last message</th>
                      <th>Channel</th>
                      <th>Status</th>
                      <th className="r">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c, i) => {
                      const who = contactName(c.customer_name, c.customer_phone, c.identity_name);
                      return (
                        <tr key={c.id}>
                          <td>
                            <Link
                              to="/inbox/$conversationId"
                              params={{ conversationId: c.id }}
                              className="ov-cust"
                            >
                              <span
                                className="ov-avatar ov-avatar--sm"
                                style={{ background: AVATAR_COLOURS[i % AVATAR_COLOURS.length] }}
                              >
                                {initialsOf(who)}
                              </span>
                              <span>
                                {who}
                                <small>
                                  {c.assignee_name ? `With ${c.assignee_name}` : "Unassigned"}
                                </small>
                              </span>
                            </Link>
                          </td>
                          <td className="ov-preview">{c.preview ?? "—"}</td>
                          <td>
                            <span className="ov-tag">{channelName(c.channel ?? "whatsapp")}</span>
                          </td>
                          <td>
                            {c.unread > 0 ? (
                              <span className="pill pill--warning">Waiting</span>
                            ) : (
                              <span className="pill pill--success">Answered</span>
                            )}
                          </td>
                          <td className="r">{listTime(c.last_activity_at)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card ov-card">
            <div className="ov-card__h">
              <div>
                <h3>To call back</h3>
              </div>
              <span className="ov-chip ov-chip--up ov-card__r">
                <i /> Live
              </span>
            </div>
            <div className="ov-feed">
              {toCallBack.length === 0 && (
                <p className="ov-empty">Everyone has been called back.</p>
              )}
              {toCallBack.slice(0, 5).map((c) => {
                const o = outcomeText(c.outcome, c.direction);
                return (
                  <div className="ov-ev" key={c.id}>
                    <span className="ov-ev__ic">
                      <PhoneMissed size={15} />
                    </span>
                    <div>
                      <p>
                        <b>{contactName(c.customer.name, c.customer.phone, null)}</b> ·{" "}
                        {o.label.toLowerCase()}
                        {c.attempts > 1 ? `, tried ${c.attempts} times` : ""}
                      </p>
                      <small>{waitingFor(c.started_at)}</small>
                    </div>
                  </div>
                );
              })}
              {toCallBack.length > 0 && (
                <Link to="/calls" className="ov-more">
                  Open Calls →
                </Link>
              )}
            </div>
          </div>
        </div>

        {canReports && t && (
          <div className="ov-row ov-row--4">
            <div className="card ov-card">
              <div className="ov-card__h">
                <h3>How calls ended</h3>
              </div>
              <div className="ov-pk">
                {(
                  [
                    ["Answered", t.answered_in, "var(--success)"],
                    ["Missed", t.missed_in - t.voicemail - t.after_hours, "var(--pink, #e8536a)"],
                    ["Voicemail", t.voicemail, "var(--warning)"],
                    ["After hours", t.after_hours, "var(--ink-faint)"],
                  ] as [string, number, string][]
                ).map(([label, n, c]) => (
                  <div key={label}>
                    <div className="ov-pk__t">
                      {label}
                      <span>{n}</span>
                    </div>
                    <div className="ov-bar">
                      <i
                        style={{
                          width: `${t.inbound ? (n / t.inbound) * 100 : 0}%`,
                          background: c,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card ov-card">
              <div className="ov-card__h">
                <h3>New conversations by line</h3>
              </div>
              <div className="ov-stock">
                {(r?.per_number ?? []).length === 0 && (
                  <p className="ov-empty">No new conversations in this period.</p>
                )}
                {(r?.per_number ?? []).map((n) => (
                  <div className="ov-srow" key={n.number_id}>
                    <MessageCircle size={15} />
                    <span className="n">{n.label}</span>
                    <span className="q">{n.conversations}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card ov-card">
              <div className="ov-card__h">
                <h3>Phone menu choices</h3>
              </div>
              <div className="ov-stock">
                {(calls.data?.menu ?? []).length === 0 && (
                  <p className="ov-empty">No menu choices in this period.</p>
                )}
                {(calls.data?.menu ?? []).map((m) => (
                  <div className="ov-srow" key={m.choice ?? "none"}>
                    <Phone size={15} />
                    <span className="n">Pressed {m.choice}</span>
                    <span className="q">{m.calls}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </Frame>
  );
}

function Kpi({
  tone,
  icon,
  label,
  value,
  foot,
  chip,
}: {
  tone: "accent" | "green" | "pink" | "amber";
  icon: JSX.Element;
  label: string;
  value: string;
  foot: string;
  chip?: { text: string; tone: "warn" | "up" | "down" | "same" } | undefined;
}): JSX.Element {
  return (
    <div className="card ov-kpi">
      <div className="ov-kpi__lbl">
        <span className={`ov-kpi__ic ov-kpi__ic--${tone}`}>{icon}</span>
        {label}
        {chip && <span className={`ov-chip ov-chip--${chip.tone}`}>{chip.text}</span>}
      </div>
      <div className="ov-kpi__val tabular-nums">{value}</div>
      <div className="ov-kpi__foot">{foot}</div>
    </div>
  );
}

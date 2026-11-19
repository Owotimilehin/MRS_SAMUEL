import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { NotifySettings } from "./NotifySettings.js";
import { Bell, Search } from "lucide-react";
import { ChannelIcon } from "./ChannelIcon.js";
import { DataState } from "../DataState.js";
import { useInboxUi } from "../../lib/inbox-ui.js";
import { inboxApi, inboxKeys, type ConversationFilters } from "../../lib/inbox-api.js";
import { channelName, contactName, emptyListText, listTime, staffLabel, type InboxTab, type InboxTabKey } from "../../lib/inbox-logic.js";
import type { ConversationRow, IdentityChannel, InboxMe } from "../../lib/inbox-types.js";
import { channelForKind } from "@ms/shared";

interface Props {
  me: InboxMe;
  tabs: InboxTab[];
  tab: InboxTabKey;
  onTab: (t: InboxTabKey) => void;
  number: string;
  onNumber: (id: string) => void;
  label: string;
  onLabel: (l: string) => void;
  selectedId: string | null;
  onSelect: (row: ConversationRow) => void;
}

/** Left pane: tabs, search, filters and the conversation rows. */
export function ConversationList(p: Props): JSX.Element {
  const search = useInboxUi((st) => st.search);
  const channel = useInboxUi((st) => st.channel);
  const setChannel = useInboxUi((st) => st.setChannel);
  const setSearch = useInboxUi((st) => st.setSearch);
  const [q, setQ] = useState(() => search.trim());
  const [notifyOpen, setNotifyOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);

  // Show a fade on the side that has more tabs, and keep the chosen tab in view.
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const mark = (): void => {
      el.classList.toggle("more-left", el.scrollLeft > 4);
      el.classList.toggle("more-right", el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    };
    const active = el.querySelector<HTMLElement>(".is-active");
    if (active) {
      const left = active.offsetLeft - el.offsetLeft;
      if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left - 24);
      else if (left + active.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = left + active.offsetWidth - el.clientWidth + 24;
    }
    mark();
    el.addEventListener("scroll", mark, { passive: true });
    window.addEventListener("resize", mark);
    return () => {
      el.removeEventListener("scroll", mark);
      window.removeEventListener("resize", mark);
    };
  }, [p.tab, p.tabs.length]);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const current = p.tabs.find((t) => t.key === p.tab) ?? p.tabs[0]!;
  const filters: ConversationFilters = {
    status: current.status,
    view: current.view,
    ...(p.number ? { number: p.number } : {}),
    ...(p.label ? { label: p.label } : {}),
    ...(q ? { q } : {}),
    ...(channel ? { channel } : {}),
  };

  const list = useInfiniteQuery({
    queryKey: inboxKeys.list(filters),
    queryFn: ({ pageParam }) => inboxApi.conversations(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((pg) => pg.data) ?? [], [list.data]);

  // Put the list back where it was after returning from a conversation.
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || rows.length === 0 || !bodyRef.current) return;
    restored.current = true;
    bodyRef.current.scrollTop = useInboxUi.getState().listScroll;
  }, [rows.length]);

  // Labels to filter by: whatever is on screen, plus the active one.
  const labelOptions = useMemo(() => {
    const s = new Set<string>(rows.flatMap((r) => r.labels));
    if (p.label) s.add(p.label);
    return [...s].sort();
  }, [rows, p.label]);

  const voiceOnly = new Set(p.me.numbers.filter((n) => n.channels === "voice").map((n) => n.id));
  // The channels the viewer's lines cover, in a fixed order (spec 02, 7.2).
  const myChannels = (["whatsapp", "messenger", "instagram"] as const).filter((ch) =>
    p.me.numbers.some((n) => channelForKind(n.kind ?? "phone") === ch),
  );
  const empty = channel
    ? { title: `No ${channelName(channel)} chats here`, hint: "Try All, or another list." }
    : emptyListText(current.key, !!q);
  const showChip = p.me.numbers.length > 1 || myChannels.length > 1;

  return (
    <>
      <div className="ibx-list__head">
        <div className="ibx-tabs ibx-tabs--fit" role="tablist" aria-label="Conversation lists" ref={tabsRef}>
          {p.tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={t.key === p.tab}
              className={`ibx-tab${t.key === p.tab ? " is-active" : ""}`}
              onClick={() => p.onTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ibx-list__search">
          <label className="toolbar__search" style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
            <Search size={15} aria-hidden />
            <input
              className="input"
              type="search"
              placeholder="Search name, phone or username…"
              aria-label="Search conversations"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1 }}
            />
          </label>
          <button
            type="button"
            className="btn btn--ghost btn--sm ibx-bell"
            aria-label="Notifications"
            title="Notifications: sound and pop-ups for new messages"
            onClick={() => setNotifyOpen(true)}
          >
            <Bell size={16} aria-hidden />
          </button>
        </div>
        {notifyOpen && <NotifySettings onClose={() => setNotifyOpen(false)} />}
        {myChannels.length > 1 && (
          <div className="ibx-channel-filter" role="group" aria-label="Show chats from">
            <button
              type="button"
              className={`btn btn--sm ${channel === "" ? "btn--primary" : "btn--ghost"}`}
              aria-pressed={channel === ""}
              onClick={() => setChannel("")}
            >
              All
            </button>
            {myChannels.map((ch: IdentityChannel) => (
              <button
                key={ch}
                type="button"
                className={`btn btn--sm ${channel === ch ? "btn--primary" : "btn--ghost"}`}
                aria-pressed={channel === ch}
                aria-label={channelName(ch)}
                onClick={() => setChannel(ch)}
              >
                <ChannelIcon channel={ch} size={14} />
                <span className="ibx-channel-filter__name">{channelName(ch)}</span>
              </button>
            ))}
          </div>
        )}
        {/* Always shown, so the list doesn't jump when a tab has no labels. */}
        <div className="ibx-filters">
          {p.me.numbers.length > 1 && (
            <select className="select" aria-label="Channel" value={p.number} onChange={(e) => p.onNumber(e.target.value)}>
              <option value="">All channels</option>
              {p.me.numbers.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
          )}
          <select
            className="select"
            aria-label="Label"
            value={p.label}
            disabled={labelOptions.length === 0}
            title={labelOptions.length === 0 ? "None of these chats has a label yet" : undefined}
            onChange={(e) => p.onLabel(e.target.value)}
          >
            <option value="">All labels</option>
            {labelOptions.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div
        className="ibx-list__body"
        ref={bodyRef}
        onScroll={(e) => useInboxUi.getState().setListScroll(e.currentTarget.scrollTop)}
      >
        <DataState
          loading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          isEmpty={rows.length === 0}
          emptyTitle={empty.title}
          emptyHint={empty.hint}
        >
          {rows.map((r) => (
            <ConversationRowItem key={r.id} row={r} active={r.id === p.selectedId} onSelect={p.onSelect} showNumber={showChip} callsOnly={voiceOnly.has(r.number_id)} />
          ))}
          {list.hasNextPage && (
            <div style={{ padding: 12, textAlign: "center" }}>
              <button
                type="button"
                className="btn btn--subtle btn--sm"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? "Loading…" : "Load older"}
              </button>
            </div>
          )}
        </DataState>
      </div>
    </>
  );
}

function ConversationRowItem({
  row,
  active,
  onSelect,
  showNumber,
  callsOnly,
}: {
  row: ConversationRow;
  active: boolean;
  onSelect: (r: ConversationRow) => void;
  showNumber: boolean;
  /** The business number takes calls only, so this isn't a WhatsApp chat. */
  callsOnly: boolean;
}): JSX.Element {
  const name = contactName(row.customer_name, row.customer_phone, row.identity_name);
  const unread = row.unread > 0;
  return (
    <button
      type="button"
      className={`ibx-row${active ? " is-active" : ""}${unread ? " is-unread" : ""}`}
      onClick={() => onSelect(row)}
      aria-current={active ? "true" : undefined}
    >
      <span className="ibx-row__name">{name}</span>
      <span className="ibx-row__time">{listTime(row.last_activity_at)}</span>
      <span className="ibx-row__preview">{row.preview ?? "No messages yet"}</span>
      <span className="ibx-row__unread">{unread && <span className="ibx-badge" aria-label={`${row.unread} unread`}>{row.unread}</span>}</span>
      <span className="ibx-row__meta">
        {showNumber && (
          <span className="ibx-chip">
            <ChannelIcon channel={row.channel} callsOnly={callsOnly} size={10} /> {row.number_label}
          </span>
        )}
        {row.status === "pending" && <span className="ibx-chip ibx-chip--warn">Pending</span>}
        {row.labels.slice(0, 2).map((l) => (
          <span key={l} className="ibx-chip">
            {l}
          </span>
        ))}
        {row.labels.length > 2 && <span className="ibx-chip">+{row.labels.length - 2}</span>}
        <span className="ibx-row__who">{row.assignee_name ? `→ ${staffLabel(row.assignee_name)}` : "Unassigned"}</span>
      </span>
    </button>
  );
}

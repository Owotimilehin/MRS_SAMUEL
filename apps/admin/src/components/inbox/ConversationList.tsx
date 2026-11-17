import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Search, Phone } from "lucide-react";
import { DataState } from "../DataState.js";
import { useInboxUi } from "../../lib/inbox-ui.js";
import { inboxApi, inboxKeys, type ConversationFilters } from "../../lib/inbox-api.js";
import { contactName, listTime, type InboxTab, type InboxTabKey } from "../../lib/inbox-logic.js";
import type { ConversationRow, InboxMe } from "../../lib/inbox-types.js";

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
  const setSearch = useInboxUi((st) => st.setSearch);
  const [q, setQ] = useState(() => search.trim());
  const bodyRef = useRef<HTMLDivElement | null>(null);
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

  return (
    <>
      <div className="ibx-list__head">
        <div className="ibx-tabs" role="tablist" aria-label="Conversation lists">
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
        <label className="toolbar__search" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Search size={15} aria-hidden />
          <input
            className="input"
            type="search"
            placeholder="Search name or phone…"
            aria-label="Search conversations"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1 }}
          />
        </label>
        {(p.me.numbers.length > 1 || labelOptions.length > 0) && (
          <div className="ibx-filters">
            {p.me.numbers.length > 1 && (
              <select className="select" aria-label="Business number" value={p.number} onChange={(e) => p.onNumber(e.target.value)}>
                <option value="">All numbers</option>
                {p.me.numbers.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                  </option>
                ))}
              </select>
            )}
            {labelOptions.length > 0 && (
              <select className="select" aria-label="Label" value={p.label} onChange={(e) => p.onLabel(e.target.value)}>
                <option value="">All labels</option>
                {labelOptions.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
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
          emptyTitle={q ? "No matches" : "All clear"}
          emptyHint={q ? "Nobody matches that name or number." : "No conversations here right now."}
        >
          {rows.map((r) => (
            <ConversationRowItem key={r.id} row={r} active={r.id === p.selectedId} onSelect={p.onSelect} showNumber={p.me.numbers.length > 1} />
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
}: {
  row: ConversationRow;
  active: boolean;
  onSelect: (r: ConversationRow) => void;
  showNumber: boolean;
}): JSX.Element {
  const name = contactName(row.customer_name, row.customer_phone);
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
      <span>{unread && <span className="ibx-badge" aria-label={`${row.unread} unread`}>{row.unread}</span>}</span>
      <span className="ibx-row__meta">
        {showNumber && (
          <span className="ibx-chip">
            <Phone size={10} style={{ verticalAlign: -1 }} /> {row.number_label}
          </span>
        )}
        {row.status === "pending" && <span className="pill pill--warning" style={{ fontSize: 10 }}>Pending</span>}
        {row.labels.slice(0, 3).map((l) => (
          <span key={l} className="ibx-chip">
            {l}
          </span>
        ))}
        <span style={{ marginLeft: "auto" }}>{row.assignee_name ? `→ ${row.assignee_name}` : "Unassigned"}</span>
      </span>
    </button>
  );
}

/**
 * The top-bar search: type a name, a phone number or words from a post, and a
 * dropdown lists matching chats, contacts and posts (only the groups this
 * person may open). Arrow keys move, Enter opens, Esc closes.
 *
 * Rules live in search-logic.ts; the calls in search-api.ts.
 */
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClock, MessagesSquare, Search, Users, type LucideIcon } from "lucide-react";
import { useAuthUser } from "@admin/lib/auth.js";
import { searchAll, searchKeys } from "./search-api.js";
import {
  DEBOUNCE_MS,
  SEARCH_GROUPS,
  allowedKinds,
  buildGroups,
  flatItems,
  moveIndex,
  optionId,
  searchText,
  type SearchItem,
  type SearchKind,
} from "./search-logic.js";
import "./search.css";

const ICONS: Record<SearchKind, LucideIcon> = { chats: MessagesSquare, contacts: Users, posts: CalendarClock };
/** The contacts search refuses more than 80 characters, so the box stops there. */
const MAX_LENGTH = 80;

export function SuiteSearch({ inputRef, isMac }: { inputRef: RefObject<HTMLInputElement>; isMac: boolean }): JSX.Element | null {
  const user = useAuthUser();
  const navigate = useNavigate();
  const kinds = useMemo(() => allowedKinds(user.capabilities), [user.capabilities]);
  const listId = useId();

  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // The text actually searched: what was typed, once typing pauses.
  const typed = searchText(value);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (typed === null) {
      setText(null);
      return;
    }
    const t = window.setTimeout(() => setText(typed), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [typed]);

  const results = useQuery({
    queryKey: searchKeys.run(text ?? "", kinds),
    enabled: text !== null && kinds.length > 0,
    staleTime: 30_000,
    retry: false,
    queryFn: ({ signal }) => searchAll(text!, kinds, signal),
  });

  const groups = useMemo(() => (results.data && text !== null ? buildGroups(results.data, kinds) : []), [results.data, text, kinds]);
  const items = useMemo(() => flatItems(groups), [groups]);
  // New results: nothing highlighted (Enter still opens the first row).
  useEffect(() => setActive(-1), [items]);

  if (kinds.length === 0) return null;

  const waiting = typed !== null && (typed !== text || results.isPending);
  const showList = open && typed !== null;
  const allFailed = !waiting && groups.length > 0 && groups.every((g) => g.failed);
  const noMatches = !waiting && results.isSuccess && groups.length === 0;
  const placeholder = `Search ${SEARCH_GROUPS.filter((g) => kinds.includes(g.kind))
    .map((g) => g.label.toLowerCase())
    .join(", ")}…`;

  function go(item: SearchItem): void {
    setOpen(false);
    setValue("");
    inputRef.current?.blur();
    if (item.kind === "chats") void navigate({ to: "/inbox/$conversationId", params: { conversationId: item.id } });
    else if (item.kind === "contacts") void navigate({ to: "/contacts/$customerId", params: { customerId: item.id } });
    else void navigate({ to: "/posts/$postId", params: { postId: item.id } });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((i) => moveIndex(i, e.key === "ArrowDown" ? 1 : -1, items.length));
    } else if (e.key === "Enter") {
      if (!showList || waiting || items.length === 0) return;
      e.preventDefault();
      go(items[Math.max(active, 0)]!);
    } else if (e.key === "Escape") {
      if (open && typed !== null) {
        e.preventDefault();
        setOpen(false);
      } else if (value) {
        e.preventDefault();
        setValue("");
      } else {
        inputRef.current?.blur();
      }
    }
  }

  function onOptionClick(e: MouseEvent<HTMLAnchorElement>, item: SearchItem): void {
    // A new tab or window (⌘/Ctrl/Shift-click, middle button) is left to the browser.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    go(item);
  }

  const activeItem = showList && active >= 0 ? items[active] : undefined;
  const status = waiting
    ? "Searching…"
    : allFailed
      ? "Search isn't working right now. Try again in a moment."
      : noMatches
        ? `No matches for “${typed}”`
        : items.length
          ? `${items.length} ${items.length === 1 ? "result" : "results"}`
          : "";

  return (
    <div className="suite-find">
      <label className="suite-search">
        <Search size={16} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          placeholder={placeholder}
          aria-label="Search"
          aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={activeItem ? optionId(activeItem) : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_LENGTH}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        <span className="suite-kbd" aria-hidden="true">
          {isMac ? "⌘K" : "Ctrl K"}
        </span>
      </label>

      <div
        className="suite-find__panel"
        hidden={!showList}
        // Clicking inside the dropdown must not take focus from the box (that would close it).
        onMouseDown={(e) => e.preventDefault()}
      >
        <div id={listId} role="listbox" aria-label="Search results" className="suite-find__list">
          {!waiting &&
            groups.map((g) => {
              const Icon = ICONS[g.kind];
              const headId = `${listId}-${g.kind}`;
              return (
                <div key={g.kind} role="group" aria-labelledby={headId} className="suite-find__group">
                  <div id={headId} className="suite-find__head" role="presentation">
                    {g.label}
                  </div>
                  {g.failed ? (
                    <div className="suite-find__note" role="presentation">
                      Couldn't search {g.label.toLowerCase()}. Try again in a moment.
                    </div>
                  ) : (
                    g.items.map((item) => {
                      const selected = activeItem === item;
                      return (
                        <a
                          key={item.id}
                          id={optionId(item)}
                          href={item.href}
                          role="option"
                          aria-selected={selected}
                          tabIndex={-1}
                          className={`suite-find__item${selected ? " is-active" : ""}`}
                          onMouseMove={() => setActive(items.indexOf(item))}
                          onClick={(e) => onOptionClick(e, item)}
                        >
                          <span className="suite-find__icon" aria-hidden="true">
                            <Icon size={15} strokeWidth={1.9} />
                          </span>
                          <span className="suite-find__text">
                            <b>{item.title}</b>
                            {item.detail ? <span>{item.detail}</span> : null}
                          </span>
                        </a>
                      );
                    })
                  )}
                </div>
              );
            })}
        </div>
        {(waiting || noMatches || allFailed) && (
          <div className="suite-find__empty" aria-hidden="true">
            {waiting ? "Searching…" : allFailed ? "Search isn't working right now. Try again in a moment." : (
              <>
                <b>No matches</b>
                <span>Nothing found for “{typed}”. Check the spelling, or try a phone number.</span>
              </>
            )}
          </div>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {showList ? status : ""}
      </span>
    </div>
  );
}

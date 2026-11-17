/**
 * Inbox list state that must survive navigation. /inbox and /inbox/:id are
 * separate routes, so the page remounts when a conversation opens; keeping the
 * tab, filters, search and list scroll here means coming back to the list
 * (especially on a phone) lands exactly where the person left it.
 */
import { create } from "zustand";
import type { InboxTabKey } from "./inbox-logic.js";

const TAB_KEY = "ms_inbox_tab";

function readTab(): InboxTabKey {
  try {
    return (localStorage.getItem(TAB_KEY) as InboxTabKey | null) ?? "mine";
  } catch {
    return "mine";
  }
}

interface InboxUiState {
  tab: InboxTabKey;
  number: string;
  label: string;
  search: string;
  listScroll: number;
  setTab: (t: InboxTabKey) => void;
  setNumber: (n: string) => void;
  setLabel: (l: string) => void;
  setSearch: (s: string) => void;
  setListScroll: (y: number) => void;
}

export const useInboxUi = create<InboxUiState>((update) => ({
  tab: readTab(),
  number: "",
  label: "",
  search: "",
  listScroll: 0,
  setTab: (tab) => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* private mode — fine */
    }
    update({ tab, listScroll: 0 });
  },
  setNumber: (number) => update({ number, listScroll: 0 }),
  setLabel: (label) => update({ label, listScroll: 0 }),
  setSearch: (search) => update({ search }),
  setListScroll: (listScroll) => update({ listScroll }),
}));

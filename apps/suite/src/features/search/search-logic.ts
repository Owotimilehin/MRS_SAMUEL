/**
 * Pure rules for the top-bar search (chats, contacts, posts). No React in here.
 *
 * The search itself runs on the server, through the list endpoints each page
 * already uses; this file decides what to ask for, who may see which group,
 * how a row reads, and where the keyboard highlight goes.
 */
import { contactPhoneDigits, type Capability } from "@ms/shared";
import { captionStart, statusLabel, timeLine } from "../posts/posts-logic.js";

/** Fewer letters than this and nothing is searched. */
export const MIN_CHARS = 2;
/** Results shown in each group. */
export const PER_GROUP = 5;
/** How long typing must pause before a search starts. */
export const DEBOUNCE_MS = 250;

export type SearchKind = "chats" | "contacts" | "posts";

/** The groups in the order shown, with the permission each needs. */
export const SEARCH_GROUPS: readonly { kind: SearchKind; label: string; cap: Capability }[] = [
  { kind: "chats", label: "Chats", cap: "inbox.view" },
  { kind: "contacts", label: "Contacts", cap: "contacts.view" },
  { kind: "posts", label: "Posts", cap: "social.publish" },
];

/** The groups this person may search, in display order. */
export function allowedKinds(capabilities: readonly string[]): SearchKind[] {
  return SEARCH_GROUPS.filter((g) => capabilities.includes(g.cap)).map((g) => g.kind);
}

/** Typed text that is only a phone number: digits with spaces, dashes, dots, brackets or a leading +. */
export function looksLikePhone(text: string): boolean {
  const t = text.trim();
  return /^\+?[\d\s().-]+$/.test(t) && t.replace(/\D/g, "").length >= 4;
}

/** The text to search, or null when it is too short. */
export function searchText(raw: string): string | null {
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length >= MIN_CHARS ? t : null;
}

/**
 * What the Inbox list is asked for. Its phone match is "these digits appear in
 * the stored number", and numbers are stored as +234…, so a phone typed as
 * 0803… or 234803… is sent as the digits after the 0 or 234 (contactPhoneDigits,
 * the same rule the Contacts search uses). Anything else is sent as typed.
 */
export function inboxQuery(text: string): string {
  return looksLikePhone(text) ? contactPhoneDigits(text) || text : text;
}

/** One row in the dropdown. */
export interface SearchItem {
  kind: SearchKind;
  id: string;
  title: string;
  detail: string;
  href: string;
}

export interface SearchGroup {
  kind: SearchKind;
  label: string;
  items: SearchItem[];
  /** True when this group's search failed (the others still show). */
  failed: boolean;
}

// The fields of each list's rows that the dropdown reads.
export interface ChatHit {
  id: string;
  customer_name: string | null;
  customer_phone: string | null;
  identity_name?: string | null;
  preview: string | null;
  number_label?: string | null;
}
export interface ContactHit {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  handles: string[];
}
export interface PostHit {
  id: string;
  caption: string;
  status: string;
  scheduled_at: string | null;
  updated_at: string;
  targets: { published_at: string | null; caption_override?: string | null }[];
}

const enc = encodeURIComponent;

export function chatItem(c: ChatHit): SearchItem {
  const who = c.customer_name?.trim() || c.identity_name?.trim() || c.customer_phone || "Unknown customer";
  const preview = c.preview?.replace(/\s+/g, " ").trim();
  const phone = c.customer_phone && c.customer_phone !== who ? c.customer_phone : null;
  return {
    kind: "chats",
    id: c.id,
    title: who,
    detail: [phone, preview || c.number_label || null].filter(Boolean).join(" · ") || "No messages yet",
    href: `/inbox/${enc(c.id)}`,
  };
}

export function contactItem(c: ContactHit): SearchItem {
  const title = c.name?.trim() || c.phone || c.email || c.handles[0] || "No name";
  const detail = [c.phone, c.email, c.handles[0]].filter((x): x is string => !!x && x !== title);
  return { kind: "contacts", id: c.id, title, detail: detail.slice(0, 2).join(" · "), href: `/contacts/${enc(c.id)}` };
}

export function postItem(p: PostHit): SearchItem {
  return {
    kind: "posts",
    id: p.id,
    title: captionStart(p.caption, 70),
    detail: `${statusLabel(p.status)} · ${timeLine(p)}`,
    href: `/posts/${enc(p.id)}`,
  };
}

/**
 * True when a post's text holds the words. The server already filters; this
 * keeps the dropdown right if it is talking to an API that does not know `q` yet.
 */
export function postMatches(p: { caption: string; targets: { caption_override?: string | null }[] }, text: string): boolean {
  const needle = text.toLowerCase();
  return [p.caption, ...p.targets.map((t) => t.caption_override ?? "")].some((s) => s.toLowerCase().includes(needle));
}

export interface RawResults {
  chats?: ChatHit[] | Error;
  contacts?: ContactHit[] | Error;
  posts?: PostHit[] | Error;
}

/**
 * The groups to show: only kinds the person may search, in display order, at
 * most PER_GROUP rows each. Empty groups are left out; a failed one stays so
 * the dropdown can say so.
 */
export function buildGroups(raw: RawResults, kinds: readonly SearchKind[]): SearchGroup[] {
  const out: SearchGroup[] = [];
  for (const g of SEARCH_GROUPS) {
    if (!kinds.includes(g.kind)) continue;
    const r = raw[g.kind];
    if (r === undefined) continue;
    if (r instanceof Error) {
      out.push({ kind: g.kind, label: g.label, items: [], failed: true });
      continue;
    }
    const items =
      g.kind === "chats"
        ? (r as ChatHit[]).map(chatItem)
        : g.kind === "contacts"
          ? (r as ContactHit[]).map(contactItem)
          : (r as PostHit[]).map(postItem);
    if (items.length) out.push({ kind: g.kind, label: g.label, items: items.slice(0, PER_GROUP), failed: false });
  }
  return out;
}

/** Every row, top to bottom, as the keyboard walks them. */
export function flatItems(groups: readonly SearchGroup[]): SearchItem[] {
  return groups.flatMap((g) => g.items);
}

/**
 * The highlighted row after an arrow key. -1 means none. Down from none goes to
 * the first row, up from none to the last; both wrap round.
 */
export function moveIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** A stable element id for a row, for aria-activedescendant. */
export function optionId(item: Pick<SearchItem, "kind" | "id">): string {
  return `suite-search-${item.kind}-${item.id}`;
}

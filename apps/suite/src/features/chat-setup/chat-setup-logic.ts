/** Pure rules for the chat set-up screen (suite spec 04, section 7). No React in here. */
import { EMPTY_CHAT_SETUP, normaliseChatSetup, type ChatSetupConfig } from "@ms/shared";
import type { ChatSetupView, SetupStatus } from "./chat-setup-api.js";

type Kind = "messenger" | "instagram";

/** A time such as "14:05", in Lagos. */
export function lagosClock(iso: string | Date): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Lagos" }).format(
    typeof iso === "string" ? new Date(iso) : iso,
  );
}

/** "20 Nov 2026, 14:05", in Lagos. */
export function lagosDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Lagos",
  }).format(new Date(iso));
}

export function sameConfig(a: ChatSetupConfig, b: ChatSetupConfig, kind: Kind = "messenger"): boolean {
  return JSON.stringify(normaliseChatSetup(a, kind)) === JSON.stringify(normaliseChatSetup(b, kind));
}

export type DiffCell =
  | { kind: "text"; text: string | null }
  | { kind: "flag"; on: boolean }
  | { kind: "list"; items: string[] };

export interface DiffRow {
  key: "greeting" | "getStarted" | "iceBreakers" | "menu";
  label: string;
  now: DiffCell;
  after: DiffCell;
}

const menuLines = (c: ChatSetupConfig): string[] =>
  c.menu.map((m) => (m.type === "web_url" ? `${m.title} → ${m.url ?? ""}` : m.title));

/** The parts that change between what is live (null = nothing) and what will be published. Unchanged parts are left out. */
export function diffSetup(live: ChatSetupConfig | null, draft: ChatSetupConfig, kind: Kind = "messenger"): DiffRow[] {
  const a = normaliseChatSetup(live ?? EMPTY_CHAT_SETUP, kind);
  const b = normaliseChatSetup(draft, kind);
  const rows: DiffRow[] = [];
  if (a.greeting !== b.greeting) {
    rows.push({ key: "greeting", label: "Welcome text", now: { kind: "text", text: a.greeting }, after: { kind: "text", text: b.greeting } });
  }
  if (a.getStarted !== b.getStarted) {
    rows.push({ key: "getStarted", label: "Get started button", now: { kind: "flag", on: a.getStarted }, after: { kind: "flag", on: b.getStarted } });
  }
  if (JSON.stringify(a.iceBreakers) !== JSON.stringify(b.iceBreakers)) {
    rows.push({ key: "iceBreakers", label: "Starter questions", now: { kind: "list", items: a.iceBreakers }, after: { kind: "list", items: b.iceBreakers } });
  }
  if (JSON.stringify(menuLines(a)) !== JSON.stringify(menuLines(b)) || a.menu.some((m, i) => m.type !== b.menu[i]?.type)) {
    rows.push({ key: "menu", label: "Menu", now: { kind: "list", items: menuLines(a) }, after: { kind: "list", items: menuLines(b) } });
  }
  return rows;
}

export interface PreviewModel {
  /** The welcome text with {{user_first_name}} shown as "Ada"; null when none. */
  greeting: string | null;
  /** Starter questions as chips. */
  chips: string[];
  /** A Get started button, shown only when there are no questions (they win: G6). */
  getStartedButton: boolean;
  /** Nothing to show before the first message. */
  empty: boolean;
  menu: { title: string; isLink: boolean }[];
}

export function previewModel(config: ChatSetupConfig, kind: Kind): PreviewModel {
  const c = normaliseChatSetup(config, kind);
  const messenger = kind === "messenger";
  const greeting = messenger && c.greeting ? c.greeting.split("{{user_first_name}}").join("Ada") : null;
  const chips = c.iceBreakers;
  const getStartedButton = messenger && c.getStarted && chips.length === 0;
  return {
    greeting,
    chips,
    getStartedButton,
    empty: !greeting && chips.length === 0 && !getStartedButton,
    menu: c.menu.map((m) => ({ title: m.title, isLink: m.type === "web_url" })),
  };
}

/** Why Publish is switched off, in the words shown beside it; null when it may be pressed. */
export function publishBlockedReason(args: {
  view: Pick<ChatSetupView, "account" | "live" | "can_publish_at">;
  config: ChatSetupConfig;
  problems: number;
  now: Date;
}): string | null {
  const { view, config, problems, now } = args;
  if (!view.account.is_active) return "This account is switched off in Channels.";
  if (problems > 0) return "Fix the problems above first.";
  if (!view.live) return "We need to read the live set-up first. Press Check now.";
  if (diffSetup(view.live.config, config, view.account.kind).length === 0 && view.live.other_locales.length === 0) {
    return "Nothing to publish.";
  }
  if (view.can_publish_at && new Date(view.can_publish_at).getTime() > now.getTime()) {
    return `You can publish again at ${lagosClock(view.can_publish_at)}.`;
  }
  return null;
}

/** What the editors start from: the draft; else a version that did not go through; else what is live. */
export function editorStart(view: ChatSetupView): ChatSetupConfig {
  if (view.draft) return view.draft.config;
  const last = view.last_publish;
  if (last && (last.status === "failed" || last.status === "unknown")) return last.config;
  return view.live?.config ?? EMPTY_CHAT_SETUP;
}

export type StripTone = "ok" | "warn" | "bad" | "note";
export interface StripItem {
  tone: StripTone;
  text: string;
  /** "check" = the Check now link; "retry" = the Try again button. */
  action?: "check" | "retry";
}

/** The status strip: the main line first, then the grey notes (section 7). */
export function statusStrip(view: ChatSetupView, dirty: boolean): StripItem[] {
  const out: StripItem[] = [];
  const last = view.last_publish;
  if (!view.account.is_active) {
    out.push({ tone: "warn", text: "This account is switched off in Channels." });
  }
  if (view.live_error) {
    out.push({ tone: "bad", text: `We could not read the set-up from Meta. ${view.live_error}`, action: "check" });
  } else if (last?.status === "failed") {
    out.push({ tone: "bad", text: `The last publish did not go through. ${last.error_message ?? ""}`.trim(), action: "retry" });
  } else if (last?.status === "unknown") {
    out.push({ tone: "warn", text: "We can't tell if the last publish went through. Press Check now.", action: "check" });
  } else if (dirty || view.draft_differs_from_live) {
    out.push({ tone: "warn", text: "You have changes that are not published yet." });
  } else if (view.live) {
    out.push({
      tone: "ok",
      text: `This is what customers see now. Last checked ${lagosClock(view.live.read_at)}.`,
      action: "check",
    });
  }
  out.push(...liveNotes(view));
  return out;
}

/** The grey notes about what publishing replaces (also shown in the publish dialog). */
export function liveNotes(view: Pick<ChatSetupView, "live">): StripItem[] {
  const live = view.live;
  if (!live) return [];
  const out: StripItem[] = [];
  if (live.other_locales.length > 0) {
    out.push({
      tone: "note",
      text: `This account also has set-up in other languages (${live.other_locales.join(", ")}). Publishing from here replaces all of them with one version.`,
    });
  }
  if (live.foreign_payloads) {
    out.push({
      tone: "note",
      text: "Some buttons were set up outside the suite. Publishing replaces them. If another tool answers those buttons, it will stop getting the taps.",
    });
  }
  if (live.composer_disabled) {
    out.push({ tone: "note", text: "The message box is switched off for customers on this Page. Publishing from here switches it back on." });
  }
  return out;
}

const STATUS_WORDS: Record<SetupStatus, string> = {
  live: "Published",
  superseded: "Replaced",
  failed: "Failed",
  unknown: "Not confirmed",
  pushing: "Publishing",
};
export const statusWord = (s: SetupStatus): string => STATUS_WORDS[s];

/** Move item `i` up (-1) or down (+1); out-of-range moves change nothing. */
export function moveItem<T>(list: readonly T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
  const copy = [...list];
  [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  return copy;
}

/** What each of the three editors is given. */
export interface EditorProps {
  config: ChatSetupConfig;
  onChange: (next: ChatSetupConfig) => void;
  kind: Kind;
  disabled: boolean;
  /** Problems from validateChatSetup, for the whole screen. */
  problems: { field: string; message: string }[];
  /** Fields the person has already left (messages show after the first blur). */
  touched: ReadonlySet<string>;
  onTouch: (field: string) => void;
}

/** The messages to show under a field: only after the person has left it. */
export function shownProblems(
  problems: { field: string; message: string }[],
  touched: ReadonlySet<string>,
  field: string,
): string[] {
  if (!touched.has(field)) return [];
  return problems.filter((p) => p.field === field).map((p) => p.message);
}

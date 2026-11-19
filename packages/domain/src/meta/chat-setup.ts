/**
 * Chat set-up for Messenger and Instagram (suite spec 04): the Messenger Profile
 * API (welcome text, Get started button, starter questions, persistent menu).
 *
 * One API serves both channels; it is called with the Page access token. Nothing
 * here stores, logs or returns a token. A publish is always a deliberate action by
 * a person (foundation rule 7); this file never runs on a timer.
 *
 * The pure functions come first (Meta's shape <-> ours, the plan of calls); the
 * Graph calls and publishChatSetup follow.
 */
import {
  CHAT_SETUP_LIMITS,
  CHAT_SETUP_PAYLOAD,
  describeChatSetupPayload,
  type ChatSetupConfig,
  type ChatSetupMenuItem,
} from "@ms/shared";

export type ProfileKind = "messenger" | "instagram";

export interface LiveProfile {
  get_started?: { payload: string };
  greeting?: { locale: string; text: string }[];
  ice_breakers?: { locale?: string; call_to_actions?: { question: string; payload: string }[] }[];
  persistent_menu?: {
    locale: string;
    composer_input_disabled?: boolean;
    call_to_actions: { type: string; title: string; payload?: string; url?: string }[];
  }[];
}

/** The only four properties this feature ever reads, sets or deletes (rule R5). */
export const PROFILE_FIELDS = ["get_started", "greeting", "ice_breakers", "persistent_menu"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** The properties that exist for a kind (Instagram has no welcome text or Get started: N3). */
export function profileFieldsFor(kind: ProfileKind): ProfileField[] {
  return kind === "messenger" ? [...PROFILE_FIELDS] : ["ice_breakers", "persistent_menu"];
}

/** The entry for the default locale, or the first entry when none is marked. */
function defaultEntry<T extends { locale?: string }>(list: T[] | undefined): T | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.find((e) => e?.locale === "default") ?? list[0];
}

function otherLocalesOf(list: { locale?: string }[] | undefined): string[] {
  if (!Array.isArray(list) || list.length === 0) return [];
  const def = defaultEntry(list);
  return list.filter((e) => e !== def).map((e) => e?.locale ?? "unknown");
}

/** Meta's shape -> ours, plus what we could not represent. Pure. */
export function profileToConfig(
  live: LiveProfile,
  kind: ProfileKind,
): { config: ChatSetupConfig; otherLocales: string[]; foreignPayloads: boolean; composerDisabled: boolean } {
  const L = CHAT_SETUP_LIMITS;
  let foreignPayloads = false;
  const foreign = (payload: unknown) => {
    if (describeChatSetupPayload(typeof payload === "string" ? payload : null) === null) foreignPayloads = true;
  };

  const locales = new Set<string>();
  const note = (list: { locale?: string }[] | undefined) => otherLocalesOf(list).forEach((l) => locales.add(l));

  let greeting: string | null = null;
  let getStarted = false;
  if (kind === "messenger") {
    note(live.greeting);
    const g = defaultEntry(live.greeting);
    greeting = typeof g?.text === "string" && g.text.length > 0 ? g.text : null;
    if (live.get_started) {
      getStarted = true;
      foreign(live.get_started.payload);
    }
  }

  note(live.ice_breakers);
  const ice = defaultEntry(live.ice_breakers);
  const questions = (ice?.call_to_actions ?? []).filter((q) => typeof q?.question === "string");
  questions.forEach((q) => foreign(q.payload));
  const iceBreakers = questions.map((q) => q.question).slice(0, L.iceBreakerCount);

  note(live.persistent_menu);
  const menuEntry = defaultEntry(live.persistent_menu);
  const composerDisabled = kind === "messenger" && menuEntry?.composer_input_disabled === true;
  const menu: ChatSetupMenuItem[] = [];
  for (const item of menuEntry?.call_to_actions ?? []) {
    if (item?.type === "postback") {
      foreign(item.payload);
      menu.push({ type: "postback", title: item.title ?? "" });
    } else if (item?.type === "web_url") {
      menu.push({ type: "web_url", title: item.title ?? "", url: item.url ?? "" });
    } else {
      foreignPayloads = true;
    }
  }
  if (menu.length > L.menuCount) menu.length = L.menuCount;

  return {
    config: { greeting, getStarted, iceBreakers, menu },
    otherLocales: [...locales],
    foreignPayloads,
    composerDisabled,
  };
}

/** Ours -> Meta's properties for the default locale. Pure. */
export function configToProfile(config: ChatSetupConfig, kind: ProfileKind): LiveProfile {
  const out: LiveProfile = {};
  if (kind === "messenger") {
    if (config.greeting !== null && config.greeting !== "") out.greeting = [{ locale: "default", text: config.greeting }];
    if (config.getStarted || config.menu.length > 0) out.get_started = { payload: CHAT_SETUP_PAYLOAD.start };
  }
  if (config.iceBreakers.length > 0) {
    out.ice_breakers = [
      {
        locale: "default",
        call_to_actions: config.iceBreakers.map((q, i) => ({ question: q, payload: CHAT_SETUP_PAYLOAD.ice(i + 1) })),
      },
    ];
  }
  if (config.menu.length > 0) {
    const call_to_actions = config.menu.map((m, i) => {
      if (m.type === "postback") {
        return { type: "postback", title: m.title, payload: CHAT_SETUP_PAYLOAD.menu(i + 1) };
      }
      return kind === "messenger"
        ? { type: "web_url", title: m.title, url: m.url ?? "", webview_height_ratio: "full" }
        : { type: "web_url", title: m.title, url: m.url ?? "" };
    });
    out.persistent_menu =
      kind === "messenger"
        ? [{ locale: "default", composer_input_disabled: false, call_to_actions }]
        : [{ locale: "default", call_to_actions }];
  }
  return out;
}

/** Is this property set at Meta (present and not empty)? */
function isPresent(live: LiveProfile, field: ProfileField): boolean {
  const v = live[field];
  if (v === undefined || v === null) return false;
  return Array.isArray(v) ? v.length > 0 : true;
}

/** What a default-locale entry says, reduced to the parts we compare. */
function comparable(live: LiveProfile, kind: ProfileKind) {
  const g = defaultEntry(live.greeting);
  const ice = defaultEntry(live.ice_breakers);
  const menu = defaultEntry(live.persistent_menu);
  return {
    greeting: kind === "messenger" ? (g?.text ?? null) : null,
    getStarted: kind === "messenger" ? (live.get_started ? (live.get_started.payload ?? "") : null) : null,
    ice: (ice?.call_to_actions ?? []).map((q) => [q.question, q.payload]),
    menu: (menu?.call_to_actions ?? []).map((m) => [m.type, m.title, m.payload ?? null, m.type === "web_url" ? (m.url ?? null) : null]),
    composerDisabled: kind === "messenger" && menu?.composer_input_disabled === true,
  };
}

/** True when Meta's live state is what `config` asks for (default locale only). Pure. */
export function liveMatches(config: ChatSetupConfig, live: LiveProfile, kind: ProfileKind): boolean {
  const want = comparable(configToProfile(config, kind), kind);
  const have = comparable(live, kind);
  return JSON.stringify({ ...want, composerDisabled: false }) === JSON.stringify({ ...have, composerDisabled: have.composerDisabled });
}

export interface PlanStep {
  op: "delete" | "set";
  fields: string[];
  body: Record<string, unknown>;
}

/** The ordered calls a publish must make, given what is live. Pure. */
export function planPublish(config: ChatSetupConfig, live: LiveProfile, kind: ProfileKind): PlanStep[] {
  if (liveMatches(config, live, kind) && profileToConfig(live, kind).otherLocales.length === 0) return [];

  const desired = configToProfile(config, kind);
  const fields = profileFieldsFor(kind);
  const plan: PlanStep[] = [];

  // Delete first: every property that is live and no longer wanted.
  const toDelete = fields.filter((f) => isPresent(live, f) && !isPresent(desired, f));
  if (toDelete.includes("get_started") && isPresent(live, "persistent_menu") && !toDelete.includes("persistent_menu")) {
    // Meta refuses to drop Get started while a menu exists (G10, G13): the menu always goes with it.
    toDelete.push("persistent_menu");
  }
  if (toDelete.includes("get_started") && isPresent(desired, "persistent_menu")) {
    throw new Error("A menu needs the Get started button: cannot delete get_started and set a menu");
  }
  if (toDelete.length > 0) {
    plan.push({ op: "delete", fields: PROFILE_FIELDS.filter((f) => toDelete.includes(f)), body: { fields: PROFILE_FIELDS.filter((f) => toDelete.includes(f)) } });
  }

  // Set A: everything except a menu that Meta might refuse because Get started is not set yet.
  const menuWithA = isPresent(desired, "persistent_menu") && (kind === "instagram" || isPresent(live, "get_started"));
  const a: Record<string, unknown> = {};
  for (const f of ["greeting", "get_started", "ice_breakers"] as const) {
    if (fields.includes(f) && isPresent(desired, f)) a[f] = desired[f];
  }
  if (menuWithA) a.persistent_menu = desired.persistent_menu;
  if (Object.keys(a).length > 0) plan.push({ op: "set", fields: Object.keys(a), body: a });

  // Set B: the menu on its own, after Get started exists (G10, G12).
  if (kind === "messenger" && isPresent(desired, "persistent_menu") && !menuWithA) {
    plan.push({ op: "set", fields: ["persistent_menu"], body: { persistent_menu: desired.persistent_menu } });
  }
  return plan;
}


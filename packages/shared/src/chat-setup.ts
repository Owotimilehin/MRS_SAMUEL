/**
 * Chat set-up postback payloads (suite spec 04, section 5.6; foundation ruling 9.2.9).
 *
 * Spec 02 needs describeChatSetupPayload to name a tap in the Inbox, so it is
 * built here first with spec 04's exact signature and pattern. Spec 04 adds
 * the rest of this file (config types, limits, validate, normalise).
 */

export interface ChatSetupMenuItem {
  type: "postback" | "web_url";
  title: string;
  url?: string;
}

export interface ChatSetupConfig {
  /** Messenger only. null = no welcome text. */
  greeting: string | null;
  /** Messenger only. Show the Get started button. Forced on when a menu exists (G10). */
  getStarted: boolean;
  /** Starter questions, in order. 0 to 4. */
  iceBreakers: string[];
  /** Menu buttons, in order. 0 to 5. */
  menu: ChatSetupMenuItem[];
}

export const EMPTY_CHAT_SETUP: ChatSetupConfig = { greeting: null, getStarted: false, iceBreakers: [], menu: [] };

export const CHAT_SETUP_LIMITS = {
  greetingMax: 160,
  iceBreakerCount: 4,
  iceBreakerMax: 80,
  menuCount: 5,
  menuTitleMax: 30,
  urlMax: 500,
} as const;

/** The payload strings chat set-up publishes. Positions are 1-based at publish time. */
export const CHAT_SETUP_PAYLOAD = {
  start: "ms:v1:start",
  ice: (n: number) => `ms:v1:ice:${n}`,
  menu: (n: number) => `ms:v1:menu:${n}`,
} as const;

const PAYLOAD_RE = /^ms:v1:(start|ice:([1-4])|menu:([1-9]|1[0-9]|20))$/;

/** What a postback payload means, or null when it is not one of ours. */
export function describeChatSetupPayload(
  payload: string | null | undefined,
): { source: "get_started" | "ice_breaker" | "menu"; index: number | null; caption: string; fallbackTitle: string } | null {
  if (typeof payload !== "string") return null;
  const m = PAYLOAD_RE.exec(payload);
  if (!m) return null;
  if (m[1] === "start") return { source: "get_started", index: null, caption: "Tapped Get started", fallbackTitle: "Get started" };
  if (m[2]) {
    const n = Number(m[2]);
    return { source: "ice_breaker", index: n, caption: "Tapped a starter question", fallbackTitle: `Starter question ${n}` };
  }
  const n = Number(m[3]);
  return { source: "menu", index: n, caption: "Tapped a menu button", fallbackTitle: `Menu button ${n}` };
}

export type ChatSetupKind = "messenger" | "instagram";

const FIRST_NAME = "{{user_first_name}}";

function validUrl(u: string | undefined): boolean {
  if (!u || u.length > CHAT_SETUP_LIMITS.urlMax || !u.startsWith("https://")) return false;
  try {
    return new URL(u).protocol === "https:" && new URL(u).hostname.length > 0;
  } catch {
    return false;
  }
}

/** Problems a person must fix, in plain English. Empty array = valid. */
export function validateChatSetup(config: ChatSetupConfig, kind: ChatSetupKind): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  const L = CHAT_SETUP_LIMITS;
  if (kind === "messenger" && config.greeting !== null) {
    if ([...config.greeting].length > L.greetingMax) {
      out.push({ field: "greeting", message: `The welcome text is too long. Keep it to ${L.greetingMax} characters.` });
    }
    const tokens = config.greeting.match(/\{\{[^}]*\}\}/g) ?? [];
    if (tokens.some((t) => t !== FIRST_NAME)) {
      out.push({ field: "greeting", message: "Only {{user_first_name}} can be used to insert the customer's name." });
    }
  }
  if (config.iceBreakers.length > L.iceBreakerCount) {
    out.push({ field: "iceBreakers", message: `You can have up to ${L.iceBreakerCount} starter questions.` });
  }
  const seen = new Map<string, number>();
  config.iceBreakers.forEach((q, i) => {
    const n = i + 1;
    if ([...q].length > L.iceBreakerMax) {
      out.push({ field: `iceBreakers.${i}`, message: `Starter question ${n} is too long. Keep it to ${L.iceBreakerMax} characters.` });
    }
    const key = q.trim().toLowerCase();
    if (!key) return;
    const first = seen.get(key);
    if (first !== undefined) {
      out.push({ field: `iceBreakers.${i}`, message: `Starter questions ${first} and ${n} are the same.` });
    } else {
      seen.set(key, n);
    }
  });
  if (config.menu.length > L.menuCount) {
    out.push({ field: "menu", message: `The menu can have up to ${L.menuCount} buttons.` });
  }
  config.menu.forEach((m, i) => {
    const n = i + 1;
    const title = m.title.trim();
    if (!title || [...title].length > L.menuTitleMax) {
      out.push({ field: `menu.${i}.title`, message: `Menu button ${n} needs a name of 1 to ${L.menuTitleMax} characters.` });
    }
    if (m.type === "web_url" && !validUrl(m.url)) {
      out.push({ field: `menu.${i}.url`, message: `Menu button ${n} needs a link that starts with https://` });
    }
  });
  return out;
}

/** Trim, drop empty questions, force getStarted when a menu exists (messenger), clear greeting/getStarted for instagram. */
export function normaliseChatSetup(config: ChatSetupConfig, kind: ChatSetupKind): ChatSetupConfig {
  const greetingTrim = typeof config.greeting === "string" ? config.greeting.trim() : "";
  const menu: ChatSetupMenuItem[] = config.menu.map((m) =>
    m.type === "web_url"
      ? { type: "web_url", title: m.title.trim(), url: (m.url ?? "").trim() }
      : { type: "postback", title: m.title.trim() },
  );
  const iceBreakers = config.iceBreakers.map((q) => q.trim()).filter((q) => q.length > 0);
  if (kind === "instagram") return { greeting: null, getStarted: false, iceBreakers, menu };
  return {
    greeting: greetingTrim ? greetingTrim : null,
    getStarted: config.getStarted || menu.length > 0,
    iceBreakers,
    menu,
  };
}

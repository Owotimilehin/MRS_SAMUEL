/**
 * Meta connection health ("Watchdog", blueprint stage 1). The worker checks the
 * Meta connection every hour and keeps the result in one app_settings row (no
 * migration). The API returns it and the suite shows a banner and a dot per
 * channel. Shared so the three say the same thing. Nothing here calls Meta or
 * reads the clock; no token is ever part of it.
 */

/** app_settings key holding a MetaHealthValue. */
export const META_HEALTH_KEY = "meta_connection_health";

export type MetaHealthStatus = "ok" | "warning" | "broken";

/** token = our system-user access key; whatsapp_number / page = one channel row; whatsapp_account = a WABA. */
export type MetaHealthKind = "token" | "whatsapp_number" | "whatsapp_account" | "page";

export interface MetaHealthItem {
  /** "token" | "line:<inbox_phone_number id>" | "waba:<WABA id>". */
  key: string;
  kind: MetaHealthKind;
  /** What staff call it: "WhatsApp +234 803…", the Page label, "Meta access key". */
  label: string;
  /** The inbox_phone_number rows this item affects (all active lines for the token). */
  line_ids: string[];
  status: MetaHealthStatus;
  /** Why, in plain English. */
  reason: string;
  /** What it means for customers, as the start of a sentence ("Customers on WhatsApp are not getting replies"). */
  impact: string;
  /** ISO time the item first had this status. */
  since: string;
  /** ISO time of the last check that reached Meta for this item. */
  checked_at: string;
  /** ISO time the owner was last alerted about this item becoming broken. */
  alerted_at: string | null;
}

export interface MetaHealthValue {
  /** ISO time of the last completed run. */
  checked_at: string | null;
  items: Record<string, MetaHealthItem>;
}

const RANK: Record<MetaHealthStatus, number> = { ok: 0, warning: 1, broken: 2 };

export function worseStatus(a: MetaHealthStatus, b: MetaHealthStatus): MetaHealthStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

/** The worst status among the items ("ok" for none). */
export function worstStatus(items: readonly Pick<MetaHealthItem, "status">[]): MetaHealthStatus {
  return items.reduce<MetaHealthStatus>((w, i) => worseStatus(w, i.status), "ok");
}

/** Items in the order a person should read them: broken first, then warnings, then by label. */
export function sortHealthItems<T extends Pick<MetaHealthItem, "status" | "label" | "kind">>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      RANK[b.status] - RANK[a.status] ||
      Number(b.kind === "token") - Number(a.kind === "token") ||
      a.label.localeCompare(b.label),
  );
}

/** The worst status for one channel row: its own item, its WhatsApp account and the access key. */
export function lineHealth(
  items: readonly MetaHealthItem[],
  lineId: string,
): { status: MetaHealthStatus; reasons: string[] } | null {
  const mine = sortHealthItems(items.filter((i) => i.line_ids.includes(lineId)));
  if (mine.length === 0) return null;
  const status = worstStatus(mine);
  return { status, reasons: mine.filter((i) => i.status !== "ok").map((i) => i.reason) };
}

export interface HealthBanner {
  tone: "danger" | "warning";
  /** One sentence: what it means for customers, then why. */
  text: string;
  /** Changes when the set of problems changes, so a dismissed amber banner comes back for a new one. */
  signature: string;
}

/**
 * The banner under the suite's top bar, or null when everything is fine.
 * Red when anything is broken, amber when something needs attention.
 */
export function healthBanner(items: readonly MetaHealthItem[]): HealthBanner | null {
  const worst = worstStatus(items);
  if (worst === "ok") return null;
  const hit = sortHealthItems(items.filter((i) => i.status === worst));
  const first = hit[0]!;
  const more = hit.length - 1;
  const tail = more > 0 ? `, and ${more} more ${more === 1 ? "connection needs" : "connections need"} attention` : "";
  const reason = first.reason.replace(/[.\s]+$/, "");
  return {
    tone: worst === "broken" ? "danger" : "warning",
    text: `${first.impact}: ${lowerFirst(reason)}${tail}.`,
    signature: hit.map((i) => `${i.key}:${i.status}:${i.reason}`).join("|"),
  };
}

function lowerFirst(s: string): string {
  // Names keep their capital ("Meta", "WhatsApp", "Instagram"...).
  if (/^(Meta|WhatsApp|Instagram|Facebook|Messenger)\b/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

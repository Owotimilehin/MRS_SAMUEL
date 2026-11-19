/** Pure rules for the Catalogue page (suite spec 08, 7.2): labels, order, the one banner, the filters. */
import { ORDER_TEMPLATE_NAMES, type OrderTemplateName } from "@ms/shared";
import type { CatalogueItem, CatalogueStatus, ItemState } from "./catalogue-api.js";

/** The words on the "On WhatsApp" badge. */
export function stateLabel(state: ItemState): string {
  switch (state) {
    case "live":
      return "Live";
    case "pending":
      return "Waiting to send";
    case "sent":
      return "Sent, waiting for Meta";
    case "rejected":
      return "Refused by Meta";
    case "blocked":
      return "Not sent";
    case "removed":
      return "Hidden";
  }
}

export function stateTone(state: ItemState): "success" | "warning" | "danger" | "off" {
  if (state === "live") return "success";
  if (state === "pending" || state === "sent") return "warning";
  if (state === "rejected" || state === "blocked") return "danger";
  return "off";
}

const STATE_ORDER: ItemState[] = ["rejected", "blocked", "pending", "sent", "live", "removed"];

/** Refused and not-sent first, then by name: what needs a person comes to the top. */
export function sortItems<T extends Pick<CatalogueItem, "state" | "title">>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.title.localeCompare(b.title, "en", { sensitivity: "base" }),
  );
}

export type CountFilter = "all" | "live" | "waiting" | "attention" | "hidden";

/** The four counts above the table; each is also a filter. */
export function countChips(counts: Record<ItemState, number>): { key: Exclude<CountFilter, "all">; label: string; n: number }[] {
  return [
    { key: "live", label: "Live", n: counts.live },
    { key: "waiting", label: "Waiting", n: counts.pending + counts.sent },
    { key: "attention", label: "Needs attention", n: counts.rejected + counts.blocked },
    { key: "hidden", label: "Hidden", n: counts.removed },
  ];
}

export function matchesFilter(state: ItemState, filter: CountFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "live":
      return state === "live";
    case "waiting":
      return state === "pending" || state === "sent";
    case "attention":
      return state === "rejected" || state === "blocked";
    case "hidden":
      return state === "removed";
  }
}

export interface Banner {
  tone: "bad" | "warn";
  text: string;
}

/** At most one banner, the first that applies: a configuration problem, then no online branch, then "Meta is busy". */
export function chooseBanner(status: Pick<CatalogueStatus, "link" | "online_branch">): Banner | null {
  const problem = status.link?.problem ?? null;
  if (problem?.kind === "config") {
    return {
      tone: "bad",
      text: `Meta has stopped accepting our updates: ${problem.plain} Nothing will sync until this is fixed.${problem.code ? ` (Meta code ${problem.code})` : ""}`,
    };
  }
  if (status.link && !status.online_branch) {
    return {
      tone: "warn",
      text: "No branch is set to take online orders, so every juice shows as out of stock. Choose one in the shop admin under Branches.",
    };
  }
  if (problem?.kind === "temporary") return { tone: "warn", text: "Meta is busy. We will try again shortly." };
  return null;
}

/** The order-update templates that are missing or not approved, by name. */
export function templatesNotReady(templates: Partial<Record<OrderTemplateName, string>>): OrderTemplateName[] {
  return ORDER_TEMPLATE_NAMES.filter((n) => (templates[n] ?? "missing").toUpperCase() !== "APPROVED");
}

export function stockLabel(availability: CatalogueItem["availability"]): string {
  if (availability === "in stock") return "In stock";
  if (availability === "out of stock") return "Out of stock";
  return "";
}

/** What a person should do about an item that is refused or not sent. */
export function whatToDo(item: Pick<CatalogueItem, "state" | "review_status">): string {
  if (item.state === "blocked") return "Fix it in the shop admin. The suite sends the juice by itself once it is complete.";
  if ((item.review_status ?? "").toLowerCase() === "rejected") {
    return "Open Commerce Manager to see Meta's reason or to ask for another review. Then press Try again.";
  }
  return "Correct the juice in the shop admin, then press Try again.";
}

/** "20 Nov, 2:05 pm" in Lagos time, or a dash. */
export function lagosTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}

/** Is this text a catalogue ID as Meta shows it (numbers only)? */
export function looksLikeCatalogueId(text: string): boolean {
  return /^\d{5,30}$/.test(text.trim());
}

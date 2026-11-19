/**
 * Pure rules for the Ads screens (suite spec 12, section 7): wording and small
 * decisions, with tests beside this file. Nothing here calls the server.
 */
import { money, normaliseTyped, type AdDestination } from "@ms/shared";

const ZONE = "Africa/Lagos";

/** What staff read for an advert's state (7.4). Anything unknown is shown as Meta wrote it, in lower case. */
export function statusLabel(effectiveStatus: string | null | undefined): string {
  switch (effectiveStatus) {
    case "ACTIVE":
      return "Running";
    case "PAUSED":
    case "CAMPAIGN_PAUSED":
    case "ADSET_PAUSED":
      return "Paused";
    case "PENDING_REVIEW":
    case "IN_PROCESS":
      return "Being checked by Meta";
    case "DISAPPROVED":
      return "Rejected by Meta";
    case "WITH_ISSUES":
      return "Has a problem";
    case "ARCHIVED":
    case "DELETED":
      return "Ended";
    default:
      return effectiveStatus ? effectiveStatus.toLowerCase().replace(/_/g, " ") : "Not known";
  }
}

export function statusTone(effectiveStatus: string | null | undefined): "good" | "warn" | "bad" | "muted" {
  if (effectiveStatus === "ACTIVE") return "good";
  if (effectiveStatus === "PENDING_REVIEW" || effectiveStatus === "IN_PROCESS") return "warn";
  if (effectiveStatus === "DISAPPROVED" || effectiveStatus === "WITH_ISSUES") return "bad";
  return "muted";
}

export function destinationLabel(d: AdDestination | "other" | string | null | undefined): string {
  if (d === "whatsapp") return "WhatsApp";
  if (d === "messenger") return "Messenger";
  if (d === "instagram") return "Instagram";
  return "Other";
}

/** "Reported to Meta" for a chat's order (7.6). Blank when reporting is switched off. */
export function reportedLabel(capiStatus: string | null | undefined, note: string | null | undefined, reportingOn: boolean): string {
  if (capiStatus === "sent") return "Yes";
  if (capiStatus === "skipped") return `No — ${note ?? "not reported"}`;
  if (capiStatus === "failed") return `Failed — ${note ?? "Meta refused it"}`;
  if (capiStatus === "unknown") return "Not sure — Meta did not answer";
  if (!reportingOn) return "";
  if (capiStatus === "none" || capiStatus === "queued" || capiStatus === "sending") return "Waiting";
  return "";
}

/** What a person typed, as the server will read it: "₦35,000" and " 35 000 " both give "35000". */
export function parseTyped(input: string): string {
  return normaliseTyped(input);
}

export function outcomeLabel(outcome: string, metaMessage: string | null): string {
  if (outcome === "ok") return "Done";
  if (outcome === "refused") return `Refused by Meta — ${metaMessage ?? "no reason given"}`;
  if (outcome === "blocked") return "Blocked by the cap";
  if (outcome === "unknown") return "No answer from Meta";
  return "In progress";
}

export function outcomeTone(outcome: string): "good" | "warn" | "bad" | "muted" {
  if (outcome === "ok") return "good";
  if (outcome === "refused" || outcome === "blocked") return "bad";
  if (outcome === "unknown") return "warn";
  return "muted";
}

/** Who did it, for the activity log (7.11). */
export function actorLabel(kind: string, name: string | null): string {
  if (kind === "rule") return `Rule: ${name ?? "unnamed"}`;
  if (kind === "safety") return "Safety stop";
  if (kind === "system") return "The suite";
  return name ?? "Staff member";
}

/** "Your daily cap is ₦5,000; ₦2,000 is already running." */
export function capLine(cap: { cap: number; already_committed: number }, currency: string): string {
  return `Your daily cap is ${money(cap.cap, currency)}; ${money(cap.already_committed, currency)} is already running.`;
}

/** One rule in words (7.11). */
export function ruleSentence(
  r: { threshold: number; lookback_days: number; min_spend: number; currency: string; scope_campaign_external_id: string | null },
  advertName: string | null,
): string {
  const days = `${r.lookback_days} ${r.lookback_days === 1 ? "day" : "days"}`;
  const scope = r.scope_campaign_external_id ? (advertName ?? "one advert") : "all adverts made in the suite";
  return `Pause if a chat costs more than ${money(r.threshold, r.currency)} over the last ${days}, once at least ${money(r.min_spend, r.currency)} has been spent — ${scope}`;
}

/** "Thu 19 Nov", Lagos. */
export function shortDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, weekday: "short", day: "numeric", month: "short" }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("weekday")} ${p("day")} ${p("month")}`;
}

/** "Thu 19 Nov, 9:05 am", Lagos. */
export function dateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "numeric", minute: "2-digit", hour12: true }).format(d).toLowerCase();
  return `${shortDay(d)}, ${time}`;
}

/** The inbox line (7.8): Came from an advert: "{headline}" · {Thu 19 Nov}. */
export function sourceLine(source: { headline: string | null; touched_at: string }): string {
  const day = shortDay(source.touched_at);
  return source.headline ? `Came from an advert: "${source.headline}" · ${day}` : `Came from an advert · ${day}`;
}

export type AdsTab = "overview" | "adverts" | "chats" | "rules" | "log" | "settings";

/** The tabs a person sees (7.1): Rules only with the manage-ads permission, Settings only for the owner. */
export function tabsFor(who: { canManage: boolean; isOwner: boolean }): { id: AdsTab; label: string }[] {
  const tabs: { id: AdsTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "adverts", label: "Adverts" },
    { id: "chats", label: "Chats from adverts" },
  ];
  if (who.canManage) tabs.push({ id: "rules", label: "Rules" });
  tabs.push({ id: "log", label: "Activity log" });
  if (who.isOwner) tabs.push({ id: "settings", label: "Settings" });
  return tabs;
}

/** The caption under the spend chart (7.3). */
export function dayZoneCaption(zone: string | null): string {
  if (!zone) return "";
  const base = `Days follow the ad account's clock (${zone}).`;
  return zone === ZONE ? base : `${base} That is not Lagos time, so a day here does not line up exactly with a shop day.`;
}

/** A datetime-local value ("2026-11-23T09:00") read as Lagos time (UTC+1, no daylight saving), as an ISO string. */
export function lagosLocalToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const d = new Date(`${local}:00+01:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The reverse: an ISO time as a datetime-local value in Lagos time. */
export function isoToLagosLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + 3600_000).toISOString().slice(0, 16);
}

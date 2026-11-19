/**
 * "Came from an advert" on the inbox's contact panel (suite spec 12, 7.8).
 *
 * The inbox screens are shared by the admin app and the suite, and the server
 * may not have the ads routes yet, so this is deliberately quiet: one request,
 * no retry, and ANY problem (no such route, no permission, no network, an odd
 * answer) simply means the line is not shown. It never raises an error or a
 * toast, and it never blocks the panel.
 */
import { API_BASE } from "./api.js";

export interface AdSource {
  touched_at: string;
  channel: string;
  headline: string | null;
  ad_name: string | null;
}

/** "Thu 19 Nov" in Lagos time; "" when the time cannot be read. */
function lagosDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", weekday: "short", day: "numeric", month: "short" }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("weekday")} ${p("day")} ${p("month")}`;
}

/** Came from an advert: "{headline}" · {Thu 19 Nov}. Without a headline: Came from an advert · {date}. */
export function adSourceText(source: AdSource): string {
  const day = lagosDay(source.touched_at);
  const head = source.headline?.trim();
  const text = head ? `Came from an advert: "${head}"` : "Came from an advert";
  return day ? `${text} · ${day}` : text;
}

/** The conversation's latest advert tap, or null (also null on every kind of failure). */
export async function fetchAdSource(conversationId: string): Promise<AdSource | null> {
  try {
    const res = await fetch(`${API_BASE}/ads/conversations/${encodeURIComponent(conversationId)}/source`, { credentials: "include" });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown } | null;
    const d = body?.data as Partial<AdSource> | null | undefined;
    if (!d || typeof d !== "object" || typeof d.touched_at !== "string") return null;
    return {
      touched_at: d.touched_at,
      channel: typeof d.channel === "string" ? d.channel : "",
      headline: typeof d.headline === "string" ? d.headline : null,
      ad_name: typeof d.ad_name === "string" ? d.ad_name : null,
    };
  } catch {
    return null;
  }
}

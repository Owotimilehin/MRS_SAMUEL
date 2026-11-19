/**
 * Facebook Page details (suite spec 10, section 5.2): read a Page's public
 * details, change the ones the suite may change, read an Instagram profile.
 *
 * Every call uses the Page access token (never stored, logged or returned).
 * Instagram profiles are read-only: Meta does not let apps change them (G2).
 * Facts marked [unverified] in the spec are not checked against a real Page yet.
 */
import { pageHoursToWeek, weekToPageHours, type PageAddress, type PageEditable } from "@ms/shared";
import { graph, MetaApiError, type MetaConfig } from "../inbox/meta.js";
import type { ChannelAccount } from "./accounts.js";
import { withPageTokenRetry } from "./messaging.js";

export interface PageSnapshot {
  id: string;
  name: string | null;
  username: string | null;
  category: string | null;
  link: string | null;
  is_published: boolean | null;
  verification_status: string | null;
  followers_count: number | null;
  picture_url: string | null;
  cover_url: string | null;
  single_line_address: string | null;
  editable: PageEditable;
}

export interface InstagramProfile {
  id: string;
  username: string | null;
  name: string | null;
  biography: string | null;
  website: string | null;
  profile_picture_url: string | null;
  followers_count: number | null;
  media_count: number | null;
}

const PAGE_FIELDS = [
  "id",
  "name",
  "username",
  "about",
  "description",
  "phone",
  "website",
  "emails",
  "hours",
  "is_always_open",
  "location",
  "single_line_address",
  "category",
  "link",
  "cover",
  "is_published",
  "verification_status",
  "followers_count",
].join(",");

interface GraphPageDetails {
  id?: string;
  name?: string;
  username?: string;
  about?: string;
  description?: string;
  phone?: string;
  website?: string;
  emails?: string[];
  hours?: Record<string, string>;
  is_always_open?: boolean;
  location?: { street?: string; city?: string; state?: string; country?: string; zip?: string };
  single_line_address?: string;
  category?: string;
  link?: string;
  cover?: { source?: string };
  is_published?: boolean;
  verification_status?: string;
  followers_count?: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function addressOf(loc: GraphPageDetails["location"]): PageAddress | null {
  if (!loc) return null;
  const a: PageAddress = {
    street: loc.street?.trim() ?? "",
    city: loc.city?.trim() ?? "",
    state: loc.state?.trim() ?? "",
    country: loc.country?.trim() ?? "",
    zip: loc.zip?.trim() ?? "",
  };
  return a.street === "" && a.city === "" ? null : a;
}

/** The Page's public details as Facebook holds them now (P1, P4). */
export async function readPage(cfg: MetaConfig, account: ChannelAccount): Promise<PageSnapshot> {
  const pageId = account.pageId ?? account.externalId;
  if (!pageId) throw new MetaApiError("This account has no Page", 400, null, false);
  const id = encodeURIComponent(pageId);
  const p = await withPageTokenRetry(cfg, pageId, (token) =>
    graph<GraphPageDetails>(cfg, "GET", `${id}?fields=${PAGE_FIELDS}`, undefined, { token }),
  );
  // The picture is a nice-to-have: a failure here must not hide the details.
  let pictureUrl: string | null = null;
  try {
    const pic = await withPageTokenRetry(cfg, pageId, (token) =>
      graph<{ data?: { url?: string } }>(cfg, "GET", `${id}/picture?redirect=0&type=large`, undefined, { token }),
    );
    pictureUrl = str(pic?.data?.url);
  } catch (err) {
    if (!(err instanceof MetaApiError)) throw err;
  }
  return {
    id: p.id ?? pageId,
    name: str(p.name),
    username: str(p.username),
    category: str(p.category),
    link: str(p.link),
    is_published: typeof p.is_published === "boolean" ? p.is_published : null,
    verification_status: str(p.verification_status),
    followers_count: num(p.followers_count),
    picture_url: pictureUrl,
    cover_url: str(p.cover?.source),
    single_line_address: str(p.single_line_address),
    editable: {
      about: str(p.about),
      description: str(p.description),
      phone: str(p.phone),
      website: str(p.website),
      emails: Array.isArray(p.emails) ? p.emails.filter((e): e is string => typeof e === "string") : [],
      always_open: p.is_always_open === true,
      hours: pageHoursToWeek(p.hours),
      address: addressOf(p.location),
    },
  };
}

/**
 * The tasks the system user holds on a Page (P17), or null when we cannot tell
 * (any error, or the Page is not listed). Uses the system-user token on purpose.
 */
export async function readPageTasks(cfg: MetaConfig, pageId: string): Promise<string[] | null> {
  try {
    let next: string | null = "me/accounts?fields=id,tasks&limit=100";
    for (let i = 0; next && i < 5; i++) {
      const res: { data?: { id?: string; tasks?: string[] }[]; paging?: { next?: string } } = await graph(cfg, "GET", next);
      const hit = (res?.data ?? []).find((p) => p.id === pageId);
      if (hit) return Array.isArray(hit.tasks) ? hit.tasks : null;
      next = res?.paging?.next ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure: our changes into the POST body (5.2). Only keys present in `changes` are
 * mapped, and nothing outside the table is ever emitted (name, username,
 * category_list, cover, is_published stay out whatever it is given).
 */
export function pageUpdateBody(changes: Partial<PageEditable>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const text = (v: string | null | undefined): string => v ?? "";
  if ("about" in changes) body.about = text(changes.about);
  if ("description" in changes) body.description = text(changes.description);
  if ("phone" in changes) body.phone = text(changes.phone);
  if ("website" in changes) body.website = text(changes.website);
  if ("emails" in changes) body.emails = [...(changes.emails ?? [])];
  if ("always_open" in changes) body.is_always_open = changes.always_open === true;
  if (changes.always_open !== true && changes.hours) body.hours = weekToPageHours(changes.hours);
  if ("address" in changes) {
    const a = changes.address;
    body.location = {
      street: a?.street ?? "",
      city: a?.city ?? "",
      state: a?.state ?? "",
      country: a?.country ?? "",
      zip: a?.zip ?? "",
    };
  }
  return body;
}

/** POST {pageId} with only the changed fields (P6, P8). Throws MetaApiError. */
export async function updatePage(cfg: MetaConfig, account: ChannelAccount, changes: Partial<PageEditable>): Promise<void> {
  const pageId = account.pageId ?? account.externalId;
  if (!pageId) throw new MetaApiError("This account has no Page", 400, null, false);
  const body = pageUpdateBody(changes);
  const res = await withPageTokenRetry(cfg, pageId, (token) =>
    graph<{ success?: boolean }>(cfg, "POST", encodeURIComponent(pageId), body, { token }),
  );
  if (res && res.success === false) throw new MetaApiError("Facebook did not accept the change", 400, null, false);
}

/** The Instagram profile, read-only (G1). The Page token of the linked Page is used. */
export async function readInstagramProfile(cfg: MetaConfig, account: ChannelAccount): Promise<InstagramProfile> {
  const igId = account.externalId;
  const pageId = account.pageId;
  if (!igId || !pageId) throw new MetaApiError("This account has no Instagram ID", 400, null, false);
  const p = await withPageTokenRetry(cfg, pageId, (token) =>
    graph<Partial<Record<keyof InstagramProfile, unknown>>>(
      cfg,
      "GET",
      `${encodeURIComponent(igId)}?fields=id,username,name,biography,website,profile_picture_url,followers_count,media_count`,
      undefined,
      { token },
    ),
  );
  return {
    id: str(p.id) ?? igId,
    username: str(p.username),
    name: str(p.name),
    biography: str(p.biography),
    website: str(p.website),
    profile_picture_url: str(p.profile_picture_url),
    followers_count: num(p.followers_count),
    media_count: num(p.media_count),
  };
}

// ── Errors (5.5) ─────────────────────────────────────────────────────────────

export type PageErrorClass = "config" | "temporary" | "blocked" | "refusal" | "unknown";

export interface PageDetailsError {
  cls: PageErrorClass;
  code: string | null;
  /** Meta's own message, for the owner alert and the audit row. */
  metaMessage: string;
  /** The plain sentence staff see. */
  text: string;
}

export const PAGE_CONFIG_TEXT =
  "The suite is not allowed to change this Page. Ask the owner to give the suite full control of the Page in Meta Business Settings.";
export const PAGE_BUSY_TEXT = "Facebook is busy. Nothing was changed. Try again in a few minutes.";
export const PAGE_BLOCKED_TEXT =
  "Facebook blocked this change because it looked unusual. Try again later, or make the change on Facebook.";
export const PAGE_UNKNOWN_TEXT = "No answer from Facebook. Some details may not have been saved. The page now shows what Facebook holds.";

const CONFIG_CODES = new Set(["190", "10", "200", "299", "283"]);
const TEMPORARY_CODES = new Set([
  "1", "2", "4", "17", "32", "613",
  "80000", "80001", "80002", "80003", "80004", "80005", "80006", "80007", "80008", "80009", "80014",
]);

/** Classify a Meta error from a Page-details call (spec 10, 5.5 and foundation D10, C2, C3). */
export function describePageDetailsError(err: MetaApiError): PageDetailsError {
  const code = err.code;
  const base = { code, metaMessage: err.message };
  if (err.delivery === "unknown" && err.status === 0) return { ...base, cls: "unknown", text: PAGE_UNKNOWN_TEXT };
  if (code === "no_page_token" || (code !== null && CONFIG_CODES.has(code))) {
    return { ...base, cls: "config", text: PAGE_CONFIG_TEXT };
  }
  if (code === "368") return { ...base, cls: "blocked", text: PAGE_BLOCKED_TEXT };
  if (err.status === 429 || err.status >= 500 || err.status === 0 || (code !== null && TEMPORARY_CODES.has(code))) {
    return { ...base, cls: "temporary", text: PAGE_BUSY_TEXT };
  }
  return { ...base, cls: "refusal", text: `Facebook refused this: ${err.message} (code ${code ?? "none"}).` };
}

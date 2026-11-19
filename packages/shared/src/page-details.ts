/**
 * Facebook Page details (suite spec 10, section 5.1): the fields the suite can
 * edit, their limits, the opening-hours format Meta uses, and the rules that
 * check, tidy and compare them. Pure: no network, no clock.
 */
import { toE164 } from "./inbox.js";

export const PAGE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type PageDay = (typeof PAGE_DAYS)[number];
/** "HH:MM"; close may be "24:00". */
export interface PageHoursRange {
  open: string;
  close: string;
}
/** 0, 1 or 2 ranges per day. */
export type PageWeek = Record<PageDay, PageHoursRange[]>;
export interface PageAddress {
  street: string;
  city: string;
  state: string;
  country: string;
  zip: string;
}

/** The fields the suite can edit. null = not set on Facebook. */
export interface PageEditable {
  about: string | null;
  description: string | null;
  phone: string | null;
  website: string | null;
  emails: string[];
  always_open: boolean;
  hours: PageWeek | null;
  address: PageAddress | null;
}
export type PageEditableKey = keyof PageEditable;

/** Every key the suite may send, in screen order. */
export const PAGE_EDITABLE_KEYS: readonly PageEditableKey[] = [
  "about",
  "description",
  "phone",
  "website",
  "emails",
  "always_open",
  "hours",
  "address",
];

export const PAGE_LIMITS = {
  aboutMax: 100,
  descriptionMax: 1000,
  websiteMax: 255,
  emailsMax: 3,
  streetMax: 200,
  cityMax: 100,
  stateMax: 100,
  countryMax: 100,
  zipMax: 20,
} as const;

export const PAGE_DAY_NAMES: Record<PageDay, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export function emptyWeek(): PageWeek {
  return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;

function minutes(t: string): number {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m);
}

/** Meta's `hours` map into a week. null (or nothing usable) stays null. */
export function pageHoursToWeek(hours: Record<string, string> | null | undefined): PageWeek | null {
  if (!hours || typeof hours !== "object") return null;
  const week = emptyWeek();
  let any = false;
  for (const day of PAGE_DAYS) {
    for (const n of [1, 2]) {
      const open = hours[`${day}_${n}_open`];
      const close = hours[`${day}_${n}_close`];
      if (typeof open === "string" && typeof close === "string" && open && close) {
        week[day].push({ open, close });
        any = true;
      }
    }
  }
  return any ? week : null;
}

/** A week into Meta's `hours` map: {"mon_1_open":"08:00","mon_1_close":"18:00",…}. At most two ranges a day. */
export function weekToPageHours(week: PageWeek): Record<string, string> {
  const out: Record<string, string> = {};
  for (const day of PAGE_DAYS) {
    (week[day] ?? []).slice(0, 2).forEach((r, i) => {
      out[`${day}_${i + 1}_open`] = r.open;
      out[`${day}_${i + 1}_close`] = r.close;
    });
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function trimText(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/** The end of a range in minutes, counting an overnight close as the next day. */
function rangeEnd(r: PageHoursRange): number {
  const open = minutes(r.open);
  const close = minutes(r.close);
  return close <= open ? close + 1440 : close;
}

function validateWeek(week: PageWeek | null): { field: PageEditableKey; message: string }[] {
  const out: { field: PageEditableKey; message: string }[] = [];
  const emptyMessage = "Add at least one opening time, or choose Always open.";
  if (!week) return [{ field: "hours", message: emptyMessage }];
  let count = 0;
  for (const day of PAGE_DAYS) {
    const ranges = week[day] ?? [];
    const name = PAGE_DAY_NAMES[day];
    if (ranges.length > 2) {
      out.push({ field: "hours", message: `${name}: you can add at most two opening times.` });
      continue;
    }
    let dayOk = true;
    for (const r of ranges) {
      count += 1;
      const stepOk = (t: string): boolean => TIME_RE.test(t) && minutes(t) % 5 === 0;
      if (!stepOk(r.open) || !stepOk(r.close) || r.open === "24:00") {
        out.push({ field: "hours", message: `${name}: times must be like 08:00, in 5-minute steps.` });
        dayOk = false;
        continue;
      }
      const open = minutes(r.open);
      const close = minutes(r.close);
      const sameDay = open < close;
      const overnight = close <= 360 && close !== open;
      if (!sameDay && !overnight) {
        out.push({ field: "hours", message: `${name}: closing time must be after opening time (or by 6:00 am the next morning).` });
        dayOk = false;
      }
    }
    if (dayOk && ranges.length === 2) {
      const [a, b] = ranges as [PageHoursRange, PageHoursRange];
      if (minutes(a.open) < rangeEnd(b) && minutes(b.open) < rangeEnd(a)) {
        out.push({ field: "hours", message: `${name}: the two opening times overlap.` });
      }
    }
  }
  if (count === 0) out.push({ field: "hours", message: emptyMessage });
  return out;
}

function websiteOk(raw: string): boolean {
  if (raw.length > PAGE_LIMITS.websiteMax || /\s/.test(raw)) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/** The problems with a set of changes, in screen order. Only keys present are checked. */
export function validatePageChanges(changes: Partial<PageEditable>): { field: PageEditableKey; message: string }[] {
  const out: { field: PageEditableKey; message: string }[] = [];
  const c = changes;

  if (c.about != null && c.about.length > PAGE_LIMITS.aboutMax) {
    out.push({ field: "about", message: "Keep the short description to 100 characters." });
  }
  if (c.description != null && c.description.length > PAGE_LIMITS.descriptionMax) {
    out.push({ field: "description", message: "Keep the longer description to 1,000 characters." });
  }
  if (c.phone != null && c.phone !== "" && !toE164(c.phone)) {
    out.push({
      field: "phone",
      message: "That phone number doesn't look right. Include the country code, for example +234 801 234 5678.",
    });
  }
  if (c.website != null && c.website !== "" && !websiteOk(c.website)) {
    out.push({ field: "website", message: "Enter a web address such as https://www.mrssamuel.com" });
  }
  if (c.emails !== undefined) {
    if (c.emails.length > PAGE_LIMITS.emailsMax) {
      out.push({ field: "emails", message: "You can list up to 3 emails." });
    }
    const seen = new Set<string>();
    for (const e of c.emails) {
      if (!EMAIL_RE.test(e)) out.push({ field: "emails", message: `“${e}” is not an email address.` });
      const k = e.trim().toLowerCase();
      if (seen.has(k)) out.push({ field: "emails", message: "The same email is listed twice." });
      seen.add(k);
    }
  }

  // Opening hours: skipped when the same save turns Always open on (hours are then not sent).
  if (c.always_open !== true && (c.hours !== undefined || c.always_open === false)) {
    out.push(...validateWeek(c.hours ?? null));
  }

  if (c.address != null) {
    const a = c.address;
    const parts = [a.street, a.city, a.state, a.country, a.zip].map(trimText);
    if (parts.some((p) => p !== "")) {
      if (!trimText(a.street) || !trimText(a.city) || !trimText(a.country)) {
        out.push({ field: "address", message: "Fill in the street, the city and the country." });
      }
      const tooLong =
        a.street.length > PAGE_LIMITS.streetMax ||
        a.city.length > PAGE_LIMITS.cityMax ||
        a.state.length > PAGE_LIMITS.stateMax ||
        a.country.length > PAGE_LIMITS.countryMax ||
        a.zip.length > PAGE_LIMITS.zipMax;
      if (tooLong) out.push({ field: "address", message: "One of the address lines is too long." });
    }
  }
  return out;
}

function addressIsEmpty(a: PageAddress | null | undefined): boolean {
  return !a || [a.street, a.city, a.state, a.country, a.zip].every((p) => trimText(p) === "");
}

function sortedRanges(ranges: PageHoursRange[]): PageHoursRange[] {
  return [...ranges].sort((x, y) => minutes(x.open) - minutes(y.open));
}

/** Trim, lower-case emails, E.164 the phone, add https:// to a bare website, turn "" into null. */
export function normalisePageChanges(changes: Partial<PageEditable>): Partial<PageEditable> {
  const out: Partial<PageEditable> = {};
  const text = (v: string | null | undefined): string | null => {
    const t = trimText(v);
    return t === "" ? null : t;
  };
  if ("about" in changes) out.about = text(changes.about);
  if ("description" in changes) out.description = text(changes.description);
  if ("phone" in changes) {
    const t = text(changes.phone);
    out.phone = t === null ? null : (toE164(t) ?? t);
  }
  if ("website" in changes) {
    const t = text(changes.website);
    out.website = t === null ? null : /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  }
  if ("emails" in changes) {
    out.emails = (changes.emails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e !== "");
  }
  if ("always_open" in changes) out.always_open = changes.always_open === true;
  if ("hours" in changes) {
    const w = changes.hours;
    if (!w) out.hours = null;
    else {
      const week = emptyWeek();
      for (const d of PAGE_DAYS) week[d] = sortedRanges(w[d] ?? []).map((r) => ({ open: r.open.trim(), close: r.close.trim() }));
      out.hours = week;
    }
  }
  if ("address" in changes) {
    const a = changes.address;
    out.address = addressIsEmpty(a)
      ? null
      : {
          street: trimText(a!.street),
          city: trimText(a!.city),
          state: trimText(a!.state),
          country: trimText(a!.country),
          zip: trimText(a!.zip),
        };
  }
  return out;
}

function phoneDigits(v: unknown): string {
  if (typeof v !== "string") return "";
  return (toE164(v) ?? v).replace(/\D/g, "");
}

function weekKey(v: unknown): string {
  const w = (v ?? null) as PageWeek | null;
  return PAGE_DAYS.map((d) =>
    sortedRanges((w?.[d] ?? []).filter((r) => r.open && r.close))
      .map((r) => `${r.open}-${r.close}`)
      .join(","),
  ).join("|");
}

/** Same value after normalising (order of emails ignored; hours compared range by range). */
export function samePageValue(key: PageEditableKey, a: unknown, b: unknown): boolean {
  switch (key) {
    case "about":
    case "description":
      return trimText(a as string | null) === trimText(b as string | null);
    case "phone":
      return phoneDigits(a) === phoneDigits(b);
    case "website": {
      const clean = (v: unknown): string => (typeof v === "string" ? v.trim().replace(/\/+$/, "") : "");
      return clean(a) === clean(b);
    }
    case "emails": {
      const clean = (v: unknown): string =>
        (Array.isArray(v) ? (v as string[]) : [])
          .map((e) => e.trim().toLowerCase())
          .sort()
          .join("\n");
      return clean(a) === clean(b);
    }
    case "always_open":
      return (a === true) === (b === true);
    case "hours":
      return weekKey(a) === weekKey(b);
    case "address": {
      const clean = (v: unknown): string => {
        const x = v as PageAddress | null | undefined;
        if (addressIsEmpty(x)) return "";
        return [x!.street, x!.city, x!.state, x!.country, x!.zip].map(trimText).join("\n");
      };
      return clean(a) === clean(b);
    }
  }
}

/** Keys whose value differs between two snapshots. Only keys present in `after` are looked at. */
export function diffPage(before: PageEditable, after: Partial<PageEditable>): PageEditableKey[] {
  return PAGE_EDITABLE_KEYS.filter((k) => k in after && !samePageValue(k, before[k], after[k]));
}

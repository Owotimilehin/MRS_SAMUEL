/** Pure rules for the Page details screen (suite spec 10, section 7). No React in here. */
import {
  PAGE_DAYS,
  PAGE_EDITABLE_KEYS,
  normalisePageChanges,
  samePageValue,
  type PageAddress,
  type PageDay,
  type PageEditable,
  type PageEditableKey,
  type PageWeek,
} from "@ms/shared";

export { lagosDateTime } from "../chat-setup/chat-setup-logic.js";

export const NOT_SET = "Not set";

/** The screen's name for a field. always_open and hours are one setting on screen. */
export function fieldLabel(key: PageEditableKey): string {
  switch (key) {
    case "about":
      return "Short description";
    case "description":
      return "More about the business";
    case "phone":
      return "Phone";
    case "website":
      return "Website";
    case "emails":
      return "Emails";
    case "always_open":
    case "hours":
      return "Opening hours";
    case "address":
      return "Address";
  }
}

/** The keys the person changed, ignoring formatting-only differences (R11, R12). */
export function changedKeys(form: PageEditable, live: PageEditable): PageEditableKey[] {
  const n = normalisePageChanges(form) as PageEditable;
  const keys = PAGE_EDITABLE_KEYS.filter((k) => !samePageValue(k, live[k], n[k]));
  if (n.always_open) return keys.filter((k) => k !== "hours");
  // Switching Always open off sends the hours with it (R9).
  if (keys.includes("always_open") && !keys.includes("hours")) keys.push("hours");
  return keys;
}

/** "8:00 am", "6:00 pm"; "24:00" reads as midnight. */
function clock12(t: string): string {
  const [hs, m] = t.split(":");
  const h = Number(hs);
  if (t === "24:00") return "12:00 am";
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${suffix}`;
}

const SHORT_DAY: Record<PageDay, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** One line per day, or "Always open", or "Not set". */
export function hoursText(week: PageWeek | null, alwaysOpen: boolean): string[] {
  if (alwaysOpen) return ["Always open"];
  if (!week) return [NOT_SET];
  return PAGE_DAYS.map((d) => {
    const ranges = week[d] ?? [];
    if (ranges.length === 0) return `${SHORT_DAY[d]} Closed`;
    return `${SHORT_DAY[d]} ${ranges.map((r) => `${clock12(r.open)} to ${clock12(r.close)}`).join(", ")}`;
  });
}

export function addressText(a: PageAddress | null): string {
  if (!a) return NOT_SET;
  const t = [a.street, a.city, a.state, a.country, a.zip].map((p) => p.trim()).filter((p) => p !== "");
  return t.length === 0 ? NOT_SET : t.join(", ");
}

export interface BeforeAfterRow {
  key: PageEditableKey;
  label: string;
  /** One entry per line. */
  now: string[];
  after: string[];
}

function valueLines(key: PageEditableKey, v: PageEditable): string[] {
  switch (key) {
    case "emails":
      return [v.emails.length === 0 ? NOT_SET : v.emails.join(", ")];
    case "always_open":
    case "hours":
      return hoursText(v.hours, v.always_open);
    case "address":
      return [addressText(v.address)];
    default: {
      const t = ((v[key] as string | null) ?? "").trim();
      return [t === "" ? NOT_SET : t];
    }
  }
}

/** A row per changed setting for the save dialog. Hours and Always open share one row. */
export function beforeAfterRows(live: PageEditable, form: PageEditable): BeforeAfterRow[] {
  const n = normalisePageChanges(form) as PageEditable;
  const rows: BeforeAfterRow[] = [];
  for (const key of changedKeys(form, live)) {
    if (key === "always_open" && rows.some((r) => r.key === "hours")) continue;
    const rowKey = key === "always_open" ? "hours" : key;
    if (rowKey === "hours" && rows.some((r) => r.key === "hours")) continue;
    rows.push({ key: rowKey, label: fieldLabel(key), now: valueLines(rowKey, live), after: valueLines(rowKey, n) });
  }
  return rows;
}

/** The labels of some keys, each once, in screen order. */
export function labelsOf(keys: PageEditableKey[]): string[] {
  const out: string[] = [];
  for (const k of PAGE_EDITABLE_KEYS) {
    if (!keys.includes(k)) continue;
    const l = fieldLabel(k);
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

/** The amber banner when Facebook took only some of the changes (7, R8). */
export function partlySavedText(saved: PageEditableKey[], notSaved: PageEditableKey[], clearedSomething: boolean): string {
  const s = labelsOf(saved);
  const n = labelsOf(notSaved);
  const savedPart = s.length > 0 ? `Saved: ${s.join(", ")}. ` : "";
  const tail = clearedSomething ? " To remove it completely, do it on Facebook." : "";
  return `${savedPart}Not saved yet: ${n.join(", ")}. Facebook may be reviewing them, or did not accept them. The page shows what Facebook holds now.${tail}`;
}

/** Whether a not-saved field was one the person emptied (so the banner adds the "do it on Facebook" line). */
export function wasCleared(form: PageEditable, notSaved: PageEditableKey[]): boolean {
  const n = normalisePageChanges(form) as PageEditable;
  return notSaved.some((k) => {
    if (k === "emails") return n.emails.length === 0;
    if (k === "address") return n.address === null;
    if (k === "about" || k === "description" || k === "phone" || k === "website") return n[k] === null;
    return false;
  });
}

const RESULT_CHIP: Record<string, string> = {
  saved: "Saved",
  partly_saved: "Partly saved",
  refused: "Refused",
  unknown: "Not confirmed",
};
export const resultChip = (result: string): string => RESULT_CHIP[result] ?? "Not confirmed";

/** "{n} followers" with a thousands separator. */
export function followersText(n: number | null): string | null {
  return n === null ? null : `${n.toLocaleString("en-GB")} followers`;
}

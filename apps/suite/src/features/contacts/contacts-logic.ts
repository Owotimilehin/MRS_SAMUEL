/**
 * Pure rules and wording for the Contacts screens (suite spec 14, section 7).
 * No React and no fetch here, so every sentence a person reads can be tested.
 * Dates and money are written by our own code: nothing depends on the
 * browser's locale or time zone.
 */
import {
  CONTACT_SOURCE_LABEL,
  groupThousands,
  importReasonHeading,
  type ConsentMethod,
  type ConsentNow,
  type ConsentState,
  type ContactChannel,
  type ContactFilter,
  type ContactSort,
  type ContactSource,
  type ConsentView,
  type ImportMapping,
} from "@ms/shared";

// ── Dates and money ──────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "19 Nov 2026" in Lagos time (UTC+1 all year). "—" for nothing. */
export function lagosDate(isoText: string | null | undefined): string {
  if (!isoText) return "—";
  const t = Date.parse(isoText);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t + 60 * 60_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A "YYYY-MM-DD" date (a day, not a moment) as "19 Nov 2026". */
export function plainDate(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  if (!m) return "—";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}`;
}

/** Today in Lagos as "YYYY-MM-DD", for a date box's default. */
export function lagosToday(now: Date): string {
  return new Date(now.getTime() + 60 * 60_000).toISOString().slice(0, 10);
}

/** "₦20,000". */
export function naira(n: number | null | undefined): string {
  return `₦${groupThousands(Math.round(n ?? 0))}`;
}

// ── A contact row ────────────────────────────────────────────────────────────

/** The small tag beside an address, saying which address it is. */
export function addressTag(source: "saved" | "last_delivery" | null | undefined): string {
  if (source === "saved") return "Saved address";
  if (source === "last_delivery") return "From their last delivery";
  return "";
}

export const CHANNEL_TEXT: Record<ContactChannel, string> = {
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  phone: "Phone call",
};

export function sourceText(source: ContactSource): string {
  return CONTACT_SOURCE_LABEL[source] ?? "Unknown";
}

/** "3 · ₦20,000", or "—" for someone who never ordered. */
export function ordersCell(count: number, spent: number): string {
  return count > 0 ? `${count} · ${naira(spent)}` : "—";
}

/** "128 contacts" or "12 contacts match". */
export function countLine(total: number | null, filtered: boolean): string {
  if (total === null) return "";
  const noun = total === 1 ? "contact" : "contacts";
  return filtered ? `${groupThousands(total)} ${noun} ${total === 1 ? "matches" : "match"}` : `${groupThousands(total)} ${noun}`;
}

// ── Consent wording (7.3) ────────────────────────────────────────────────────

/** How a consent record came about, in a few words. */
export function consentHow(method: ConsentMethod, state: ConsentState, byName: string | null): string {
  switch (method) {
    case "staff":
      return byName ? `recorded by ${byName}` : "recorded by staff";
    case "import":
      return "from an import";
    case "keyword":
      return state === "withdrawn" ? "they replied STOP" : "they replied START";
    case "whatsapp_setting":
      return "they changed it in WhatsApp";
    case "meta_refusal":
      return "WhatsApp told us";
    case "erase_request":
      return "they asked us to delete their history";
    case "carried_over":
      return "from an earlier record of the same number";
    case "merge":
      return "from a merged contact";
    default:
      return "recorded";
  }
}

/** "Agreed on 12 Nov 2026 (recorded by Ada)", "Asked us to stop on … (they replied STOP)", or "Not asked yet". */
export function consentLine(row: Pick<ConsentNow, "state" | "method" | "recorded_at" | "recorded_by_name"> | null | undefined): string {
  if (!row) return "Not asked yet";
  const how = consentHow(row.method, row.state, row.recorded_by_name);
  const when = lagosDate(row.recorded_at);
  return row.state === "granted" ? `Agreed on ${when} (${how})` : `Asked us to stop on ${when} (${how})`;
}

export const CONSENT_CHANNEL_TEXT: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "Email", phone: "Phone calls" };
export const CONSENT_PURPOSE_TEXT: Record<string, string> = { marketing: "promotions", service: "order and service messages" };

/** "WhatsApp promotions", "SMS order and service messages". */
export function consentTitle(channel: string, purpose: string): string {
  return `${CONSENT_CHANNEL_TEXT[channel] ?? channel} ${CONSENT_PURPOSE_TEXT[purpose] ?? purpose}`;
}

/** The current WhatsApp promotions row among a contact's current consent rows. */
export function whatsappPromotions<T extends { channel: string; purpose: string }>(rows: readonly T[]): T | null {
  return rows.find((r) => r.channel === "whatsapp" && r.purpose === "marketing") ?? null;
}

// ── Changes card ─────────────────────────────────────────────────────────────

function joinAnd(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "Ada changed the email and address", "Ada merged another record into this one". */
export function editLine(e: { by_name: string | null; action: string; changed: string[] }): string {
  const who = e.by_name ?? "Someone";
  switch (e.action) {
    case "contacts.create":
      return `${who} added this contact`;
    case "contacts.import_fill":
      return e.changed.length ? `An import by ${who} filled in the ${joinAnd(e.changed)}` : `An import by ${who} filled in missing details`;
    case "inbox.contact_merge":
      return `${who} merged this record into another contact`;
    case "inbox.contact_erase":
      return `${who} erased their conversation history`;
    default:
      return e.changed.length ? `${who} changed the ${joinAnd(e.changed)}` : `${who} made a change`;
  }
}

// ── Filters (7.2) ────────────────────────────────────────────────────────────

/** What the filter chips hold. Text boxes keep their text; "" means not set. */
export interface FilterState {
  q: string;
  channels: ContactChannel[];
  hasPhone: boolean;
  hasEmail: boolean;
  hasAddress: boolean;
  /** "" or a whole number of days. */
  orderedWithin: string;
  neverOrdered: boolean;
  /** "" or a whole number of naira. */
  minSpent: string;
  labelIds: string[];
  sources: ContactSource[];
  consent: ConsentView | "";
  listId: string;
}

export const EMPTY_FILTERS: FilterState = {
  q: "",
  channels: [],
  hasPhone: false,
  hasEmail: false,
  hasAddress: false,
  orderedWithin: "",
  neverOrdered: false,
  minSpent: "",
  labelIds: [],
  sources: [],
  consent: "",
  listId: "",
};

function wholeNumber(text: string, min: number, max: number): number | null {
  const t = text.replace(/[,\s₦]/g, "");
  if (!/^\d{1,12}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** The chips as the filter the server understands. A search shorter than 2 characters is left out. */
export function toContactFilter(s: FilterState): ContactFilter {
  const f: ContactFilter = {};
  const q = s.q.trim();
  if (q.length >= 2) f.q = q.slice(0, 80);
  if (s.channels.length) f.channels = [...s.channels];
  if (s.hasPhone) f.has_phone = true;
  if (s.hasEmail) f.has_email = true;
  if (s.hasAddress) f.has_address = true;
  const days = wholeNumber(s.orderedWithin, 1, 3650);
  if (days !== null && !s.neverOrdered) f.ordered_within_days = days;
  if (s.neverOrdered) f.never_ordered = true;
  const spent = wholeNumber(s.minSpent, 1, 1_000_000_000_000);
  if (spent !== null && !s.neverOrdered) f.min_spent_ngn = spent;
  if (s.labelIds.length) f.label_ids = [...s.labelIds];
  if (s.sources.length) f.sources = [...s.sources];
  if (s.consent) f.consent = s.consent;
  if (s.listId) f.list_id = s.listId;
  return f;
}

/** A stored filter (a smart list's rules) back into chips, for "Change rules". */
export function fromContactFilter(f: ContactFilter): FilterState {
  return {
    q: f.q ?? "",
    channels: [...(f.channels ?? [])],
    hasPhone: f.has_phone === true,
    hasEmail: f.has_email === true,
    hasAddress: f.has_address === true,
    orderedWithin: f.ordered_within_days !== undefined ? String(f.ordered_within_days) : "",
    neverOrdered: f.never_ordered === true,
    minSpent: f.min_spent_ngn !== undefined && f.min_spent_ngn > 0 ? String(f.min_spent_ngn) : "",
    labelIds: [...(f.label_ids ?? [])],
    sources: [...(f.sources ?? [])],
    consent: f.consent ?? "",
    listId: f.list_id ?? "",
  };
}

/** Is any filter on (the search box counts)? */
export function anyFilterOn(s: FilterState): boolean {
  return Object.keys(toContactFilter(s)).length > 0;
}

/** Why this set of chips cannot be saved as a list that keeps itself up to date, or null. */
export function smartListProblem(s: FilterState): string | null {
  if (s.q.trim()) return "Clear the search box first. A list that keeps itself up to date can only use filters.";
  if (s.listId) return "Take off the “On list” filter first. A list that keeps itself up to date can't be built from another list.";
  if (Object.keys(toContactFilter(s)).length === 0) return "Choose at least one filter first.";
  return null;
}

export const SORT_TEXT: Record<ContactSort, string> = {
  name: "Name (A to Z)",
  last_order: "Latest order",
  spent: "Highest spend",
  last_contact: "Latest contact",
  added: "Newest contact",
};

// ── Selection (7.2) ──────────────────────────────────────────────────────────

/** Either some ticked rows, or "everyone who matches" (which is sent as the filter, never as ids). */
export type Selection = { mode: "ids"; ids: string[] } | { mode: "all"; filter: ContactFilter; total: number };

/** What to send to POST /lists/:id/members. "Select all" sends the filter, not IDs. */
export function addToListBody(sel: Selection): { customer_ids: string[] } | { filter: ContactFilter } {
  return sel.mode === "all" ? { filter: sel.filter } : { customer_ids: sel.ids };
}

export function selectionCount(sel: Selection): number {
  return sel.mode === "all" ? sel.total : sel.ids.length;
}

/** "5 selected" / "All 1,204 that match selected". */
export function selectionLine(sel: Selection): string {
  return sel.mode === "all" ? `All ${groupThousands(sel.total)} that match selected` : `${sel.ids.length} selected`;
}

// ── Import (7.6) ─────────────────────────────────────────────────────────────

/** Why the "Match the columns" step cannot be left yet, or null. */
export function mappingProblem(mapping: ImportMapping): string | null {
  if (!mapping.phone && !mapping.email) return "Choose the column that holds the phone number or the email.";
  const used = Object.values(mapping).filter((h): h is string => !!h);
  const twice = used.find((h, i) => used.indexOf(h) !== i);
  if (twice) return `The column “${twice}” is chosen twice. Use each column once.`;
  return null;
}

/** Why the "Say where they came from" step cannot be left yet, or null. */
export function sourceStepProblem(v: { sourceLabel: string; consentYes: boolean; consentMethod: string; consentWording: string; consentDate: string; hasPhoneColumn: boolean }): string | null {
  if (!v.sourceLabel.trim()) return "Say where you got this list.";
  if (v.consentYes) {
    if (!v.hasPhoneColumn) return "Promotions on WhatsApp need a phone number column. Go back and choose it.";
    if (!v.consentMethod.trim()) return "Say how these people agreed.";
    if (!v.consentWording.trim()) return "Say what these people were told.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.consentDate)) return "Say when these people agreed.";
  }
  return null;
}

/** Why a file cannot be used, before it is sent; null when it can. */
export function fileProblem(file: { name: string; size: number }, text: string | null): string | null {
  if (!/\.csv$/i.test(file.name)) return "That file is not a CSV. In Excel or Google Sheets choose “Save as” or “Download” and pick CSV.";
  if (text === null) return "We couldn't read this file. Save it again as “CSV UTF-8”.";
  if (text.trim() === "") return "This file is empty.";
  if (text.includes("\u0000") || text.includes("�")) return "We couldn't read this file. Save it again as “CSV UTF-8”.";
  if (text.length > 2_000_000) return "This file is too big. Split it into smaller files.";
  return null;
}

/** The heading a group of refused rows is shown under (rule R19 wording). */
export function rejectionReasonText(code: string): string {
  return importReasonHeading(code);
}

/** "Import 8 contacts? 5 will be new. 3 are already contacts and will not be changed, except for missing details." */
export function importConfirmText(newCount: number, matched: number, fillBlanks: boolean): string {
  const n = newCount + matched;
  return `Import ${n} contact${n === 1 ? "" : "s"}? ${newCount} will be new. ${matched} ${matched === 1 ? "is" : "are"} already ${
    matched === 1 ? "a contact" : "contacts"
  } and will not be changed${fillBlanks ? ", except for missing details" : ""}.`;
}

/** What the import page says for each state of an import. */
export function importProgressText(v: { status: string; applied: number; total: number; added: number; already: number }): string {
  switch (v.status) {
    case "applying":
      return `Saving… ${v.applied} of ${v.total}.`;
    case "applied":
      return `Done. ${v.added} new contact${v.added === 1 ? "" : "s"} added, ${v.already} already here.`;
    case "failed":
      return `The import stopped part-way: ${v.applied} of ${v.total} rows were saved. Nothing was saved twice. Tell Tes.`;
    case "cancelled":
      return "This import was cancelled. Nothing was saved.";
    default:
      return "Nothing has been saved yet.";
  }
}

export const IMPORT_FIELD_TEXT: Record<string, string> = {
  name: "Name",
  first_name: "First name",
  last_name: "Last name",
  phone: "Phone",
  email: "Email",
  address: "Address",
  notes: "Notes",
};

/** The five ways a person first reached the business (customer_source), as the add and import forms say them. */
export const FIRST_REACHED: { value: "walkup_anonymous" | "online" | "phone" | "whatsapp" | "chowdeck"; label: string }[] = [
  { value: "walkup_anonymous", label: "In the shop" },
  { value: "online", label: "Website" },
  { value: "phone", label: "Phone call" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "chowdeck", label: "Chowdeck" },
];

// ── Forms ────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** What is wrong with the Add contact form, or null. The server checks again. */
export function addContactProblem(v: { phone: string; email: string; sourceLabel: string; consentYes: boolean; consentWording: string }): string | null {
  const phone = v.phone.trim();
  const email = v.email.trim();
  if (!phone && !email) return "Add a phone number or an email.";
  if (phone && phone.replace(/\D/g, "").length < 8) return "That phone number doesn't look right. Use a number like 0803 123 4567.";
  if (email && !EMAIL_RE.test(email)) return "That email doesn't look right.";
  if (!v.sourceLabel.trim()) return "Say where you got these details.";
  if (v.consentYes && !phone) return "Add a phone number to record promotions on WhatsApp.";
  if (v.consentYes && !v.consentWording.trim()) return "Say what the customer agreed to.";
  return null;
}

/** What is wrong with the Edit contact form, or null. */
export function editContactProblem(v: { name: string; email: string }): string | null {
  if (!v.name.trim()) return "Enter a name.";
  if (v.email.trim() && !EMAIL_RE.test(v.email.trim())) return "That email doesn't look right.";
  return null;
}

/** Only the fields a person really changed, so an untouched form sends nothing. */
export function editContactPatch(
  before: { name: string | null; email: string | null; saved_address: string | null; notes: string | null },
  form: { name: string; email: string; address: string; notes: string },
): { name?: string; email?: string | null; address?: string | null; notes?: string | null } {
  const patch: { name?: string; email?: string | null; address?: string | null; notes?: string | null } = {};
  const name = form.name.trim();
  if (name !== (before.name ?? "")) patch.name = name;
  const email = form.email.trim().toLowerCase();
  if (email !== (before.email ?? "")) patch.email = email || null;
  const address = form.address.trim();
  if (address !== (before.saved_address ?? "")) patch.address = address || null;
  if (form.notes !== (before.notes ?? "")) patch.notes = form.notes.trim() ? form.notes : null;
  return patch;
}

/** Must the "They asked to get promotions again" box be ticked before saving? */
export function needsAskedAgain(current: { state: string } | null | undefined, choosing: ConsentState): boolean {
  return current?.state === "withdrawn" && choosing === "granted";
}

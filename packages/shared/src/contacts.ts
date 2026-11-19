/**
 * Contacts (suite spec 14, Phase A): types and pure rules shared by the API,
 * the worker and the suite. No Node-only imports: this file ships to the browser.
 *
 * A contact is a row of the shop's `customer` table. Nothing here changes one.
 */
import { toE164 } from "./inbox.js";

export type ContactChannel = "whatsapp" | "messenger" | "instagram" | "phone";
export const CONTACT_CHANNELS: readonly ContactChannel[] = ["whatsapp", "messenger", "instagram", "phone"];
/** The five shop values of customer_source, which gains none (foundation ruling 9.2.7). */
export const CUSTOMER_SOURCES = ["walkup_anonymous", "online", "phone", "whatsapp", "chowdeck"] as const;
export type CustomerSourceValue = (typeof CUSTOMER_SOURCES)[number];
export type ContactSource = CustomerSourceValue | "manual" | "import";
export const CONTACT_SOURCES: readonly ContactSource[] = [...CUSTOMER_SOURCES, "manual", "import"];
/** Marketing on WhatsApp, as one word. */
export type ConsentView = "agreed" | "stopped" | "not_asked";
export const CONSENT_VIEWS: readonly ConsentView[] = ["agreed", "stopped", "not_asked"];
export type ContactSort = "name" | "last_order" | "spent" | "last_contact" | "added";
export const CONTACT_SORTS: readonly ContactSort[] = ["name", "last_order", "spent", "last_contact", "added"];

export const CONSENT_CHANNELS = ["whatsapp", "sms", "email", "phone"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export const CONSENT_PURPOSES = ["marketing", "service"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export const CONSENT_STATES = ["granted", "withdrawn"] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];
export const CONSENT_METHODS = [
  "staff",
  "import",
  "keyword",
  "whatsapp_setting",
  "meta_refusal",
  "erase_request",
  "carried_over",
  "merge",
] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

export const CONTACT_LABEL_COLOURS = ["green", "amber", "red", "blue", "purple", "grey"] as const;
export type ContactLabelColour = (typeof CONTACT_LABEL_COLOURS)[number];

export const CONTACT_LIMITS = {
  name: 120,
  address: 500,
  notes: 4000,
  searchMin: 2,
  searchMax: 80,
  pageDefault: 50,
  pageMax: 200,
  exportMaxRows: 20_000,
  exportAlertRows: 500,
  importMaxRows: 5000,
  importMaxColumns: 40,
  importMaxChars: 2_000_000,
  bulkIds: 500,
  listAddMax: 20_000,
  labelsPerContact: 20,
  labelName: 40,
  listName: 80,
  settingsText: 600,
} as const;

// ── The filter ───────────────────────────────────────────────────────────────

export interface ContactFilter {
  /** Not allowed in a smart list. */
  q?: string;
  /** Any of. */
  channels?: ContactChannel[];
  has_phone?: boolean;
  has_email?: boolean;
  has_address?: boolean;
  /** 1..3650 */
  ordered_within_days?: number;
  never_ordered?: boolean;
  /** >= 0 */
  min_spent_ngn?: number;
  /** >= 1 */
  min_orders?: number;
  /** 1..3650 */
  last_contact_within_days?: number;
  /** Any of. */
  label_ids?: string[];
  /** Any of. */
  sources?: ContactSource[];
  consent?: ConsentView;
  /** A static list; not allowed in a smart list. */
  list_id?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTER_KEYS = new Set([
  "q",
  "channels",
  "has_phone",
  "has_email",
  "has_address",
  "ordered_within_days",
  "never_ordered",
  "min_spent_ngn",
  "min_orders",
  "last_contact_within_days",
  "label_ids",
  "sources",
  "consent",
  "list_id",
]);

type FilterResult = { ok: true; filter: ContactFilter } | { ok: false; error: string };

function wholeNumber(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/**
 * Check a filter that came from a browser or from storage. Unknown keys and
 * wrong shapes are refused; empty parts (no channels, a blank search) are
 * dropped. `forSmartList`: a list that keeps itself up to date cannot hold a
 * search term or point at another list.
 */
export function parseContactFilter(input: unknown, o: { forSmartList: boolean }): FilterResult {
  if (input !== null && input !== undefined && (typeof input !== "object" || Array.isArray(input))) {
    return { ok: false, error: "That filter can't be read." };
  }
  const raw = (input ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(raw)) {
    if (!FILTER_KEYS.has(k)) return { ok: false, error: "That filter can't be read." };
  }
  const bad = (what: string): FilterResult => ({ ok: false, error: `That filter can't be read (${what}).` });
  const f: ContactFilter = {};

  if (raw.q !== undefined && raw.q !== null) {
    if (typeof raw.q !== "string") return bad("search");
    const q = raw.q.trim();
    if (q.length > 0) {
      if (q.length < CONTACT_LIMITS.searchMin) return { ok: false, error: "Type at least 2 characters to search." };
      if (q.length > CONTACT_LIMITS.searchMax) return { ok: false, error: "That search is too long." };
      f.q = q;
    }
  }
  if (raw.channels !== undefined && raw.channels !== null) {
    if (!Array.isArray(raw.channels) || raw.channels.some((c) => !CONTACT_CHANNELS.includes(c as ContactChannel))) return bad("channels");
    const list = [...new Set(raw.channels as ContactChannel[])];
    if (list.length) f.channels = list;
  }
  for (const key of ["has_phone", "has_email", "has_address"] as const) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "boolean") return bad(key);
    f[key] = v;
  }
  if (raw.never_ordered !== undefined && raw.never_ordered !== null) {
    if (typeof raw.never_ordered !== "boolean") return bad("never_ordered");
    if (raw.never_ordered) f.never_ordered = true;
  }
  for (const [key, min, max] of [
    ["ordered_within_days", 1, 3650],
    ["last_contact_within_days", 1, 3650],
    ["min_spent_ngn", 0, 1_000_000_000_000],
    ["min_orders", 1, 1_000_000],
  ] as const) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    const n = wholeNumber(v, min, max);
    if (n === null) return bad(key);
    f[key] = n;
  }
  if (raw.label_ids !== undefined && raw.label_ids !== null) {
    if (!Array.isArray(raw.label_ids) || raw.label_ids.length > 50 || raw.label_ids.some((x) => typeof x !== "string" || !UUID_RE.test(x))) {
      return bad("labels");
    }
    const list = [...new Set(raw.label_ids as string[])];
    if (list.length) f.label_ids = list;
  }
  if (raw.sources !== undefined && raw.sources !== null) {
    if (!Array.isArray(raw.sources) || raw.sources.some((s) => !CONTACT_SOURCES.includes(s as ContactSource))) return bad("sources");
    const list = [...new Set(raw.sources as ContactSource[])];
    if (list.length) f.sources = list;
  }
  if (raw.consent !== undefined && raw.consent !== null) {
    if (!CONSENT_VIEWS.includes(raw.consent as ConsentView)) return bad("consent");
    f.consent = raw.consent as ConsentView;
  }
  if (raw.list_id !== undefined && raw.list_id !== null) {
    if (typeof raw.list_id !== "string" || !UUID_RE.test(raw.list_id)) return bad("list");
    f.list_id = raw.list_id;
  }

  if (f.never_ordered && (f.ordered_within_days !== undefined || (f.min_spent_ngn ?? 0) > 0 || f.min_orders !== undefined)) {
    return { ok: false, error: "Those filters can't be used together." };
  }
  if (o.forSmartList) {
    if (f.q !== undefined) {
      return { ok: false, error: "Clear the search box first. A list that keeps itself up to date can only use filters." };
    }
    if (f.list_id !== undefined) {
      return { ok: false, error: "A list that keeps itself up to date can't be built from another list." };
    }
    if (Object.keys(f).length === 0) return { ok: false, error: "Choose at least one filter first." };
  }
  return { ok: true, filter: f };
}

export const CONTACT_CHANNEL_LABEL: Record<ContactChannel, string> = {
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  phone: "Phone call",
};
export const CONTACT_SOURCE_LABEL: Record<ContactSource, string> = {
  walkup_anonymous: "In the shop",
  online: "Website",
  phone: "Phone order",
  whatsapp: "WhatsApp",
  chowdeck: "Chowdeck",
  manual: "Added by hand",
  import: "Imported",
};
export const CONSENT_VIEW_LABEL: Record<ConsentView, string> = {
  agreed: "Agreed",
  stopped: "Asked us to stop",
  not_asked: "Not asked yet",
};

/** 20000 -> "20,000". Written by hand so it never depends on the machine's locale. */
export function groupThousands(n: number): string {
  const whole = Math.trunc(Math.abs(n)).toString();
  let out = "";
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) out += ",";
    out += whole[i];
  }
  return n < 0 ? `-${out}` : out;
}

function anyOf(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/** The filter in plain English, one line per part, in the order the filters show on screen. */
export function describeContactFilter(f: ContactFilter, labelNames: Record<string, string>): string[] {
  const lines: string[] = [];
  if (f.q) lines.push(`Search: “${f.q}”`);
  if (f.channels?.length) lines.push(`Reaches us by ${anyOf(f.channels.map((c) => CONTACT_CHANNEL_LABEL[c]))}`);
  if (f.has_phone !== undefined) lines.push(f.has_phone ? "Has a phone number" : "No phone number");
  if (f.has_email !== undefined) lines.push(f.has_email ? "Has an email" : "No email");
  if (f.has_address !== undefined) lines.push(f.has_address ? "Has an address" : "No address");
  if (f.ordered_within_days !== undefined) lines.push(`Ordered in the last ${f.ordered_within_days} days`);
  if (f.never_ordered) lines.push("Never ordered");
  if (f.min_spent_ngn !== undefined) lines.push(`Spent at least ₦${groupThousands(f.min_spent_ngn)}`);
  if (f.min_orders !== undefined) lines.push(f.min_orders === 1 ? "At least 1 order" : `At least ${f.min_orders} orders`);
  if (f.last_contact_within_days !== undefined) lines.push(`In contact in the last ${f.last_contact_within_days} days`);
  if (f.label_ids?.length) lines.push(`Label: ${anyOf(f.label_ids.map((id) => labelNames[id] ?? "a deleted label"))}`);
  if (f.sources?.length) lines.push(`Came from: ${anyOf(f.sources.map((s) => CONTACT_SOURCE_LABEL[s]))}`);
  if (f.consent) lines.push(`Promotions on WhatsApp: ${CONSENT_VIEW_LABEL[f.consent]}`);
  if (f.list_id) lines.push("On a chosen list");
  return lines;
}

// ── Phone, email ─────────────────────────────────────────────────────────────

/**
 * A phone as the digits contacts are searched by: everything but digits
 * removed, then one leading 234 or 0 removed. 0803…, 803… and +234803… are one
 * value. Mirrors contact_summary.phone_digits.
 */
export function contactPhoneDigits(input: string | null | undefined): string {
  return (input ?? "").replace(/\D/g, "").replace(/^(234|0)/, "");
}

export const CONTACT_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Trimmed and lower-cased; null when blank; undefined when it does not look like an email. */
export function normaliseContactEmail(input: string | null | undefined): string | null | undefined {
  const t = (input ?? "").trim().toLowerCase();
  if (!t) return null;
  return CONTACT_EMAIL_RE.test(t) ? t : undefined;
}

// ── STOP and START ───────────────────────────────────────────────────────────

export const STOP_WORDS = [
  "stop",
  "stop all",
  "stopall",
  "unsubscribe",
  "opt out",
  "optout",
  "opt-out",
  "remove me",
  "stop promo",
  "stop promotions",
  "no more messages",
] as const;
export const START_WORDS = ["start", "unstop", "subscribe", "opt in", "optin", "opt-in", "resume"] as const;

const QUOTES = "\"'“”‘’`";

/**
 * The whole message, trimmed, lower-cased, with trailing . ! and surrounding
 * quotes removed, must equal one word in the list. A sentence that merely
 * contains the word is an ordinary message. "cancel", "end" and "quit" are
 * deliberately not stop words: in this shop "cancel" usually means an order.
 */
export function consentKeyword(body: string | null | undefined): "stop" | "start" | null {
  if (typeof body !== "string") return null;
  let t = body.trim().toLowerCase();
  if (!t || t.length > 40) return null;
  for (let changed = true; changed; ) {
    changed = false;
    const noTail = t.replace(/[.!]+$/, "").trimEnd();
    if (noTail !== t) {
      t = noTail;
      changed = true;
    }
    if (t.length >= 2 && QUOTES.includes(t[0]!) && QUOTES.includes(t[t.length - 1]!)) {
      t = t.slice(1, -1).trim();
      changed = true;
    }
  }
  if ((STOP_WORDS as readonly string[]).includes(t)) return "stop";
  if ((START_WORDS as readonly string[]).includes(t)) return "start";
  return null;
}

export interface ContactSettings {
  stop_confirmation: boolean;
  stop_text: string;
  start_text: string;
}
export const DEFAULT_CONTACT_SETTINGS: ContactSettings = {
  stop_confirmation: true,
  stop_text:
    "You will not get promotions from Mrs. Samuel Fruit Juice on WhatsApp any more. We will still answer your messages and send updates about your orders. Reply START if you change your mind.",
  start_text:
    "Welcome back. You will get offers and news from Mrs. Samuel Fruit Juice on WhatsApp again. Reply STOP at any time to stop them.",
};
export const CONTACT_SETTINGS_KEY = "contact_settings";

/** Stored settings with anything missing or wrong replaced by the default. */
export function readContactSettings(value: unknown): ContactSettings {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const text = (x: unknown, d: string) => (typeof x === "string" && x.trim() ? x : d);
  return {
    stop_confirmation: typeof v.stop_confirmation === "boolean" ? v.stop_confirmation : DEFAULT_CONTACT_SETTINGS.stop_confirmation,
    stop_text: text(v.stop_text, DEFAULT_CONTACT_SETTINGS.stop_text),
    start_text: text(v.start_text, DEFAULT_CONTACT_SETTINGS.start_text),
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * RFC 4180 parser: quoted cells, doubled quotes, CR LF or LF, a leading UTF-8
 * byte-order mark. Never throws. Lines with nothing on them are skipped. The
 * first row is the headers (trimmed); cells are returned as written.
 */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const src = typeof text === "string" ? (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) : "";
  const all: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellWasQuoted = false;
  const endRow = () => {
    row.push(cell);
    // A line with nothing on it (one empty, unquoted cell) is not a row.
    if (!(row.length === 1 && row[0] === "" && !cellWasQuoted)) all.push(row);
    row = [];
    cell = "";
    cellWasQuoted = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      cellWasQuoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      endRow();
    } else if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0 || cellWasQuoted) endRow();
  const [first, ...rows] = all;
  return { headers: (first ?? []).map((h) => h.trim()), rows };
}

/** Guard a spreadsheet cell: a value starting with = + - or @ gets a leading apostrophe, so it is never run as a formula. */
export function csvSafeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /^[=+\-@]/.test(s) || /^[\t\r]/.test(s) ? `'${s}` : s;
}

// ── Import ───────────────────────────────────────────────────────────────────

export type ImportField = "name" | "first_name" | "last_name" | "phone" | "email" | "address" | "notes";
export const IMPORT_FIELDS: readonly ImportField[] = ["name", "first_name", "last_name", "phone", "email", "address", "notes"];
/** field -> header text */
export type ImportMapping = Partial<Record<ImportField, string>>;

const MAPPING_WORDS: [ImportField, string[]][] = [
  ["phone", ["phone", "phonenumber", "mobile", "tel", "telephone", "whatsapp", "number"]],
  ["email", ["email", "emailaddress", "mail"]],
  ["name", ["name", "fullname", "customer", "customername"]],
  ["first_name", ["firstname", "first"]],
  ["last_name", ["lastname", "surname", "last"]],
  ["address", ["address", "deliveryaddress", "location"]],
  ["notes", ["notes", "note", "comment", "comments"]],
];

/** Guess which column is which (rule R17). First header that matches wins; a header is used once. */
export function suggestMapping(headers: string[]): ImportMapping {
  const keys = headers.map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const used = new Set<number>();
  const out: ImportMapping = {};
  for (const [field, words] of MAPPING_WORDS) {
    const at = keys.findIndex((k, i) => !used.has(i) && words.includes(k));
    if (at >= 0) {
      used.add(at);
      out[field] = headers[at]!;
    }
  }
  return out;
}

export interface ImportRowDraft {
  name: string | null;
  phone_e164: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  /** What the phone and email cells held, for the refusal wording. */
  phone_cell: string;
  email_cell: string;
  bad_phone: boolean;
  bad_email: boolean;
}

/** Build the fields of one import row from the uploaded cells and the chosen columns (rule R18). */
export function buildImportRow(raw: Record<string, string>, mapping: ImportMapping): ImportRowDraft {
  const cell = (f: ImportField): string => {
    const header = mapping[f];
    return header ? (raw[header] ?? "").trim() : "";
  };
  const cut = (s: string, n: number): string | null => (s ? s.slice(0, n) : null);
  const full = cell("name") || `${cell("first_name")} ${cell("last_name")}`.trim();
  const phoneCell = cell("phone");
  const emailCell = cell("email");
  const phone = phoneCell ? toE164(phoneCell) : null;
  const email = normaliseContactEmail(emailCell);
  return {
    name: cut(full.replace(/\s+/g, " "), CONTACT_LIMITS.name),
    phone_e164: phone,
    email: email ?? null,
    address: cut(cell("address"), CONTACT_LIMITS.address),
    notes: cut(cell("notes"), CONTACT_LIMITS.notes),
    phone_cell: phoneCell,
    email_cell: emailCell,
    bad_phone: phoneCell !== "" && phone === null,
    bad_email: emailCell !== "" && email === undefined,
  };
}

/**
 * Why a row is refused, or a note on a row that is kept. Stored on
 * contact_import_row.reason as "<code>" or "<code>:<detail>", one per line.
 */
export type ImportReasonCode =
  | "no_contact"
  | "bad_phone"
  | "bad_email"
  | "duplicate_phone"
  | "duplicate_email"
  | "matched"
  | "same_email"
  | "email_dropped"
  | "phone_dropped"
  | "stopped";

export function importReason(code: ImportReasonCode, detail?: string | number | null): string {
  const d = detail === undefined || detail === null ? "" : String(detail).replace(/\s+/g, " ").trim().slice(0, 80);
  return d ? `${code}:${d}` : code;
}

function oneReasonText(line: string): string {
  const at = line.indexOf(":");
  const code = at < 0 ? line : line.slice(0, at);
  const detail = at < 0 ? "" : line.slice(at + 1);
  switch (code) {
    case "no_contact":
      return "No phone number or email";
    case "bad_phone":
      return `The phone number doesn't look right: “${detail}”`;
    case "bad_email":
      return `The email doesn't look right: “${detail}”`;
    case "duplicate_phone":
      return `Same phone number as row ${detail}`;
    case "duplicate_email":
      return `Same email as row ${detail}`;
    case "matched":
      return "Already a contact";
    case "same_email":
      return `Same email as ${detail || "another contact"}, different phone number: check for a duplicate`;
    case "email_dropped":
      return `The email doesn't look right and was left out: “${detail}”`;
    case "phone_dropped":
      return `The phone number doesn't look right and was left out: “${detail}”`;
    case "stopped":
      return "Asked us to stop promotions: consent will not be recorded";
    default:
      return line;
  }
}

/** The stored reason in plain English (several notes are joined with ". "). */
export function importReasonText(stored: string | null | undefined): string {
  if (!stored) return "";
  return stored
    .split("\n")
    .filter((l) => l.trim())
    .map(oneReasonText)
    .join(". ");
}

/** The first code of a stored reason (what a rejected row is counted under). */
export function importReasonCode(stored: string | null | undefined): string {
  const first = (stored ?? "").split("\n")[0] ?? "";
  const at = first.indexOf(":");
  return at < 0 ? first : first.slice(0, at);
}

/** The heading a group of refused rows is shown under. */
export function importReasonHeading(code: string): string {
  switch (code) {
    case "no_contact":
      return "No phone number or email";
    case "bad_phone":
      return "The phone number doesn't look right";
    case "bad_email":
      return "The email doesn't look right";
    case "duplicate_phone":
      return "Same phone number as another row";
    case "duplicate_email":
      return "Same email as another row";
    default:
      return oneReasonText(code);
  }
}

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * A first name for a greeting (rule R45): the first run of letters (with
 * apostrophes and hyphens) in the trimmed name, first letter upper-cased. Null
 * when the name is empty, starts with "@", or has no letters.
 */
export function firstName(name: string | null | undefined): string | null {
  const t = (name ?? "").trim();
  if (!t || t.startsWith("@")) return null;
  const m = /\p{L}[\p{L}'’-]*/u.exec(t);
  if (!m) return null;
  const word = m[0];
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// ── What the routes return (apps/api/src/routes/contacts.ts) ─────────────────

export interface ContactLabelView {
  id: string;
  name: string;
  colour: ContactLabelColour;
}

export interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  address_source: "saved" | "last_delivery" | null;
  channels: ContactChannel[];
  /** Up to 3, "@name" or a display name. */
  handles: string[];
  source: ContactSource;
  last_contact_at: string | null;
  orders_count: number;
  spent_ngn: number;
  last_order_at: string | null;
  labels: ContactLabelView[];
  consent: ConsentView;
  wa_unreachable: boolean;
  created_at: string;
}

export interface ConsentNow {
  channel: ConsentChannel;
  purpose: ConsentPurpose;
  state: ConsentState;
  method: ConsentMethod;
  recorded_at: string;
  recorded_by_name: string | null;
}

export interface ConsentRow extends ConsentNow {
  id: string;
  wording: string | null;
  note: string | null;
  collected_on: string | null;
  is_current: boolean;
}

export interface ContactIdentityView {
  id: string;
  channel: "whatsapp" | "messenger" | "instagram";
  account_label: string;
  display_name: string | null;
  username: string | null;
  phone: string | null;
  profile_pic_url: string | null;
  last_seen_at: string | null;
}

export interface ContactDetail extends ContactRow {
  notes: string | null;
  saved_address: string | null;
  last_delivery_address: string | null;
  origin: {
    origin: "manual" | "import";
    source_label: string | null;
    import_filename: string | null;
    created_by_name: string | null;
    created_at: string;
  } | null;
  identities: ContactIdentityView[];
  orders: {
    count: number;
    spent_ngn: number;
    first_at: string | null;
    last_at: string | null;
    /** Newest 5, every status. */
    recent: { id: string; order_number: string; created_at: string; total_ngn: number; status: string; channel: string }[];
  };
  conversations: { id: string; channel: string; number_label: string; status: string; last_activity_at: string; labels: string[] }[];
  conversation_labels: string[];
  /** False when the viewer has no inbox.view: the screen says so instead of "none". */
  can_see_conversations: boolean;
  lists: { id: string; name: string; kind: "static" | "smart" }[];
  consent_now: ConsentNow[];
  shop_profile_url: string;
}

export interface ContactListView {
  id: string;
  name: string;
  kind: "static" | "smart";
  description: string | null;
  count: number;
  created_by_name: string | null;
  updated_at: string;
  archived_at: string | null;
  filter?: ContactFilter | null;
  filter_lines?: string[];
}

export interface ImportRowView {
  row_no: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  outcome: "pending" | "new" | "matched" | "rejected";
  /** Plain English. */
  reason: string | null;
  reason_code: string | null;
  matched_name: string | null;
}

/**
 * WhatsApp business profile (suite spec 05): limits, the business-type list, tidying,
 * validation and comparing. Browser-safe: no Node imports. The browser and the server
 * use the same functions so the same words appear in both.
 */

export const WA_PROFILE_LIMITS = {
  about: 139,
  address: 256,
  description: 512,
  email: 128,
  websites: 2,
  website: 256,
} as const;

/** Our own photo rules; Meta publishes none (spec 05, 3.1 and section 14, item 5). */
export const WA_PROFILE_PHOTO = {
  maxBytes: 5 * 1024 * 1024,
  minSide: 192,
  types: ["image/jpeg", "image/png"],
} as const;

/** Offered business types, in the order shown (7.3). The empty value is "Not set". */
export const WA_VERTICALS: readonly { value: string; label: string }[] = [
  { value: "RESTAURANT", label: "Restaurant" },
  { value: "GROCERY", label: "Food and grocery" },
  { value: "RETAIL", label: "Shopping and retail" },
  { value: "EVENT_PLAN", label: "Event planning" },
  { value: "HOTEL", label: "Hotel and lodging" },
  { value: "BEAUTY", label: "Beauty, spa and salon" },
  { value: "APPAREL", label: "Clothing" },
  { value: "HEALTH", label: "Medical and health" },
  { value: "EDU", label: "Education" },
  { value: "ENTERTAIN", label: "Entertainment" },
  { value: "TRAVEL", label: "Travel and transport" },
  { value: "AUTO", label: "Cars and vehicles" },
  { value: "FINANCE", label: "Finance and banking" },
  { value: "PROF_SERVICES", label: "Professional services" },
  { value: "NONPROFIT", label: "Non-profit" },
  { value: "GOVT", label: "Public service" },
  { value: "OTHER", label: "Other" },
  { value: "", label: "Not set" },
];

/** Valid at Meta but not offered on the screen (7.3). */
export const WA_VERTICALS_HIDDEN: readonly string[] = ["ALCOHOL", "OTC_DRUGS", "ONLINE_GAMBLING", "PHYSICAL_GAMBLING"];

export interface WaProfileFields {
  about: string;
  address: string;
  description: string;
  email: string;
  websites: string[];
  vertical: string;
}

export const WA_PROFILE_FIELD_KEYS = ["about", "description", "address", "email", "websites", "vertical"] as const;

const FIELD_LABELS: Record<keyof WaProfileFields, string> = {
  about: "About",
  description: "Description",
  address: "Address",
  email: "Email",
  websites: "Websites",
  vertical: "Type of business",
};

/** The plain label of a field, as the confirm dialog and the banners show it. */
export function waProfileFieldLabel(field: keyof WaProfileFields): string {
  return FIELD_LABELS[field];
}

/** The text of a business type: the offered label, else the raw value. */
export function waVerticalLabel(value: string): string {
  return WA_VERTICALS.find((v) => v.value === value)?.label ?? value;
}

/**
 * Trim every string and drop empty websites (so a second website with the first empty
 * moves up). Line breaks are kept in description and address, and removed from about
 * (turned into a space), email and websites.
 */
export function normaliseWaProfile(input: WaProfileFields): WaProfileFields {
  const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
  const noBreaks = (s: string) => s.replace(/[\r\n\s]+/g, "").trim();
  return {
    about: oneLine(input.about ?? ""),
    address: (input.address ?? "").trim(),
    description: (input.description ?? "").trim(),
    email: noBreaks(input.email ?? ""),
    websites: (input.websites ?? []).map(noBreaks).filter((w) => w !== ""),
    vertical: (input.vertical ?? "").trim(),
  };
}

export interface WaProfileValidateOptions {
  /** Also refuse text whose UTF-16 length is over the limit (the server does; an emoji counts as two there). */
  utf16?: boolean;
  /** The business type already on the profile: allowed even when it is not in the list (Meta's own value). */
  keepVertical?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field name -> plain-English problem. Empty object = valid. The profile should already be normalised. */
export function validateWaProfile(
  p: WaProfileFields,
  opts: WaProfileValidateOptions = {},
): Partial<Record<keyof WaProfileFields, string>> {
  const out: Partial<Record<keyof WaProfileFields, string>> = {};
  const over = (text: string, max: number): boolean =>
    [...text].length > max || (opts.utf16 === true && text.length > max);

  if (over(p.about, WA_PROFILE_LIMITS.about)) out.about = "Keep this to 139 characters or fewer.";
  if (over(p.address, WA_PROFILE_LIMITS.address)) out.address = "Keep the address to 256 characters or fewer.";
  if (over(p.description, WA_PROFILE_LIMITS.description)) out.description = "Keep the description to 512 characters or fewer.";
  if (p.email !== "" && (over(p.email, WA_PROFILE_LIMITS.email) || !EMAIL.test(p.email))) {
    out.email = "That does not look like an email address.";
  }
  if (p.websites.length > WA_PROFILE_LIMITS.websites) {
    out.websites = "WhatsApp allows two websites at most.";
  } else {
    for (const w of p.websites) {
      if (!/^https?:\/\//.test(w)) {
        out.websites = "Start the website with https://";
        break;
      }
      if (over(w, WA_PROFILE_LIMITS.website)) {
        out.websites = "Keep each website to 256 characters or fewer.";
        break;
      }
    }
  }
  const known =
    p.vertical === "" ||
    WA_VERTICALS.some((v) => v.value === p.vertical) ||
    WA_VERTICALS_HIDDEN.includes(p.vertical) ||
    (opts.keepVertical !== undefined && p.vertical === opts.keepVertical);
  if (!known) out.vertical = "Choose a type of business from the list.";
  return out;
}

function sameField(key: keyof WaProfileFields, a: WaProfileFields, b: WaProfileFields): boolean {
  if (key === "websites") return a.websites.length === b.websites.length && a.websites.every((w, i) => w === b.websites[i]);
  return a[key] === b[key];
}

/** The six fields of a profile that differ (names only), after tidying both. */
export function changedWaFields(a: WaProfileFields, b: WaProfileFields): (keyof WaProfileFields)[] {
  const x = normaliseWaProfile(a);
  const y = normaliseWaProfile(b);
  return WA_PROFILE_FIELD_KEYS.filter((k) => !sameField(k, x, y));
}

/** Rows for the confirm dialog: only fields that differ. Two websites are joined by a line break. */
export function diffWaProfile(
  before: WaProfileFields,
  after: WaProfileFields,
): { field: keyof WaProfileFields; label: string; before: string; after: string }[] {
  const x = normaliseWaProfile(before);
  const y = normaliseWaProfile(after);
  const show = (p: WaProfileFields, k: keyof WaProfileFields): string => {
    if (k === "websites") return p.websites.join("\n");
    if (k === "vertical") return p.vertical === "" ? "" : waVerticalLabel(p.vertical);
    return p[k];
  };
  return WA_PROFILE_FIELD_KEYS.filter((k) => !sameField(k, x, y)).map((k) => ({
    field: k,
    label: FIELD_LABELS[k],
    before: show(x, k),
    after: show(y, k),
  }));
}

/**
 * WhatsApp template authoring (suite spec 06, section 5.1): the editable draft, the rules that
 * get a template refused, and the conversions to and from Meta's `components`. Browser-safe, so
 * the editor and the server run exactly the same rules (the server never trusts the browser).
 */
import { templateNeeds } from "./inbox-templates.js";

export type DraftCategory = "MARKETING" | "UTILITY";
export type DraftHeader =
  | { format: "TEXT"; text: string; example: string } // example "" when no blank
  | { format: "IMAGE" | "VIDEO" | "DOCUMENT"; sampleKey: string; sampleMime: string; sampleName: string };
export type DraftButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string; example: string } // example = the end of the link; "" when no blank
  | { type: "PHONE_NUMBER"; text: string; phone: string }
  /** Opens a built-in WhatsApp form (suite spec 07). `flowKey` is the form's registry key; "" until one is chosen. */
  | { type: "FLOW"; text: string; flowKey: string };

/** What the server needs to turn a form button into Meta's shape: the live Flow behind each form key. */
export interface DraftFlowTarget {
  flowId: string;
  action: "navigate" | "data_exchange";
  /** The entry screen, for `navigate`. */
  screen: string;
}
export interface TemplateDraft {
  category: DraftCategory;
  header: DraftHeader | null;
  body: { text: string; examples: string[] }; // examples[i] is for {{i+1}}
  footer: string; // "" = none
  buttons: DraftButton[];
}

export const TEMPLATE_LIMITS = {
  name: 512,
  nameUi: 60,
  headerText: 60,
  body: 1024,
  footer: 60,
  buttonText: 25,
  url: 2000,
  phone: 20,
  buttons: 10,
  urlButtons: 2,
  phoneButtons: 1,
  flowButtons: 1,
  quickReplies: 10,
} as const;

export const TEMPLATE_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "en_GB", label: "English (UK)" },
  { code: "en_US", label: "English (US)" },
  { code: "ha", label: "Hausa" },
  { code: "fr", label: "French" },
] as const;

/** Sample files for a media heading (our limits, spec 3.3). */
export const TEMPLATE_SAMPLE_RULES = {
  IMAGE: { types: ["image/jpeg", "image/png"], maxBytes: 5 * 1024 * 1024, label: "a JPG or PNG picture up to 5 MB" },
  VIDEO: { types: ["video/mp4"], maxBytes: 16 * 1024 * 1024, label: "an MP4 video up to 16 MB" },
  DOCUMENT: { types: ["application/pdf"], maxBytes: 16 * 1024 * 1024, label: "a PDF up to 16 MB" },
} as const;

export const EMPTY_DRAFT: TemplateDraft = {
  category: "UTILITY",
  header: null,
  body: { text: "", examples: [] },
  footer: "",
  buttons: [],
};

export interface DraftProblem {
  field: string;
  level: "error" | "warning";
  code: string;
  message: string;
}

const NAME_RE = /^[a-z0-9_]{1,60}$/;

/** null when the name is fine, else the sentence to show. */
export function validateTemplateName(name: string): string | null {
  return NAME_RE.test(name) ? null : "Use lowercase letters, numbers and underscores only, for example order_confirmed.";
}

const NUMBERED = /\{\{(\d+)\}\}/g;
const ANY_BLANK = /\{\{([^{}]*)\}\}/g;

/** The numbers of the numbered blanks in a text, in order of appearance (repeats kept). Named blanks are ignored. */
export function blanksIn(text: string): number[] {
  return [...text.matchAll(NUMBERED)].map((m) => Number(m[1]));
}

/** Highest blank number in a text, 0 when there are none. */
function maxBlank(text: string): number {
  return blanksIn(text).reduce((a, b) => Math.max(a, b), 0);
}

function fill(text: string, examples: readonly string[]): string {
  return text.replace(NUMBERED, (whole, n: string) => {
    const e = examples[Number(n) - 1];
    return e !== undefined && e.trim() !== "" ? e : whole;
  });
}

/** Words that are not blanks: tokens with at least one letter or digit. */
function fixedWordCount(text: string): number {
  return text
    .replace(ANY_BLANK, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

const PROMO_TERMS = [
  "discount",
  "% off",
  "promo",
  "offer",
  "sale",
  "deal",
  "free",
  "buy now",
  "order now",
  "shop now",
  "limited time",
  "don't miss",
  "new flavour",
  "try our",
  "coupon",
];

const PROMO_RES = PROMO_TERMS.map((t) => {
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  const before = /^[\p{L}\p{N}]/u.test(t) ? "(?<![\\p{L}\\p{N}])" : "";
  const after = /[\p{L}\p{N}]$/u.test(t) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${before}${esc}${after}`, "iu");
});

function sellsSomething(text: string): boolean {
  const t = text.replace(/[\u2019\u2018]/g, "'");
  return PROMO_RES.some((re) => re.test(t));
}

const SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "wa.me"];

function hostOf(url: string): string | null {
  const m = /^https?:\/\/([^/?#:\s]+)/i.exec(url.trim());
  return m ? m[1]!.toLowerCase() : null;
}

function brokenBraces(text: string): boolean {
  return /[{}]/.test(text.replace(ANY_BLANK, ""));
}

function badSpacing(example: string): boolean {
  return /[\n\r\t]/.test(example) || / {4,}/.test(example);
}

const PHONE_RE = /^\+[1-9]\d{7,14}$/;

export interface ValidateContext {
  name: string;
  others: { name: string; body: string; footer: string }[];
}

/** Every rule in spec 5.1. `error` blocks submitting; `warning` needs a tick. */
export function validateDraft(d: TemplateDraft, ctx: ValidateContext): DraftProblem[] {
  const out: DraftProblem[] = [];
  const add = (field: string, level: "error" | "warning", code: string, message: string): void => {
    out.push({ field, level, code, message });
  };

  const nameProblem = validateTemplateName(ctx.name);
  if (nameProblem) add("name", "error", "name_format", nameProblem);

  // ── Body ──
  const body = d.body.text;
  const trimmed = body.trim();
  if (trimmed === "") add("body", "error", "body_empty", "Write the message.");
  if (body.length > TEMPLATE_LIMITS.body) {
    add("body", "error", "body_long", "The message is too long. WhatsApp allows 1,024 characters.");
  }

  const numbered = blanksIn(body);
  const distinct = [...new Set(numbered)];
  const n = distinct.length === 0 ? 0 : Math.max(...distinct);
  let ordered = distinct.length === n;
  if (ordered) for (let i = 1; i <= n; i++) if (!distinct.includes(i)) ordered = false;
  // First appearances must also climb: {{2}} before {{1}} is "out of order" at Meta.
  if (ordered) {
    const firsts = numbered.filter((v, i) => numbered.indexOf(v) === i);
    if (firsts.some((v, i) => v !== i + 1)) ordered = false;
  }
  if (!ordered) {
    add("body", "error", "blank_order", "Number the blanks in order: {{1}}, then {{2}}, with none missing.");
  }

  if (/^\{\{/.test(trimmed) || /\}\}$/.test(trimmed) || /\}\}[\p{P}]$/u.test(trimmed)) {
    add("body", "error", "blank_edge", "Do not start or end the message with a blank. Put words before and after it.");
  }
  if (/\}\}[ \t]*\{\{/.test(body)) {
    add("body", "error", "blank_adjacent", "Put some words between two blanks.");
  }
  if ([...body.matchAll(ANY_BLANK)].some((m) => !/^\d+$/.test(m[1] ?? ""))) {
    add("body", "error", "blank_named", "Use numbered blanks like {{1}}. Named blanks cannot be sent from the inbox yet.");
  }
  if (brokenBraces(body)) {
    add("body", "error", "brace_mismatch", "A blank looks broken. Write it exactly like {{1}}.");
  }
  for (let i = 1; i <= n; i++) {
    if (distinct.includes(i) && (d.body.examples[i - 1] ?? "").trim() === "") {
      add(`body.examples.${i - 1}`, "error", "example_missing", `Give an example for blank {{${i}}}. WhatsApp will not review the template without one.`);
    }
  }

  // ── Header ──
  const h = d.header;
  if (h && h.format === "TEXT") {
    if (h.text.length > TEMPLATE_LIMITS.headerText) {
      add("header", "error", "header_long", "Keep the heading to 60 characters.");
    }
    const hb = blanksIn(h.text);
    const anyHeaderBlank = [...h.text.matchAll(ANY_BLANK)].length;
    if (hb.length > 1 || anyHeaderBlank > hb.length || hb.some((v) => v !== 1) || brokenBraces(h.text)) {
      add("header", "error", "header_blanks", "A heading can have one blank at most: {{1}}.");
    } else if (hb.length === 1 && h.example.trim() === "") {
      add("header.example", "error", "example_missing", "Give an example for blank {{1}}. WhatsApp will not review the template without one.");
    }
  } else if (h && h.sampleKey === "") {
    add("header", "error", "header_sample", "Add a sample picture, video or PDF for the heading. WhatsApp needs one to review.");
  }

  // ── Footer ──
  if (d.footer.length > TEMPLATE_LIMITS.footer) add("footer", "error", "footer_long", "Keep the small print to 60 characters.");
  if (d.footer.includes("{{")) add("footer", "error", "footer_blank", "The small print cannot have blanks.");

  // ── Buttons ──
  const urls = d.buttons.filter((b) => b.type === "URL").length;
  const phones = d.buttons.filter((b) => b.type === "PHONE_NUMBER").length;
  if (d.buttons.length > TEMPLATE_LIMITS.buttons || urls > TEMPLATE_LIMITS.urlButtons || phones > TEMPLATE_LIMITS.phoneButtons) {
    add("buttons", "error", "button_counts", "Too many buttons. WhatsApp allows 10 in all, with at most 2 links and 1 phone number.");
  }
  if (d.buttons.filter((b) => b.type === "FLOW").length > TEMPLATE_LIMITS.flowButtons) {
    add("buttons", "error", "flow_count", "A template can have one form button at most.");
  }
  let flips = 0;
  for (let i = 1; i < d.buttons.length; i++) {
    if ((d.buttons[i]!.type === "QUICK_REPLY") !== (d.buttons[i - 1]!.type === "QUICK_REPLY")) flips++;
  }
  if (flips > 1) {
    add("buttons", "error", "button_group", "Keep the reply buttons together, either all first or all last.");
  }
  d.buttons.forEach((b, i) => {
    const label = b.text.trim();
    if (label === "" || label.length > TEMPLATE_LIMITS.buttonText) {
      add(`buttons.${i}.text`, "error", "button_text", "Give each button a label of 25 characters or fewer.");
    } else if (/[^\p{L}\p{N} ]/u.test(label)) {
      add(`buttons.${i}.text`, "warning", "button_label_chars", "WhatsApp asks for letters and numbers only on buttons. Remove symbols or emoji to be safe.");
    }
    if (b.type === "URL") {
      const url = b.url.trim();
      const blanks = [...url.matchAll(ANY_BLANK)].map((m) => m[0]);
      const withBlank = blanks.length === 1 && blanks[0] === "{{1}}" && url.endsWith("{{1}}");
      const plain = blanks.length === 0 && !/[{}]/.test(url);
      const stripped = withBlank ? url.slice(0, -5) : url;
      const okShape =
        /^https:\/\/[^/\s{}]+/.test(url) && !/\s/.test(url) && url.length <= TEMPLATE_LIMITS.url && (plain || (withBlank && !/[{}]/.test(stripped)));
      if (!okShape) {
        add(`buttons.${i}.url`, "error", "url_format", "A link must start with https:// and can have one blank, {{1}}, at the very end.");
      } else {
        if (withBlank && b.example.trim() === "") {
          add(`buttons.${i}.example`, "error", "example_missing", "Give an example for the end of the link. WhatsApp will not review the template without one.");
        }
        const host = hostOf(url);
        if (host && SHORTENERS.includes(host)) {
          add(`buttons.${i}.url`, "warning", "shortener", "Use your own website address, not a short link.");
        }
      }
    } else if (b.type === "PHONE_NUMBER") {
      if (!PHONE_RE.test(b.phone.trim())) {
        add(`buttons.${i}.phone`, "error", "phone_format", "Write the phone number with its country code, for example +2348012345678.");
      }
    } else if (b.type === "FLOW") {
      if (b.flowKey.trim() === "") add(`buttons.${i}.flowKey`, "error", "flow_missing", "Choose which form the button opens.");
    }
  });

  // ── Warnings ──
  const blankCount = numbered.length;
  if (blankCount > 0 && fixedWordCount(body) < 4 * blankCount) {
    add("body", "warning", "blank_ratio", "This has a lot of blanks for a short message. WhatsApp often refuses that. Add more fixed words.");
  }
  const examples = [
    ...d.body.examples,
    ...(h && h.format === "TEXT" ? [h.example] : []),
    ...d.buttons.flatMap((b) => (b.type === "URL" ? [b.example] : [])),
  ];
  if (examples.some(badSpacing)) {
    add("body.examples", "warning", "blank_symbols", "Keep each example on one line without long gaps.");
  }
  if (/(\r?\n){3,}/.test(body)) add("body", "warning", "newlines", "Remove extra empty lines.");
  if (d.category === "UTILITY") {
    const parts = [body, h && h.format === "TEXT" ? h.text : "", d.footer];
    if (parts.some((p) => sellsSomething(p))) {
      add(
        "body",
        "warning",
        "utility_promo",
        "This reads like a promotion. WhatsApp will file it under Marketing instead of Order and account updates. Remove the selling words, or change the type to Marketing.",
      );
    }
  }
  const same = ctx.others.find((o) => o.body.trim() === trimmed && o.footer.trim() === d.footer.trim() && trimmed !== "");
  if (same) {
    add("body", "warning", "duplicate", `This says the same as “${same.name}”. WhatsApp refuses copies. Change the wording or use that one.`);
  }
  return out;
}

/**
 * The `components` Meta wants (spec 3.3), in the order header, body, footer, buttons. Parts that are
 * empty are left out; `example` is left out where a part has no blank. `headerHandle` is the upload
 * handle for a media heading. `flatBodyExamples` is the fallback shape (spec 3.3, unverified nesting).
 */
export function draftToComponents(
  d: TemplateDraft,
  headerHandle: string | null,
  opts: { flatBodyExamples?: boolean; flows?: Readonly<Record<string, DraftFlowTarget>> } = {},
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const h = d.header;
  if (h && h.format === "TEXT") {
    if (h.text.trim() !== "") {
      const c: Record<string, unknown> = { type: "HEADER", format: "TEXT", text: h.text };
      if (maxBlank(h.text) > 0) c.example = { header_text: [h.example] };
      out.push(c);
    }
  } else if (h) {
    const c: Record<string, unknown> = { type: "HEADER", format: h.format };
    if (headerHandle) c.example = { header_handle: [headerHandle] };
    out.push(c);
  }
  const bodyBlanks = maxBlank(d.body.text);
  const body: Record<string, unknown> = { type: "BODY", text: d.body.text };
  if (bodyBlanks > 0) {
    const ex = Array.from({ length: bodyBlanks }, (_, i) => d.body.examples[i] ?? "");
    body.example = { body_text: opts.flatBodyExamples ? ex : [ex] };
  }
  out.push(body);
  if (d.footer.trim() !== "") out.push({ type: "FOOTER", text: d.footer });
  if (d.buttons.length > 0) {
    out.push({
      type: "BUTTONS",
      buttons: d.buttons.map((b) => {
        if (b.type === "QUICK_REPLY") return { type: "QUICK_REPLY", text: b.text };
        if (b.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone };
        if (b.type === "FLOW") {
          // The caller (the submit route) resolves the form to its live Flow first and refuses when there is none.
          const target = opts.flows?.[b.flowKey];
          if (!target) throw new Error(`no live form for the button "${b.text}"`);
          return {
            type: "FLOW",
            text: b.text,
            flow_id: target.flowId,
            flow_action: target.action,
            ...(target.action === "navigate" ? { navigate_screen: target.screen } : {}),
          };
        }
        const btn: Record<string, unknown> = { type: "URL", text: b.text, url: b.url };
        if (b.url.includes("{{1}}")) btn.example = [b.url.replace("{{1}}", b.example)];
        return btn;
      }),
    });
  }
  return out;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The reverse, for editing a template Meta already holds. null when the inbox cannot send the
 * template (`templateNeeds`), the type is not Marketing or Utility, or there is no body: the editor
 * cannot open it and the screen says so. A media heading comes back with `sampleKey: ""`.
 * A form button is mapped back through `opts.flowKeys` (Meta's Flow ID -> our form key); a form we
 * do not know makes the template read-only, as before.
 */
export function componentsToDraft(
  components: readonly unknown[],
  category: string | null,
  opts: { flowKeys?: Readonly<Record<string, string>> } = {},
): TemplateDraft | null {
  const cat = (category ?? "").toUpperCase();
  if (cat !== "MARKETING" && cat !== "UTILITY") return null;
  if (!templateNeeds(components, cat).sendable) return null;
  const draft: TemplateDraft = { category: cat, header: null, body: { text: "", examples: [] }, footer: "", buttons: [] };
  let hasBody = false;
  for (const raw of components) {
    const c = rec(raw);
    if (!c) return null;
    const type = String(c.type ?? "").toUpperCase();
    if (type === "HEADER") {
      const format = String(c.format ?? "TEXT").toUpperCase();
      if (format === "TEXT") {
        const text = typeof c.text === "string" ? c.text : "";
        draft.header = { format: "TEXT", text, example: strs(rec(c.example)?.header_text)[0] ?? "" };
      } else if (format === "IMAGE" || format === "VIDEO" || format === "DOCUMENT") {
        draft.header = { format, sampleKey: "", sampleMime: "", sampleName: "" };
      } else return null;
    } else if (type === "BODY") {
      hasBody = true;
      const text = typeof c.text === "string" ? c.text : "";
      const bt = rec(c.example)?.body_text;
      const nested = Array.isArray(bt) && Array.isArray(bt[0]) ? strs(bt[0]) : strs(bt);
      const count = maxBlank(text);
      draft.body = { text, examples: Array.from({ length: count }, (_, i) => nested[i] ?? "") };
    } else if (type === "FOOTER") {
      draft.footer = typeof c.text === "string" ? c.text : "";
    } else if (type === "BUTTONS") {
      for (const rb of Array.isArray(c.buttons) ? c.buttons : []) {
        const b = rec(rb);
        if (!b) return null;
        const bType = String(b.type ?? "").toUpperCase();
        const text = typeof b.text === "string" ? b.text : "";
        if (bType === "QUICK_REPLY") draft.buttons.push({ type: "QUICK_REPLY", text });
        else if (bType === "PHONE_NUMBER") draft.buttons.push({ type: "PHONE_NUMBER", text, phone: typeof b.phone_number === "string" ? b.phone_number : "" });
        else if (bType === "URL") {
          const url = typeof b.url === "string" ? b.url : "";
          let example = strs(b.example)[0] ?? "";
          const at = url.indexOf("{{1}}");
          if (at >= 0) {
            const prefix = url.slice(0, at);
            if (example.startsWith(prefix)) example = example.slice(prefix.length);
          } else example = "";
          draft.buttons.push({ type: "URL", text, url, example });
        } else if (bType === "FLOW") {
          const id = typeof b.flow_id === "string" ? b.flow_id : typeof b.flow_id === "number" ? String(b.flow_id) : "";
          const flowKey = id ? opts.flowKeys?.[id] : undefined;
          if (!flowKey) return null;
          draft.buttons.push({ type: "FLOW", text, flowKey });
        } else return null;
      }
    } else return null;
  }
  return hasBody ? draft : null;
}

export function draftPreview(d: TemplateDraft): {
  header: string | null;
  headerMedia: "image" | "video" | "document" | null;
  body: string;
  footer: string | null;
  buttons: string[];
} {
  const h = d.header;
  return {
    header: h && h.format === "TEXT" && h.text.trim() !== "" ? fill(h.text, [h.example]) : null,
    headerMedia: h && h.format !== "TEXT" ? (h.format.toLowerCase() as "image" | "video" | "document") : null,
    body: fill(d.body.text, d.body.examples),
    footer: d.footer.trim() !== "" ? d.footer : null,
    buttons: d.buttons.map((b) => b.text),
  };
}

const DAY_MS = 24 * 3600 * 1000;
const MONTH_MS = 30 * DAY_MS;

/** Meta's edit limit for an approved template: one change in 24 hours, ten in 30 days. */
export function editsLeft(times: readonly string[], now: Date): { today: number; month: number } {
  const t = now.getTime();
  const recent = times.map((x) => Date.parse(x)).filter((x) => Number.isFinite(x) && x <= t && t - x < MONTH_MS);
  const today = recent.some((x) => t - x < DAY_MS) ? 0 : 1;
  return { today, month: Math.max(0, 10 - recent.length) };
}

/** When the next edit is possible: the later of the end of the day and the month limits (null when free now). */
export function nextEditAt(times: readonly string[], now: Date): { day: Date | null; month: Date | null } {
  const t = now.getTime();
  const recent = times
    .map((x) => Date.parse(x))
    .filter((x) => Number.isFinite(x) && x <= t && t - x < MONTH_MS)
    .sort((a, b) => a - b);
  const last = recent[recent.length - 1];
  const day = last !== undefined && t - last < DAY_MS ? new Date(last + DAY_MS) : null;
  // The tenth-newest edit leaves the 30-day window first once ten are used.
  const month = recent.length >= 10 ? new Date(recent[recent.length - 10]! + MONTH_MS) : null;
  return { day, month };
}

/** Meta writes `en-US` in webhooks and `en_US` in lists. We store the underscore form. */
export function normaliseTemplateLanguage(code: string): string {
  return code.trim().replace(/-/g, "_");
}

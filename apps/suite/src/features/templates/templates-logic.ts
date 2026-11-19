/**
 * Pure helpers for the template editor (suite spec 06, section 7.4): inserting blanks, keeping the
 * example boxes in step with the message, the button list rules, and the checks on a sample file.
 * No React here, so every rule has a test.
 */
import { blanksIn, TEMPLATE_LIMITS, TEMPLATE_SAMPLE_RULES, type DraftButton, type TemplateDraft } from "@ms/shared";

/** The next blank number: one more than the highest in the text. */
export function nextBlank(text: string): number {
  return blanksIn(text).reduce((a, b) => Math.max(a, b), 0) + 1;
}

/** Put `{{n}}` into the text at the cursor (or the end), returning the new text and where the cursor goes. */
export function insertBlank(text: string, at: number | null): { text: string; cursor: number } {
  const token = `{{${nextBlank(text)}}}`;
  const pos = at === null || at < 0 || at > text.length ? text.length : at;
  return { text: text.slice(0, pos) + token + text.slice(pos), cursor: pos + token.length };
}

/** One example per blank, keeping what is typed. A blank that has gone loses its example; a new one starts empty. */
export function syncExamples(text: string, examples: readonly string[]): string[] {
  const n = blanksIn(text).reduce((a, b) => Math.max(a, b), 0);
  return Array.from({ length: n }, (_, i) => examples[i] ?? "");
}

/** Suggested example text: 1 is a name, the others look like an order number. */
export function examplePlaceholder(n: number): string {
  return n === 1 ? "Ada" : "MS-10482";
}

export type ButtonKind = DraftButton["type"];

export function newButton(kind: ButtonKind): DraftButton {
  if (kind === "QUICK_REPLY") return { type: "QUICK_REPLY", text: "" };
  if (kind === "URL") return { type: "URL", text: "", url: "https://", example: "" };
  if (kind === "FLOW") return { type: "FLOW", text: "", flowKey: "" };
  return { type: "PHONE_NUMBER", text: "", phone: "+234" };
}

/** Which kinds may still be added, and why not when they may not (7.4, section 6 of the form). */
export function buttonMenu(buttons: readonly DraftButton[]): { kind: ButtonKind; label: string; disabled: string | null }[] {
  const full = buttons.length >= TEMPLATE_LIMITS.buttons;
  const urls = buttons.filter((b) => b.type === "URL").length;
  const phones = buttons.filter((b) => b.type === "PHONE_NUMBER").length;
  const forms = buttons.filter((b) => b.type === "FLOW").length;
  return [
    { kind: "QUICK_REPLY", label: "Reply button", disabled: full ? "Ten buttons at most" : null },
    { kind: "URL", label: "Link button", disabled: full ? "Ten buttons at most" : urls >= TEMPLATE_LIMITS.urlButtons ? "Two links at most" : null },
    {
      kind: "PHONE_NUMBER",
      label: "Call button",
      disabled: full ? "Ten buttons at most" : phones >= TEMPLATE_LIMITS.phoneButtons ? "One phone number at most" : null,
    },
    // Opens a built-in WhatsApp form (suite spec 07, 5.5a).
    {
      kind: "FLOW",
      label: "Form button",
      disabled: full ? "Ten buttons at most" : forms >= TEMPLATE_LIMITS.flowButtons ? "One form button at most" : null,
    },
  ];
}

/** Move one button up (-1) or down (+1). Out of range changes nothing. */
export function moveButton<T>(items: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  const next = [...items];
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** A link button's text ends with a blank, so it needs an example for it. */
export function urlHasBlank(url: string): boolean {
  return url.includes("{{");
}

/** Typing into a name box: lowercase, spaces and dashes to underscores, nothing else (7.3). */
export function tidyTemplateName(input: string): string {
  return input.toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

export type SampleFormat = "IMAGE" | "VIDEO" | "DOCUMENT";

/** A problem with a chosen sample file in plain words, or null when it is fine. */
export function sampleProblem(file: { type: string; size: number }, format: SampleFormat): string | null {
  const rule = TEMPLATE_SAMPLE_RULES[format];
  if (!(rule.types as readonly string[]).includes(file.type)) return `Choose ${rule.label}.`;
  if (file.size > rule.maxBytes) return `That file is too big. Choose ${rule.label}.`;
  if (file.size === 0) return "That file is empty.";
  return null;
}

/** What the file picker should offer for each heading kind. */
export const SAMPLE_ACCEPT: Record<SampleFormat, string> = {
  IMAGE: "image/jpeg,image/png",
  VIDEO: "video/mp4",
  DOCUMENT: "application/pdf",
};

/** Same content? (The editor compares the draft with what the server holds to know if anything changed.) */
export function sameDraft(a: TemplateDraft | null, b: TemplateDraft | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Change the heading kind, keeping what can be kept. */
export function withHeaderKind(d: TemplateDraft, kind: "NONE" | "TEXT" | SampleFormat): TemplateDraft {
  if (kind === "NONE") return { ...d, header: null };
  if (kind === "TEXT") return d.header?.format === "TEXT" ? d : { ...d, header: { format: "TEXT", text: "", example: "" } };
  if (d.header && d.header.format === kind) return d;
  return { ...d, header: { format: kind, sampleKey: "", sampleMime: "", sampleName: "" } };
}

/** "Saved just now", "Saving…" and friends for the strip beside the buttons. */
export function saveStatusText(s: "idle" | "dirty" | "saving" | "saved" | "failed" | "stopped"): string {
  switch (s) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved just now";
    case "dirty":
      return "Unsaved changes";
    case "failed":
      return "Not saved. We will try again when you change something.";
    case "stopped":
      return "Not saved";
    default:
      return "";
  }
}

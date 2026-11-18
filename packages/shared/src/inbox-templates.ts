/**
 * What a WhatsApp message template needs before it can be sent, worked out
 * from the `components` Meta returns for it (GET /{waba}/message_templates).
 * One function, shared by the API (which refuses what it can't send before
 * calling Meta), the admin picker and the mobile app. Browser-safe.
 *
 * The inbox can send:
 *   - BODY with numbered blanks {{1}}, {{2}}…
 *   - HEADER format TEXT, with at most one blank
 *   - HEADER format IMAGE / VIDEO / DOCUMENT (staff attach the file)
 *   - FOOTER
 *   - BUTTONS of type URL (fixed, or with one {{1}} blank), PHONE_NUMBER
 *     and QUICK_REPLY
 * Anything else — and anything this code does not recognise — is reported as
 * not sendable with a plain-English reason, so a new Meta feature is refused
 * cleanly instead of failing at Meta.
 */

export type TemplateHeaderMedia = "image" | "video" | "document";

export interface TemplateUrlButton {
  /** Position in the template's button list (Meta's `index`), from 0. */
  index: number;
  /** The button's label. */
  text: string;
  /** The link, with {{1}} where the blank goes. */
  url: string;
}

export interface TemplateNeeds {
  /** Can the inbox send this template at all? */
  sendable: boolean;
  /** Plain-English reason when it can't. */
  reason: string | null;
  /** How many numbered blanks the body has. */
  bodyParams: number;
  /** Text shown above the body (TEXT header), or null. */
  headerText: string | null;
  /** Blanks in the TEXT header: 0 or 1. */
  headerParams: number;
  /** The file staff must attach for the header, or null. */
  headerMedia: TemplateHeaderMedia | null;
  /** Link buttons that have a blank to fill. */
  urlButtons: TemplateUrlButton[];
  /** Small print under the body, or null. */
  footerText: string | null;
  /** Labels of every button, in order, for the preview. */
  buttonLabels: string[];
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function placeholders(text: string | null | undefined): { max: number; named: boolean } {
  let max = 0;
  let named = false;
  for (const m of (text ?? "").matchAll(PLACEHOLDER)) {
    const inner = m[1] ?? "";
    if (/^\d+$/.test(inner)) max = Math.max(max, Number(inner));
    else named = true;
  }
  return { max, named };
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

const cant = (what: string): string => `This template ${what}, which the inbox can't send yet`;

const UNSENDABLE_BUTTONS: Record<string, string> = {
  COPY_CODE: "has a copy-code button",
  OTP: "is a login-code message",
  FLOW: "opens a form",
  CATALOG: "shows the product catalogue",
  MPM: "shows a list of products",
  SPM: "shows a product",
  VOICE_CALL: "has a WhatsApp call button",
  APP: "has an app button",
};

/** Work out what a template needs. Never throws; unknown shapes are "not sendable". */
export function templateNeeds(components: readonly unknown[] | null | undefined, category?: string | null): TemplateNeeds {
  const needs: TemplateNeeds = {
    sendable: true,
    reason: null,
    bodyParams: 0,
    headerText: null,
    headerParams: 0,
    headerMedia: null,
    urlButtons: [],
    footerText: null,
    buttonLabels: [],
  };
  const problems: string[] = [];
  let named = false;

  if ((category ?? "").toUpperCase() === "AUTHENTICATION") problems.push(cant("is a login-code message"));

  for (const raw of components ?? []) {
    const c = obj(raw);
    if (!c) {
      problems.push(cant("has a part the inbox doesn't recognise"));
      continue;
    }
    const type = String(c.type ?? "").toUpperCase();
    switch (type) {
      case "BODY": {
        const p = placeholders(str(c.text));
        needs.bodyParams = p.max;
        named ||= p.named;
        break;
      }
      case "FOOTER":
        needs.footerText = str(c.text);
        break;
      case "HEADER": {
        const format = String(c.format ?? "TEXT").toUpperCase();
        if (format === "TEXT") {
          const p = placeholders(str(c.text));
          needs.headerText = str(c.text);
          needs.headerParams = p.max;
          named ||= p.named;
          if (p.max > 1) problems.push(cant("has more than one blank in its heading"));
        } else if (format === "IMAGE" || format === "VIDEO" || format === "DOCUMENT") {
          needs.headerMedia = format.toLowerCase() as TemplateHeaderMedia;
        } else if (format === "LOCATION") {
          problems.push(cant("has a map location"));
        } else {
          problems.push(cant("has a heading the inbox doesn't recognise"));
        }
        break;
      }
      case "BUTTONS": {
        const buttons = Array.isArray(c.buttons) ? c.buttons : [];
        buttons.forEach((rawButton, index) => {
          const b = obj(rawButton);
          const bType = String(b?.type ?? "").toUpperCase();
          needs.buttonLabels.push(str(b?.text) ?? "Button");
          if (bType === "URL") {
            const url = str(b?.url) ?? "";
            const p = placeholders(url);
            named ||= p.named;
            if (p.max > 1) problems.push(cant("has a link with more than one blank"));
            else if (p.max === 1) needs.urlButtons.push({ index, text: str(b?.text) ?? "Link", url });
          } else if (bType === "PHONE_NUMBER" || bType === "QUICK_REPLY") {
            // Nothing to fill in.
          } else {
            problems.push(cant(UNSENDABLE_BUTTONS[bType] ?? "has a button the inbox doesn't recognise"));
          }
        });
        break;
      }
      case "CAROUSEL":
        problems.push(cant("has a carousel"));
        break;
      case "LIMITED_TIME_OFFER":
        problems.push(cant("has a limited-time offer"));
        break;
      default:
        problems.push(cant("has a part the inbox doesn't recognise"));
    }
  }
  if (named) problems.push(cant("uses named blanks"));

  if (problems.length > 0) {
    // The most telling reason first: a carousel explains more than its buttons do.
    needs.sendable = false;
    needs.reason = problems.find((p) => p.includes("carousel")) ?? problems[0]!;
  }
  return needs;
}

/** What to call the file a template needs, in plain words. */
export function headerMediaLabel(kind: TemplateHeaderMedia): string {
  return kind === "image" ? "picture" : kind;
}

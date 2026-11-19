/**
 * Plain-English wording for WhatsApp template states (suite spec 06, 7.2). Browser-safe and shared
 * by the screens, the API (not_editable_reason) and the worker (owner alerts), so the same words
 * appear everywhere.
 */
import { componentsToDraft } from "./template-draft.js";
import { templateNeeds } from "./inbox-templates.js";

export type TemplateTone = "grey" | "amber" | "green" | "red";

const STATUS: Record<string, { label: string; tone: TemplateTone; line: string }> = {
  DRAFT: { label: "Draft", tone: "grey", line: "Only in the suite. Not sent to WhatsApp yet." },
  PENDING: { label: "Waiting for WhatsApp", tone: "amber", line: "WhatsApp is checking it. This can take up to a day." },
  APPROVED: { label: "Approved", tone: "green", line: "Ready to send." },
  REJECTED: { label: "Refused", tone: "red", line: "" },
  PAUSED: {
    label: "Paused",
    tone: "amber",
    line: "Customers reacted badly, so WhatsApp paused it for a few hours. It will come back by itself.",
  },
  DISABLED: { label: "Switched off", tone: "red", line: "WhatsApp switched it off for good. Write a new one with different wording." },
  IN_APPEAL: { label: "Under appeal", tone: "amber", line: "WhatsApp is looking at it again." },
  LIMIT_EXCEEDED: { label: "Over the limit", tone: "red", line: "You have too many templates. Delete ones you do not use." },
  ARCHIVED: { label: "Archived", tone: "grey", line: "Not used for a year. WhatsApp deletes it 28 days after archiving." },
  PENDING_DELETION: { label: "Being deleted", tone: "grey", line: "" },
};

const REASONS: Record<string, string> = {
  INVALID_FORMAT:
    "The layout breaks one of WhatsApp's rules, for example a blank at the start or end, two blanks side by side, or a missing example.",
  ABUSIVE_CONTENT: "WhatsApp found wording it treats as abusive or threatening.",
  PROMOTIONAL: "WhatsApp says the wording breaks its rules on promotions.",
  SCAM: "WhatsApp thinks customers could mistake this for a scam.",
  INCORRECT_CATEGORY: "The wording does not match the type you chose.",
  TAG_CONTENT_MISMATCH: "The wording does not match the type you chose.",
};

/** Why WhatsApp refused a template, in a sentence, with its advice when it gave any. */
export function refusalReasonText(reason: string | null | undefined, recommendation?: string | null): string {
  const base = REASONS[String(reason ?? "").toUpperCase()] ?? "WhatsApp did not give a reason.";
  const advice = recommendation?.trim();
  return advice ? `${base} WhatsApp's advice: ${advice}` : base;
}

/** Pill label, colour and the line under it. `refusal` fills the REJECTED line. */
export function templateStatusWording(
  status: string,
  refusal?: { reason?: string | null; recommendation?: string | null },
): { label: string; tone: TemplateTone; line: string } {
  const s = STATUS[status];
  if (!s) return { label: status, tone: "grey", line: "" };
  if (status === "REJECTED") {
    return { ...s, line: `${refusalReasonText(refusal?.reason, refusal?.recommendation)} Change it and send it again.` };
  }
  return s;
}

export function templateQualityWording(score: string | null | undefined): { label: string; tone: TemplateTone } {
  switch (String(score ?? "").toUpperCase()) {
    case "GREEN":
      return { label: "Customers like it", tone: "green" };
    case "YELLOW":
      return { label: "Some customers are blocking or ignoring it", tone: "amber" };
    case "RED":
      return { label: "Many customers are blocking or ignoring it. It may be paused", tone: "red" };
    default:
      return { label: "Not rated yet", tone: "grey" };
  }
}

export function templateCategoryLabel(category: string | null | undefined): string {
  switch (String(category ?? "").toUpperCase()) {
    case "UTILITY":
      return "Order and account updates";
    case "MARKETING":
      return "Marketing";
    case "AUTHENTICATION":
      return "Login codes";
    default:
      return category ? String(category) : "Unknown type";
  }
}

const NOT_EDITABLE_STATUSES = new Set(["PENDING", "IN_APPEAL", "DISABLED", "PENDING_DELETION", "DELETED", "ARCHIVED", "LIMIT_EXCEEDED"]);

/** Can the editor change this template, and if not, why (spec 5.4 and 7.2). */
export function templateEditability(row: {
  status: string;
  category: string | null;
  components: readonly unknown[] | null;
  reviewInfo?: { locked?: boolean } | null;
}): { editable: boolean; reason: string | null } {
  if (row.status === "DRAFT") return { editable: true, reason: null };
  if (row.status === "PENDING" || row.status === "IN_APPEAL") {
    return { editable: false, reason: "WhatsApp is checking this template. You can change it once it has decided." };
  }
  if (row.status === "DISABLED") {
    return { editable: false, reason: "This template is switched off for good and cannot be changed." };
  }
  if (NOT_EDITABLE_STATUSES.has(row.status)) {
    return { editable: false, reason: "This template cannot be changed in its current state." };
  }
  if (row.reviewInfo?.locked) return { editable: false, reason: "WhatsApp has locked this template." };
  if (!componentsToDraft(row.components ?? [], row.category)) {
    const needs = templateNeeds(row.components ?? [], row.category);
    const why = needs.reason ?? "This template has a part the suite cannot edit yet";
    return {
      editable: false,
      reason: `This template has a part the suite cannot edit yet (${why.replace(/^This template /, "").replace(/\.$/, "")}). Change it in WhatsApp Manager.`,
    };
  }
  return { editable: true, reason: null };
}

/** The sentence for an owner alert, by kind (spec 5.2). `at` is already a Lagos-time phrase. */
export function templateAlertWording(
  kind: string,
  d: { reason?: string | null; recommendation?: string | null; category?: string | null; correctCategory?: string | null; at?: string | null },
): { title: string; sentence: string } {
  const cat = (c: string | null | undefined): string => templateCategoryLabel(c);
  switch (kind) {
    case "rejected":
      return { title: "refused", sentence: `WhatsApp refused it: ${refusalReasonText(d.reason, d.recommendation)}` };
    case "paused":
      return { title: "paused", sentence: "Customers reacted badly, so WhatsApp paused it for a few hours. It cannot be sent until then." };
    case "disabled":
      return { title: "switched off", sentence: "WhatsApp has switched it off for good. Write a new one with different wording." };
    case "flagged":
      return { title: "at risk", sentence: "Customers are reacting badly. It may be paused soon." };
    case "quality_red":
      return { title: "low quality", sentence: "Its quality is now low." };
    case "category_notice":
      return {
        title: "will be re-filed",
        sentence: `WhatsApp will move it from ${cat(d.category)} to ${cat(d.correctCategory)} on ${d.at ?? "a date it has not given"}.`,
      };
    case "category_changed":
    case "approved_as_marketing":
      return { title: "re-filed", sentence: `WhatsApp now files it under ${cat(d.category)}.` };
    case "archived":
      return { title: "archived", sentence: "Not used for a year. WhatsApp will delete it in 28 days unless it is restored in WhatsApp Manager." };
    default:
      return { title: "changed", sentence: "WhatsApp changed it." };
  }
}

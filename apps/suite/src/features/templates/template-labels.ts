/**
 * Plain wording for template states on screen (suite spec 06, 7.2). The words live in @ms/shared so the
 * API and the worker's owner alerts say the same things; this file adds the list's filters and notes.
 */
import { componentsToDraft, templateCategoryLabel, templateStatusWording, type TemplateTone, type TemplateDraft } from "@ms/shared";
import type { TemplateRow } from "./templates-api.js";

export { refusalReasonText, templateCategoryLabel, templateQualityWording, templateStatusWording } from "@ms/shared";
export type { TemplateTone } from "@ms/shared";

export const TONE_PILL: Record<TemplateTone, string> = {
  grey: "pill",
  amber: "pill pill--warning",
  green: "pill pill--success",
  red: "pill pill--danger",
};

/** The pill and the line under it for a row, with the refusal reason filled in. */
export function statusOf(row: Pick<TemplateRow, "status" | "rejected_reason" | "review_info">) {
  return templateStatusWording(row.status, {
    reason: row.review_info?.rejection?.reason ?? row.rejected_reason,
    recommendation: row.review_info?.rejection?.recommendation ?? null,
  });
}

export type ListChip = "all" | "drafts" | "waiting" | "approved" | "attention";
export const CHIPS: { id: ListChip; label: string }[] = [
  { id: "all", label: "All" },
  { id: "drafts", label: "Drafts" },
  { id: "waiting", label: "Waiting" },
  { id: "approved", label: "Approved" },
  { id: "attention", label: "Needs attention" },
];

/** REJECTED, PAUSED, DISABLED, FLAGGED, quality RED, a pending category change, or a failed send. */
export function needsAttention(row: TemplateRow): boolean {
  return (
    ["REJECTED", "PAUSED", "DISABLED"].includes(row.status) ||
    row.review_info?.flagged === true ||
    row.quality_score === "RED" ||
    row.correct_category !== null ||
    row.last_error !== null
  );
}

export function matchesChip(row: TemplateRow, chip: ListChip): boolean {
  switch (chip) {
    case "all":
      return true;
    case "drafts":
      return row.status === "DRAFT";
    case "waiting":
      return row.status === "PENDING" || row.status === "IN_APPEAL";
    case "approved":
      return row.status === "APPROVED";
    case "attention":
      return needsAttention(row);
  }
}

/** The editable copy of a row: its unsent draft, else what WhatsApp holds, else null (the editor cannot open it). */
export function draftOfRow(row: TemplateRow): TemplateDraft | null {
  if (row.draft) return row.draft as unknown as TemplateDraft;
  if (row.status === "DRAFT") return null;
  return componentsToDraft(row.components, row.category);
}

/** The first 90 characters of the message, for the list. */
export function bodySnippet(row: TemplateRow): string {
  let text = "";
  const d = row.status === "DRAFT" ? (row.draft as { body?: { text?: string } } | null) : null;
  if (d?.body?.text) text = d.body.text;
  else for (const c of row.components as { type?: string; text?: string }[]) if (String(c?.type).toUpperCase() === "BODY") text = c.text ?? "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}

/** "25 November 2026" in Lagos time. */
export function lagosDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-NG", { timeZone: "Africa/Lagos", day: "numeric", month: "long", year: "numeric" });
}

/** The small grey notes under a row (7.1), in order. */
export function rowNotes(row: TemplateRow): { text: string; tone: "grey" | "red" | "amber" }[] {
  const notes: { text: string; tone: "grey" | "red" | "amber" }[] = [];
  if (row.status !== "DRAFT" && row.draft) notes.push({ text: "Changes not sent yet", tone: "amber" });
  if (row.system_use === "missed_call") notes.push({ text: "Used for missed-call messages", tone: "grey" });
  if (row.correct_category) {
    const when = row.category_change_at ? ` on ${lagosDate(row.category_change_at)}` : "";
    notes.push({ text: `WhatsApp will re-file this as ${templateCategoryLabel(row.correct_category)}${when}`, tone: "amber" });
  }
  if (row.last_error) notes.push({ text: row.last_error, tone: "red" });
  return notes;
}

/** The whole message and small print a row holds (a draft's own text for a draft row), for the duplicate check. */
export function textOfRow(row: TemplateRow): { body: string; footer: string } {
  if (row.status === "DRAFT") {
    const d = row.draft as { body?: { text?: string }; footer?: string } | null;
    return { body: d?.body?.text ?? "", footer: d?.footer ?? "" };
  }
  let body = "";
  let footer = "";
  for (const c of row.components as { type?: string; text?: string }[]) {
    if (String(c?.type).toUpperCase() === "BODY") body = c.text ?? "";
    if (String(c?.type).toUpperCase() === "FOOTER") footer = c.text ?? "";
  }
  return { body, footer };
}

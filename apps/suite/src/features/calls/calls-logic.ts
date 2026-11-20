/**
 * Plain helpers for the Calls pages: the list's address, filter checks and
 * wording. No React here, so it is all unit-tested (calls-logic.test.ts).
 */
import { prettyPhone, staffLabel } from "@admin/lib/inbox-logic.js";
import type { CallFilters, CallOutcome, CallRow } from "./calls-api.js";

/** How many calls one page loads. */
export const CALLS_PAGE_SIZE = 50;

/** The outcome filter, in the order shown. */
export const OUTCOME_OPTIONS: { value: CallOutcome; label: string }[] = [
  { value: "answered", label: "Answered" },
  { value: "missed", label: "Missed" },
  { value: "voicemail", label: "Voicemail" },
  { value: "after_hours", label: "After hours" },
  { value: "information", label: "Heard a message" },
  { value: "failed", label: "Failed" },
  { value: "in_progress", label: "In progress" },
];

/** The query string for GET /v1/inbox/calls. Empty filters are left out. */
export function callsQuery(f: CallFilters, before?: string, limit = CALLS_PAGE_SIZE): string {
  const p = new URLSearchParams();
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.number) p.set("number", f.number);
  if (f.staff) p.set("staff", f.staff);
  if (f.outcome) p.set("outcome", f.outcome);
  if (f.direction) p.set("direction", f.direction);
  p.set("limit", String(limit));
  if (before) p.set("before", before);
  return p.toString();
}

/** What is wrong with the filters, in plain words, or null when they are fine. */
export function filtersProblem(f: CallFilters): string | null {
  if (f.from && f.to && f.from > f.to) return "The start date is after the end date.";
  return null;
}

export function isFiltered(f: CallFilters): boolean {
  return !!(f.from || f.to || f.number || f.staff || f.outcome || f.direction);
}

/** The outcome, in words that fit the call's direction. */
export function outcomeLabel(outcome: CallOutcome, direction: "in" | "out"): string {
  switch (outcome) {
    case "in_progress":
      return "In progress";
    case "answered":
      return direction === "in" ? "Answered" : "Connected";
    case "missed":
      return direction === "in" ? "Missed" : "No answer";
    case "voicemail":
      return "Voicemail";
    case "after_hours":
      return "After hours";
    case "information":
      return "Heard a message";
    case "failed":
      return "Failed";
  }
}

/** The pill colour: red when nobody spoke to the customer, green when someone did. */
export function outcomeTone(outcome: CallOutcome): "danger" | "success" | "warning" | "ink" {
  if (outcome === "missed" || outcome === "after_hours" || outcome === "failed") return "danger";
  if (outcome === "answered") return "success";
  if (outcome === "information") return "ink";
  return "warning";
}

/** The customer's own number on this call. */
export function customerNumber(c: Pick<CallRow, "direction" | "from_e164" | "to_e164">): string {
  return prettyPhone(c.direction === "in" ? c.from_e164 : c.to_e164);
}

/** Who the call was with: the contact's name, else their number. */
export function callerName(c: Pick<CallRow, "customer_name" | "direction" | "from_e164" | "to_e164">): string {
  return c.customer_name?.trim() || customerNumber(c) || "Unknown caller";
}

/** Which staff member took or made the call, or null when nobody did. */
export function staffLine(c: Pick<CallRow, "direction" | "answered_by" | "started_by">): string | null {
  if (c.direction === "out") {
    const who = c.started_by ?? c.answered_by;
    return who ? `Made by ${staffLabel(who)}` : null;
  }
  return c.answered_by ? `Answered by ${staffLabel(c.answered_by)}` : null;
}

/** "20 Nov 2026, 14:05", in Lagos time. */
export function lagosWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}

/**
 * What the empty list says. `configured` is the voice status: false when the
 * server has no phone provider keys, null while it is still being checked.
 */
export function emptyText(opts: { configured: boolean | null; filtered: boolean }): string {
  if (opts.filtered) return "No calls match these filters.";
  if (opts.configured === false) return "No calls yet. Calling is not set up.";
  return "No calls yet.";
}

/** "1 call" / "12 calls", with "+" while more pages are still to load. */
export function countLine(shown: number, more: boolean): string {
  return `${shown}${more ? "+" : ""} ${shown === 1 && !more ? "call" : "calls"}`;
}

import { describe, expect, it } from "vitest";
import type { TemplateRow } from "./templates-api.js";
import {
  CHIPS,
  bodySnippet,
  matchesChip,
  needsAttention,
  refusalReasonText,
  rowNotes,
  statusOf,
  templateCategoryLabel,
  templateQualityWording,
  templateStatusWording,
} from "./template-labels.js";

const row = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  id: "1",
  waba_id: "W",
  name: "order_ready",
  language: "en",
  category: "UTILITY",
  status: "APPROVED",
  components: [{ type: "BODY", text: "Hello {{1}}" }],
  meta_template_id: "9",
  quality_score: null,
  rejected_reason: null,
  review_info: null,
  correct_category: null,
  previous_category: null,
  category_change_at: null,
  status_changed_at: null,
  draft: null,
  draft_updated_at: null,
  draft_updated_by_name: null,
  submitted_at: null,
  last_error: null,
  edits_left: null,
  editable: true,
  not_editable_reason: null,
  system_use: null,
  starter_key: null,
  synced_at: "2026-11-20T09:00:00.000Z",
  ...over,
});

describe("wording", () => {
  it("every status, refusal reason and quality value has wording; unknown values fall back", () => {
    const expected: Record<string, [string, string]> = {
      DRAFT: ["Draft", "grey"],
      PENDING: ["Waiting for WhatsApp", "amber"],
      APPROVED: ["Approved", "green"],
      REJECTED: ["Refused", "red"],
      PAUSED: ["Paused", "amber"],
      DISABLED: ["Switched off", "red"],
      IN_APPEAL: ["Under appeal", "amber"],
      LIMIT_EXCEEDED: ["Over the limit", "red"],
      ARCHIVED: ["Archived", "grey"],
      PENDING_DELETION: ["Being deleted", "grey"],
    };
    for (const [status, [label, tone]] of Object.entries(expected)) {
      expect(templateStatusWording(status), status).toMatchObject({ label, tone });
    }
    expect(templateStatusWording("SOMETHING_NEW")).toEqual({ label: "SOMETHING_NEW", tone: "grey", line: "" });

    for (const reason of ["INVALID_FORMAT", "ABUSIVE_CONTENT", "PROMOTIONAL", "SCAM", "INCORRECT_CATEGORY", "TAG_CONTENT_MISMATCH"]) {
      expect(refusalReasonText(reason), reason).not.toBe("WhatsApp did not give a reason.");
    }
    for (const reason of ["NONE", null, undefined, "SOMETHING_NEW"]) {
      expect(refusalReasonText(reason as string | null)).toBe("WhatsApp did not give a reason.");
    }
    expect(refusalReasonText("SCAM", "Remove the link.")).toMatch(/WhatsApp's advice: Remove the link\.$/);

    expect(templateQualityWording("GREEN")).toEqual({ label: "Customers like it", tone: "green" });
    expect(templateQualityWording("YELLOW").tone).toBe("amber");
    expect(templateQualityWording("RED").tone).toBe("red");
    expect(templateQualityWording("UNKNOWN")).toEqual({ label: "Not rated yet", tone: "grey" });
    expect(templateQualityWording(null)).toEqual({ label: "Not rated yet", tone: "grey" });
    expect(templateQualityWording("SOMETHING_NEW").label).toBe("Not rated yet");

    expect(templateCategoryLabel("UTILITY")).toBe("Order and account updates");
    expect(templateCategoryLabel("MARKETING")).toBe("Marketing");
    expect(templateCategoryLabel("AUTHENTICATION")).toBe("Login codes");
  });

  it("a refused row's line carries the reason and the advice from WhatsApp", () => {
    const r = row({ status: "REJECTED", rejected_reason: "INVALID_FORMAT", review_info: { rejection: { recommendation: "Add words." } } });
    expect(statusOf(r).line).toBe(
      "The layout breaks one of WhatsApp's rules, for example a blank at the start or end, two blanks side by side, or a missing example. WhatsApp's advice: Add words. Change it and send it again.",
    );
  });
});

describe("the list", () => {
  it("filters by chip and finds what needs attention", () => {
    expect(CHIPS.map((c) => c.label)).toEqual(["All", "Drafts", "Waiting", "Approved", "Needs attention"]);
    const rows = {
      draft: row({ status: "DRAFT" }),
      waiting: row({ status: "PENDING" }),
      appeal: row({ status: "IN_APPEAL" }),
      ok: row(),
      refused: row({ status: "REJECTED" }),
      paused: row({ status: "PAUSED" }),
      red: row({ quality_score: "RED" }),
      flagged: row({ review_info: { flagged: true } }),
      moving: row({ correct_category: "MARKETING" }),
      failed: row({ last_error: "WhatsApp did not answer." }),
    };
    expect(Object.entries(rows).filter(([, r]) => matchesChip(r, "drafts")).map(([k]) => k)).toEqual(["draft"]);
    expect(Object.entries(rows).filter(([, r]) => matchesChip(r, "waiting")).map(([k]) => k)).toEqual(["waiting", "appeal"]);
    expect(Object.entries(rows).filter(([, r]) => matchesChip(r, "approved")).map(([k]) => k)).toEqual(["ok", "red", "flagged", "moving", "failed"]);
    expect(Object.entries(rows).filter(([, r]) => needsAttention(r)).map(([k]) => k)).toEqual(["refused", "paused", "red", "flagged", "moving", "failed"]);
    expect(Object.values(rows).every((r) => matchesChip(r, "all"))).toBe(true);
  });

  it("shows the first 90 characters of the message, from the draft for a draft row", () => {
    expect(bodySnippet(row())).toBe("Hello {{1}}");
    expect(bodySnippet(row({ status: "DRAFT", components: [], draft: { body: { text: "x".repeat(120) } } }))).toBe(`${"x".repeat(89)}…`);
  });

  it("lists the small notes in order", () => {
    const notes = rowNotes(
      row({ draft: { category: "UTILITY" }, system_use: "missed_call", correct_category: "MARKETING", category_change_at: "2026-11-25T10:00:00.000Z", last_error: "Refused." }),
    );
    expect(notes.map((n) => n.text)).toEqual([
      "Changes not sent yet",
      "Used for missed-call messages",
      "WhatsApp will re-file this as Marketing on 25 November 2026",
      "Refused.",
    ]);
    expect(notes[3]!.tone).toBe("red");
    expect(rowNotes(row({ status: "DRAFT", draft: { category: "UTILITY" } }))).toEqual([]);
  });
});

describe("textOfRow", () => {
  it("reads the draft's text for a draft row and the components' text for the rest", async () => {
    const { textOfRow } = await import("./template-labels.js");
    expect(textOfRow(row({ status: "DRAFT", components: [], draft: { body: { text: "Hi there" }, footer: "Shop" } }))).toEqual({ body: "Hi there", footer: "Shop" });
    expect(textOfRow(row({ components: [{ type: "BODY", text: "Hello" }, { type: "FOOTER", text: "Foot" }] }))).toEqual({ body: "Hello", footer: "Foot" });
    expect(textOfRow(row({ status: "DRAFT", components: [], draft: null }))).toEqual({ body: "", footer: "" });
  });
});

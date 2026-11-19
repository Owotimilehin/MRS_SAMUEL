import { describe, it, expect } from "vitest";
import { templateAlertWording, templateCategoryLabel, templateEditability, templateQualityWording, templateStatusWording } from "./template-wording.js";

describe("template wording", () => {
  it("every status has wording and an unknown one falls back to the raw value", () => {
    for (const s of ["DRAFT", "PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED", "IN_APPEAL", "LIMIT_EXCEEDED", "ARCHIVED", "PENDING_DELETION"]) {
      expect(templateStatusWording(s).label.length, s).toBeGreaterThan(0);
    }
    expect(templateStatusWording("WEIRD")).toEqual({ label: "WEIRD", tone: "grey", line: "" });
  });
  it("a refusal line carries the reason, the advice and the next step", () => {
    const w = templateStatusWording("REJECTED", { reason: "SCAM", recommendation: "Remove the link." });
    expect(w.line).toBe("WhatsApp thinks customers could mistake this for a scam. WhatsApp's advice: Remove the link. Change it and send it again.");
    expect(templateStatusWording("REJECTED", { reason: "NONE" }).line).toContain("WhatsApp did not give a reason.");
  });
  it("quality and category labels", () => {
    expect(templateQualityWording("GREEN").tone).toBe("green");
    expect(templateQualityWording(null).label).toBe("Not rated yet");
    expect(templateCategoryLabel("UTILITY")).toBe("Order and account updates");
    expect(templateCategoryLabel("AUTHENTICATION")).toBe("Login codes");
  });
  it("editability follows the status, the lock and what the editor can open", () => {
    const body = [{ type: "BODY", text: "Hello there" }];
    expect(templateEditability({ status: "DRAFT", category: "UTILITY", components: [] })).toEqual({ editable: true, reason: null });
    expect(templateEditability({ status: "APPROVED", category: "UTILITY", components: body }).editable).toBe(true);
    expect(templateEditability({ status: "PENDING", category: "UTILITY", components: body }).reason).toMatch(/^WhatsApp is checking/);
    expect(templateEditability({ status: "DISABLED", category: "UTILITY", components: body }).reason).toMatch(/switched off for good/);
    expect(templateEditability({ status: "ARCHIVED", category: "UTILITY", components: body }).editable).toBe(false);
    expect(templateEditability({ status: "APPROVED", category: "UTILITY", components: body, reviewInfo: { locked: true } }).reason).toBe("WhatsApp has locked this template.");
    const carousel = templateEditability({ status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "x" }, { type: "CAROUSEL" }] });
    expect(carousel.editable).toBe(false);
    expect(carousel.reason).toContain("Change it in WhatsApp Manager.");
    expect(templateEditability({ status: "APPROVED", category: "AUTHENTICATION", components: body }).editable).toBe(false);
  });
  it("alert wording has a sentence for every kind", () => {
    for (const k of ["rejected", "paused", "disabled", "flagged", "quality_red", "category_notice", "category_changed", "approved_as_marketing", "archived"]) {
      expect(templateAlertWording(k, {}).sentence.length, k).toBeGreaterThan(0);
    }
  });
});

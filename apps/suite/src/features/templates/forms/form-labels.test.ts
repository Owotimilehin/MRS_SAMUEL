import { describe, expect, it } from "vitest";
import { WA_FLOWS, type FlowState } from "@ms/shared";
import {
  FORM_ACTION_LABEL,
  FORM_STATES,
  asksFor,
  cardId,
  formActions,
  formButtonChoices,
  formStateWording,
  keyStatusWording,
  safePreviewUrl,
  showAccountLabels,
  showSecureCard,
  validationMessages,
  versionLabel,
} from "./form-labels.js";

const labels = (state: FlowState, codeIsNewer = false) => formActions({ state, code_is_newer: codeIsNewer }).map((a) => FORM_ACTION_LABEL[a]);

describe("form states", () => {
  it("every state has a pill and a line", () => {
    expect(FORM_STATES).toHaveLength(8);
    for (const state of FORM_STATES) {
      const w = formStateWording(state, 2);
      expect(w.label, state).not.toBe("");
      expect(w.label, state).not.toBe("Unknown");
      expect(w.line, state).not.toBe("");
      expect(["grey", "amber", "green", "red"]).toContain(w.tone);
    }
  });
  it("uses the exact words of the spec", () => {
    expect(formStateWording("not_created")).toEqual({ label: "Not at WhatsApp yet", tone: "grey", line: "Create it to preview and test." });
    expect(formStateWording("draft_ready")).toEqual({ label: "Draft", tone: "amber", line: "Ready to test. Publish it to use it with customers." });
    expect(formStateWording("live")).toEqual({ label: "Live", tone: "green", line: "Staff can send this form in chats." });
    expect(formStateWording("live_update_waiting")).toEqual({ label: "Live, update waiting", tone: "amber", line: "A newer version of this form is ready." });
    expect(formStateWording("blocked")).toEqual({
      label: "Blocked by WhatsApp",
      tone: "red",
      line: "WhatsApp has stopped this form because our server was failing. It cannot be sent.",
    });
    expect(formStateWording("throttled")).toEqual({ label: "Limited by WhatsApp", tone: "amber", line: "Only 10 can be sent an hour until our server is healthy again." });
    expect(formStateWording("retired")).toEqual({ label: "Retired", tone: "grey", line: "No longer sent. Forms already sent can no longer be opened." });
  });
  it("counts the problems of a draft with errors", () => {
    expect(formStateWording("draft_invalid", 1)).toEqual({
      label: "Draft with errors",
      tone: "red",
      line: "WhatsApp found 1 problem in this form. The technical lead needs to fix them.",
    });
    expect(formStateWording("draft_invalid", 3).line).toBe("WhatsApp found 3 problems in this form. The technical lead needs to fix them.");
  });
  it("a state it does not know gets a grey pill and no buttons", () => {
    const odd = "something_new" as FlowState;
    expect(formStateWording(odd)).toEqual({ label: "Unknown", tone: "grey", line: "" });
    expect(formActions({ state: odd, code_is_newer: true })).toEqual([]);
  });
});

describe("form buttons", () => {
  it("shows the buttons of each state, in order", () => {
    expect(labels("not_created")).toEqual(["Create at WhatsApp"]);
    expect(labels("draft_invalid")).toEqual(["Upload again", "Delete draft"]);
    expect(labels("draft_ready")).toEqual(["Preview", "Publish", "Delete draft"]);
    expect(labels("live")).toEqual(["Preview", "Retire"]);
    expect(labels("live_update_waiting")).toEqual(["Preview", "Upload new version", "Retire"]);
    expect(labels("blocked")).toEqual(["Preview"]);
    expect(labels("throttled")).toEqual(["Preview"]);
    expect(labels("retired")).toEqual(["Create a new copy"]);
  });
  it("offers Upload again on a ready draft only when the code is newer", () => {
    expect(labels("draft_ready", true)).toEqual(["Preview", "Publish", "Upload again", "Delete draft"]);
    expect(labels("live", true)).toEqual(["Preview", "Retire"]);
  });
  it("only a draft can be deleted and only a live form retired", () => {
    for (const state of FORM_STATES) {
      const a = formActions({ state, code_is_newer: true });
      expect(a.includes("delete_draft"), state).toBe(state === "draft_invalid" || state === "draft_ready");
      expect(a.includes("retire"), state).toBe(state === "live" || state === "live_update_waiting");
      expect(a.includes("publish"), state).toBe(state === "draft_ready");
    }
  });
});

describe("what a card says", () => {
  it("lists what the form asks for from the registry", () => {
    expect(asksFor("delivery_address")).toBe("Asks for: Receiver, Phone, House and street, Area, Landmark, Note for the rider");
    for (const f of WA_FLOWS) expect(asksFor(f.key)).toMatch(/^Asks for: \S/);
    expect(asksFor("not_a_form")).toBeNull();
  });
  it("turns each problem into a sentence", () => {
    expect(validationMessages([{ message: "Missing Footer" }, { error: "INVALID_PROPERTY" }, {}])).toEqual([
      "Missing Footer",
      "INVALID_PROPERTY",
      "A problem WhatsApp did not describe.",
    ]);
  });
  it("names the account only when there is more than one", () => {
    const a = { account: { waba_id: "A", label: "Shop" } };
    const b = { account: { waba_id: "B", label: "Factory" } };
    expect(showAccountLabels([a, a])).toBe(false);
    expect(showAccountLabels([a, b])).toBe(true);
    expect(showAccountLabels([])).toBe(false);
  });
  it("shows the version above 1, or when two cards are the same form", () => {
    const acc = { waba_id: "A", label: "Shop" };
    const v1 = { id: "1", key: "complaint", version: 1, account: acc };
    const v2 = { id: "2", key: "complaint", version: 2, account: acc };
    const other = { id: "3", key: "bulk_order", version: 1, account: acc };
    const elsewhere = { id: "4", key: "complaint", version: 1, account: { waba_id: "B", label: "Factory" } };
    expect(versionLabel(v1, [v1, other])).toBeNull();
    expect(versionLabel(v1, [v1, v2])).toBe("Version 1");
    expect(versionLabel(v2, [v2])).toBe("Version 2");
    expect(versionLabel(v1, [v1, elsewhere])).toBeNull();
    expect(versionLabel({ ...v1, version: null }, [v1, v2])).toBeNull();
    expect(cardId(v1)).toBe("1");
    expect(cardId({ ...v1, id: null })).toBe("new:A:complaint");
  });
});

describe("secure connection", () => {
  it("words the state of the key for a number", () => {
    expect(keyStatusWording("VALID")).toEqual({ label: "In place", tone: "green" });
    expect(keyStatusWording("MISMATCH")).toEqual({ label: "Needs sending again", tone: "red" });
    expect(keyStatusWording(null)).toEqual({ label: "Not sent yet", tone: "grey" });
  });
  it("shows the card when the key is set up or a Phase B form is listed", () => {
    expect(showSecureCard(false, [{ phase: "A" }])).toBe(false);
    expect(showSecureCard(true, [{ phase: "A" }])).toBe(true);
    expect(showSecureCard(false, [{ phase: "A" }, { phase: "B" }])).toBe(true);
  });
});

describe("preview link and the editor's form choices", () => {
  it("opens only an https address", () => {
    expect(safePreviewUrl("https://business.facebook.com/wa/manage/flows/1/preview/?token=t")).toMatch(/^https:/);
    expect(safePreviewUrl("javascript:alert(1)")).toBeNull();
    expect(safePreviewUrl("http://example.com")).toBeNull();
    expect(safePreviewUrl("")).toBeNull();
    expect(safePreviewUrl(undefined)).toBeNull();
  });
  it("lists live forms, and keeps the chosen one when it is no longer live", () => {
    const forms = [
      { key: "complaint", title: "Report a problem", live: true },
      { key: "bulk_order", title: "Bulk-order enquiry", live: false },
    ];
    expect(formButtonChoices(forms, "")).toEqual([{ key: "complaint", label: "Report a problem" }]);
    expect(formButtonChoices(forms, "complaint")).toEqual([{ key: "complaint", label: "Report a problem" }]);
    expect(formButtonChoices(forms, "bulk_order")).toEqual([
      { key: "complaint", label: "Report a problem" },
      { key: "bulk_order", label: "Bulk-order enquiry (not live)" },
    ]);
    expect(formButtonChoices([], "pickup_request")).toEqual([{ key: "pickup_request", label: "Pickup request (not live)" }]);
    expect(formButtonChoices([], "gone")).toEqual([{ key: "gone", label: "gone (not live)" }]);
  });
});

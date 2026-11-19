import { describe, it, expect } from "vitest";
import { WA_FLOWS, flowAddressLine, flowCardRows, flowDef, flowMetaName, flowState, formatFlowDate, formatFlowValue } from "./wa-flows.js";

describe("WhatsApp forms registry (suite spec 07)", () => {
  it("registry: keys are unique, cta is 30 characters or fewer, default message is 1024 or fewer", () => {
    const keys = WA_FLOWS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(WA_FLOWS.map((f) => f.metaName)).size).toBe(keys.length);
    for (const f of WA_FLOWS) {
      expect(f.cta.length).toBeGreaterThan(0);
      expect(f.cta.length).toBeLessThanOrEqual(30);
      expect(f.defaultMessage.length).toBeLessThanOrEqual(1024);
      expect(f.entryScreen).toMatch(/^[A-Z_]+$/);
      expect(f.categories.length).toBeGreaterThan(0);
      expect(f.label).toBe(f.label.toLowerCase());
      expect(new Set(f.fields.map((x) => x.name)).size).toBe(f.fields.length);
    }
    expect(WA_FLOWS.filter((f) => f.phase === "A").map((f) => f.key)).toEqual(["delivery_address", "bulk_order", "complaint", "pickup_request"]);
    expect(WA_FLOWS.filter((f) => f.usesEndpoint).map((f) => f.key)).toEqual(["delivery_slot"]);
  });

  it("flowDef finds a form and returns null for anything else", () => {
    expect(flowDef("complaint")?.title).toBe("Report a problem");
    expect(flowDef("unknown")).toBeNull();
    expect(flowDef("")).toBeNull();
  });

  it("a second version gets _v2 on its Meta name", () => {
    const def = flowDef("delivery_address")!;
    expect(flowMetaName(def, 1)).toBe("ms_delivery_address");
    expect(flowMetaName(def, 2)).toBe("ms_delivery_address_v2");
  });

  it("formatFlowValue: choices become titles, dates are written out, lists are joined", () => {
    expect(formatFlowValue("choice", "lekki", { lekki: "Lekki" })).toBe("Lekki");
    expect(formatFlowValue("choice", "mars", { lekki: "Lekki" })).toBe("mars");
    expect(formatFlowValue("multi", ["a", "b"], { a: "Apple", b: "Banana" })).toBe("Apple, Banana");
    expect(formatFlowValue("date", "2026-11-20")).toBe("Fri 20 Nov 2026");
    expect(formatFlowDate("not a date")).toBe("not a date");
    expect(formatFlowDate("2026-02-31")).toBe("2026-02-31");
    expect(formatFlowValue("longtext", "line one\nline two")).toBe("line one\nline two");
    expect(formatFlowValue("text", 12)).toBe("12");
    expect(formatFlowValue("text", null)).toBe("");
  });

  it("flowCardRows orders rows by the registry, hides flow_token and flow_key, and lists unknown keys last", () => {
    const card = flowCardRows("delivery_address", {
      extra: "x",
      area: "ikeja",
      flow_token: "t",
      flow_key: "delivery_address",
      street: "12 Test Road",
      receiver_name: "Test Person",
      landmark: "",
    });
    expect(card.title).toBe("Delivery address");
    expect(card.rows.map((r) => r.label)).toEqual(["Receiver", "House and street", "Area", "Other: extra"]);
    expect(card.rows[2]!.value).toBe("Ikeja");
  });

  it("an unknown form lists every key; an unreadable answer shows one row", () => {
    expect(flowCardRows("unknown", { a: "1", flow_token: "t" })).toEqual({ title: "Form", rows: [{ label: "a", value: "1", kind: "other" }] });
    expect(flowCardRows("unknown", { _raw: "{broken" }).rows).toEqual([{ label: "Answer", value: "{broken", kind: "longtext" }]);
  });

  it("the delivery-slot card shows the label and not the day and slot keys", () => {
    const card = flowCardRows("delivery_slot", { day: "2026-11-20", slot: "11:00-13:00", slot_label: "Fri 20 Nov, 11am to 1pm" });
    expect(card.rows).toEqual([{ label: "Delivery time", value: "Fri 20 Nov, 11am to 1pm", kind: "text" }]);
  });

  it("flowAddressLine joins street and area and adds the landmark only when given", () => {
    expect(flowAddressLine({ street: "12 Test Road", area: "lekki", landmark: "Blue gate" })).toBe("12 Test Road, Lekki. Landmark: Blue gate");
    expect(flowAddressLine({ street: "12 Test Road", area: "lekki", landmark: "" })).toBe("12 Test Road, Lekki.");
    expect(flowAddressLine({ street: "x".repeat(600), area: "lekki" }).length).toBe(500);
  });

  it("flowState covers every state", () => {
    expect(flowState(null)).toBe("not_created");
    expect(flowState({ status: "DRAFT", validationErrors: [{}], codeIsNewer: false })).toBe("draft_invalid");
    expect(flowState({ status: "DRAFT", validationErrors: [], codeIsNewer: true })).toBe("draft_ready");
    expect(flowState({ status: "PUBLISHED", validationErrors: [], codeIsNewer: false })).toBe("live");
    expect(flowState({ status: "PUBLISHED", validationErrors: [], codeIsNewer: true })).toBe("live_update_waiting");
    expect(flowState({ status: "DEPRECATED", validationErrors: [], codeIsNewer: false })).toBe("retired");
    expect(flowState({ status: "BLOCKED", validationErrors: [], codeIsNewer: false })).toBe("blocked");
    expect(flowState({ status: "THROTTLED", validationErrors: [], codeIsNewer: false })).toBe("throttled");
  });
});

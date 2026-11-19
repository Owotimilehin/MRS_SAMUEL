import { describe, it, expect } from "vitest";
import { format } from "./outbox.js";

// Ruling 9.2.10: every new owner-alert event type has a case in outbox.ts (suite spec 06).
describe("owner alert for WhatsApp templates (suite spec 06)", () => {
  const base = { account: "t1:rejected", template_id: "t1", name: "order_confirmed", language: "en" };

  it("a refusal says why, in plain words, with WhatsApp's advice", () => {
    const m = format({
      eventType: "inbox.template_alert",
      payload: { ...base, kind: "rejected", reason: "INVALID_FORMAT", recommendation: "Add words between the blanks." },
    });
    expect(m.chatIds).toHaveLength(1);
    expect(m.text).toContain("*WhatsApp template: refused*");
    expect(m.text).toContain("“order_confirmed” (en).");
    expect(m.text).toContain("WhatsApp refused it: The layout breaks one of WhatsApp's rules");
    expect(m.text).toContain("WhatsApp's advice: Add words between the blanks.");
    expect(m.text).toContain("/templates");
  });

  it("a coming category change names both types and the Lagos date", () => {
    const m = format({
      eventType: "inbox.template_alert",
      payload: { ...base, kind: "category_notice", category: "UTILITY", correct_category: "MARKETING", at: "2026-11-25T10:00:00.000Z" },
    });
    expect(m.text).toContain("*WhatsApp template: will be re-filed*");
    expect(m.text).toContain("from Order and account updates to Marketing on 25 November 2026");
  });

  it("covers paused, disabled, flagged, low quality, re-filed and archived", () => {
    const title = (kind: string): string => format({ eventType: "inbox.template_alert", payload: { ...base, kind } }).text;
    expect(title("paused")).toContain("paused it for a few hours");
    expect(title("disabled")).toContain("switched it off for good");
    expect(title("flagged")).toContain("may be paused soon");
    expect(title("quality_red")).toContain("Its quality is now low.");
    expect(title("archived")).toContain("delete it in 28 days");
    expect(
      format({ eventType: "inbox.template_alert", payload: { ...base, kind: "category_changed", category: "MARKETING" } }).text,
    ).toContain("now files it under Marketing");
  });

  it("a configuration refusal from the template screens says WhatsApp and links to Templates", () => {
    const m = format({ eventType: "inbox.meta_config", payload: { account: "whatsapp_templates", area: "whatsapp_templates", code: "190" } });
    expect(m.text).toContain("WhatsApp connection problem");
    expect(m.text).toContain("(code 190, whatsapp_templates)");
    expect(m.text).toContain("/templates");
    expect(m.text).not.toContain("Facebook or Instagram");
  });
});

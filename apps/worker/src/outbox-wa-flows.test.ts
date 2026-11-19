import { describe, it, expect } from "vitest";
import { format } from "./outbox.js";

// Ruling 9.2.10: every new owner-alert event type has a case in outbox.ts (suite spec 07).
describe("owner alerts for WhatsApp forms (suite spec 07)", () => {
  it("a complaint form tells the owner where to look and carries no customer details", () => {
    const m = format({
      eventType: "inbox.flow_complaint",
      payload: { account: "flow_complaint:r1", conversation_id: "11111111-2222-4333-8444-555555555555", response_id: "r1" },
    });
    expect(m.chatIds).toHaveLength(1);
    expect(m.text).toContain("*A customer reported a problem*");
    expect(m.text).toContain("A complaint form has just been filled in on WhatsApp.");
    expect(m.text).toContain("/inbox/11111111-2222-4333-8444-555555555555");
    // Nothing but the fixed wording and the link.
    expect(m.text.split("\n")).toHaveLength(3);
  });

  it("a configuration refusal from the forms screens links to Forms", () => {
    const m = format({ eventType: "inbox.meta_config", payload: { account: "whatsapp_flows", area: "whatsapp_flows", code: "190" } });
    expect(m.text).toContain("WhatsApp connection problem");
    expect(m.text).toContain("(code 190, whatsapp_flows)");
    expect(m.text).toContain("/templates/forms");
    expect(m.text).not.toContain("Facebook or Instagram");
  });
});

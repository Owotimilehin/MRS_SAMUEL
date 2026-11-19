import { describe, it, expect } from "vitest";
import { format } from "./outbox.js";

// Ruling 9.2.10: every owner alert raised through outbox_event has its own case.
describe("owner alert when leads cannot be read (suite spec 13)", () => {
  it("says what happened, gives Meta's code and message, and links to Leads in the suite", () => {
    const m = format({
      eventType: "lead.fetch_blocked",
      payload: { account: "100200300400", code: "200", message: "(#200) Requires leads_retrieval permission" },
    });
    expect(m.text).toContain("Leads cannot be read");
    expect(m.text).toContain("Meta refused (200): (#200) Requires leads_retrieval permission");
    expect(m.text).toContain("Check Leads Access in Business Settings.");
    expect(m.text).toMatch(/\/leads$/);
    expect(m.chatIds.length).toBe(1);
  });
});

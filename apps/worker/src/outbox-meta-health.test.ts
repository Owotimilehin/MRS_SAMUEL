import { describe, expect, it } from "vitest";
import { format } from "./outbox.js";

// Ruling 9.2.10: every owner alert type has its own wording, never raw text.
describe("owner alert for the Meta watchdog (blueprint stage 1)", () => {
  it("says what it means for customers, lists what broke, and links to Channels", () => {
    const m = format({
      eventType: "meta.connection_broken",
      payload: {
        items: [
          {
            key: "token",
            kind: "token",
            label: "Meta access key",
            reason: "Meta no longer accepts the suite's access key. The technical lead needs to make a new one.",
            impact: "Customers on WhatsApp, Facebook and Instagram are not getting replies",
          },
          { key: "line:a", kind: "whatsapp_number", label: "WhatsApp Main line", reason: "Meta has banned this number from WhatsApp.", impact: "x" },
        ],
      },
    });
    expect(m.text).toContain("Meta connection broken");
    expect(m.text).toContain("Customers on WhatsApp, Facebook and Instagram are not getting replies.");
    expect(m.text).toContain("• Meta access key: Meta no longer accepts");
    expect(m.text).toContain("• WhatsApp Main line: Meta has banned");
    expect(m.text).toContain("/channels");
    expect(m.text).not.toContain("{");
  });
  it("still reads well with an empty payload", () => {
    const m = format({ eventType: "meta.connection_broken", payload: {} });
    expect(m.text).toContain("Customers may not be getting replies.");
  });
});

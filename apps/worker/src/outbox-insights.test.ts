import { describe, it, expect } from "vitest";
import { format } from "./outbox.js";

// Ruling 9.2.10: the statistics collector's owner alert has its own case (suite spec 11).
describe("owner alert from the statistics collector", () => {
  it("says what happened in plain words, names the code and links to Insights", () => {
    const m = format({
      eventType: "insights.config_error",
      payload: { account: "token", source: "facebook_page", label: "Facebook Page", code: "190", message: "The connection to Meta has expired. Tell the technical team." },
    });
    expect(m.text).toContain("Insights: Meta would not share its figures");
    expect(m.text).toContain("The connection to Meta has expired. Tell the technical team.");
    expect(m.text).toContain("Facebook Page, Meta code 190");
    expect(m.text).toContain("/insights");
    // Not the raw-JSON fallback for unknown event types.
    expect(m.text).not.toContain('"account"');
  });
});

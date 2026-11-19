import { describe, it, expect } from "vitest";
import { format } from "./outbox.js";

// Ruling 9.2.10: every owner alert has a case in outbox.ts (suite spec 03, 5.1).
describe("owner alert for comments (suite spec 03)", () => {
  it("names the account, Meta's message and code, and points to Channels", () => {
    const m = format({
      eventType: "social.comments_config",
      payload: { account: "acc-1", account_id: "acc-1", label: "Mrs Samuel fruit juice", code: "200", message: "(#200) Permissions error" },
    });
    expect(m.text).toContain(
      "Comments: the suite can no longer read or answer comments on Mrs Samuel fruit juice. Meta said: (#200) Permissions error (code 200). Open Channels in the suite to check the connection.",
    );
    expect(m.text).toContain("/channels");
    expect(m.chatIds.length).toBeGreaterThan(0);
  });

  it("still reads sensibly when Meta gave no code", () => {
    const m = format({ eventType: "social.comments_config", payload: { account: "acc-1", label: "Instagram", code: null, message: "No answer" } });
    expect(m.text).toContain("on Instagram. Meta said: No answer (code unknown).");
  });
});

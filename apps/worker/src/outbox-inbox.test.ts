import { describe, it, expect } from "vitest";
import { format } from "./outbox.js";

// Ruling 9.2.10: every owner alert type has its own wording, never raw text.
describe("owner alerts for Messenger and Instagram (suite spec 02)", () => {
  it("names the account that isn't connected and links to Channels", () => {
    const m = format({ eventType: "inbox.unknown_channel_account", payload: { account: "instagram:17841400000000001" } });
    expect(m.text).toContain("isn't connected");
    expect(m.text).toContain("instagram:17841400000000001");
    expect(m.text).toContain("/channels");
  });
  it("shows the plain sentence and Meta's code for a configuration problem", () => {
    const m = format({
      eventType: "inbox.meta_config",
      payload: { account: "17841400000000001", code: "200/2534041", text: "Message access is switched off in the Instagram app. The owner has been told." },
    });
    expect(m.text).toContain("Messages are not going out on Facebook or Instagram");
    expect(m.text).toContain("Message access is switched off");
    expect(m.text).toContain("Meta code 200/2534041");
  });
  it("tells the owner where to read a policy warning", () => {
    expect(format({ eventType: "inbox.meta_policy", payload: { account: "100200300400" } }).text).toContain("Page quality");
  });
});

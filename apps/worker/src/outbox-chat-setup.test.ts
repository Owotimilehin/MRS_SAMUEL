import { describe, it, expect } from "vitest";
import { format } from "./outbox.js";

// Ruling 9.2.10: the chat set-up alert has its own wording, never raw text.
describe("owner alert for chat set-up (suite spec 04)", () => {
  it("names the account, Meta's reason and code, and links to Channels", () => {
    const m = format({
      eventType: "channels.chat_setup_config",
      payload: { account_id: "11111111-1111-4111-8111-111111111111", label: "Facebook Page", code: "200", message: "The suite has lost its permission for this account. Ask the owner to check Channels." },
    });
    expect(m.text).toContain("Chat set-up: Meta refused a change for Facebook Page: The suite has lost its permission");
    expect(m.text).toContain("(code 200). Open Channels in the suite to check the connection.");
    expect(m.text).toContain("/channels");
    expect(m.text).not.toContain("channels.chat_setup_config");
  });
});

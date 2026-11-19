import { describe, it, expect } from "vitest";
import { format } from "./outbox.js";

// Ruling 9.2.10: the publishing alert has its own wording, never raw text.
describe("owner alert for a post that could not go out (suite spec 09)", () => {
  it("names the network, the account, Meta's reason and code, and links to Posts", () => {
    const m = format({
      eventType: "social.publish_config_error",
      payload: {
        network: "instagram",
        account: "22222222-2222-4222-8222-222222222222",
        account_id: "22222222-2222-4222-8222-222222222222",
        label: "Instagram",
        code: "190",
        message: "Error validating access token",
      },
    });
    expect(m.text).toContain("A post could not go out on Instagram");
    expect(m.text).toContain("Meta refused the suite for Instagram: Error validating access token (code 190).");
    expect(m.text).toContain("/posts");
    expect(m.text).not.toContain("social.publish_config_error");
  });

  it("says Facebook for a Page", () => {
    const m = format({ eventType: "social.publish_config_error", payload: { network: "facebook", label: "Facebook Page", code: "200", message: "Permissions error" } });
    expect(m.text).toContain("A post could not go out on Facebook");
    expect(m.text).toContain("(code 200)");
  });
});

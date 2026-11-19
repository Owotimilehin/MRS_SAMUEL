import { describe, it, expect } from "vitest";
import { format } from "./outbox.js";

// Ruling 9.2.10: the WhatsApp profile alert (area "whatsapp_profile") has its own wording.
describe("owner alert for the WhatsApp profile (suite spec 05)", () => {
  it("says WhatsApp, names the code and the area, and links to Channels", () => {
    const m = format({
      eventType: "inbox.meta_config",
      payload: { account: "whatsapp_profile", area: "whatsapp_profile", code: "190" },
    });
    expect(m.text).toContain("WhatsApp connection problem");
    expect(m.text).toContain("(code 190, whatsapp_profile)");
    expect(m.text).toContain("The access token or its permissions need checking.");
    expect(m.text).toContain("/channels");
    expect(m.text).not.toContain("Facebook or Instagram");
  });

  it("keeps the Facebook and Instagram wording for other areas", () => {
    const m = format({ eventType: "inbox.meta_config", payload: { account: "100200300", code: "190", text: "Meta refused a message." } });
    expect(m.text).toContain("Messages are not going out on Facebook or Instagram");
  });
});

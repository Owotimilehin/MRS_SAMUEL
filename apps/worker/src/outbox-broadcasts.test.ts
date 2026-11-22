import { describe, it, expect } from "vitest";
import { format } from "./outbox.js";

// Ruling 9.2.10: each broadcast alert has its own wording, never raw text (suite spec 14, section 6).
describe("owner alerts for broadcasts (suite spec 14, Phase B)", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  it("broadcast stopped", () => {
    const m = format({
      eventType: "broadcast.stopped",
      payload: {
        account: `${id}:quality`,
        broadcast_id: id,
        name: "November promo",
        reason: "quality",
        reason_text: "WhatsApp lowered the quality rating of our number. Too many people blocked or reported us. Do not resume until it recovers.",
        sent: 40,
        waiting: 160,
      },
    });
    expect(m.text).toContain("⛔ *Broadcast stopped*");
    expect(m.text).toContain("“November promo”: WhatsApp lowered the quality rating of our number.");
    expect(m.text).toContain("Sent so far: 40. Still waiting: 160. Nothing more goes out until someone presses Resume.");
    expect(m.text).toContain(`/broadcasts/${id}`);
    expect(m.text).not.toContain("broadcast.stopped");
  });
  it("broadcast finished", () => {
    const m = format({ eventType: "broadcast.finished", payload: { account: `${id}:finished`, broadcast_id: id, name: "November promo", sent: 180, failed: 12, skipped: 8 } });
    expect(m.text).toContain("📣 *Broadcast finished*");
    expect(m.text).toContain("“November promo”: sent 180, failed 12, left out 8.");
    expect(m.text).toContain(`/broadcasts/${id}`);
  });
  it("a configuration stop links to Broadcasts", () => {
    const m = format({ eventType: "inbox.meta_config", payload: { account: "broadcasts:line", area: "whatsapp_broadcasts", code: "190", message: "Invalid OAuth access token" } });
    expect(m.text).toContain("Meta refused a broadcast message (code 190). The broadcast stopped itself.");
    expect(m.text).toContain("/broadcasts");
    expect(m.text).not.toContain("Invalid OAuth access token");
  });
});

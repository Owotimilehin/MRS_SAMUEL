import { describe, it, expect } from "vitest";
import { deadTokens, latestPushable, pushBody, pushTitle, wantsPush, type PushMessage } from "./inbox-push.js";
import type { InboxViewer } from "@ms/domain";

const viewer: InboxViewer = { userId: "U1", capabilities: ["inbox.view"], teamIds: ["T1"], numberIds: ["N1"] };
const conv = { phoneNumberId: "N1", teamId: "T1", assigneeId: null as string | null };

describe("wantsPush", () => {
  it("respects the notification level", () => {
    expect(wantsPush(viewer, "none", conv)).toBe(false);
    expect(wantsPush(viewer, "assigned", conv)).toBe(true); // unassigned in my team
    expect(wantsPush(viewer, "assigned", { ...conv, assigneeId: "U1" })).toBe(true);
  });
  it("never pushes what the person can't see", () => {
    expect(wantsPush(viewer, "all", { ...conv, phoneNumberId: "N2" })).toBe(false);
    expect(wantsPush(viewer, "all", { ...conv, assigneeId: "U2" })).toBe(false);
  });
  it("'all' includes others' threads only when scope allows", () => {
    const team: InboxViewer = { ...viewer, capabilities: ["inbox.view", "inbox.view_team"] };
    expect(wantsPush(team, "all", { ...conv, assigneeId: "U2" })).toBe(true);
    expect(wantsPush(team, "assigned", { ...conv, assigneeId: "U2" })).toBe(false);
  });
});

describe("deadTokens", () => {
  const msg = (to: string): PushMessage => ({ to, title: "t", body: "b", data: {}, sound: "default", channelId: "messages" });
  it("picks out only DeviceNotRegistered tickets, by position", () => {
    const tickets = [
      { status: "ok", id: "1" },
      { status: "error", details: { error: "DeviceNotRegistered" } },
      { status: "error", details: { error: "MessageRateExceeded" } },
    ];
    expect(deadTokens([msg("a"), msg("b"), msg("c")], tickets)).toEqual(["b"]);
    expect(deadTokens([msg("a")], null)).toEqual([]);
  });
});

describe("pushTitle", () => {
  const none = { name: null, phone: null, identityName: null, identityUsername: null };
  it("push title falls back to the identity name", () => {
    expect(pushTitle({ ...none, name: "Ada", phone: "+2347000000000", identityName: "Ada FB" })).toBe("Ada");
    expect(pushTitle({ ...none, phone: "+2347000000000", identityName: "Ada FB" })).toBe("+2347000000000");
    expect(pushTitle({ ...none, identityName: "Ada FB", identityUsername: "ada" })).toBe("Ada FB");
    expect(pushTitle({ ...none, identityUsername: "ada" })).toBe("@ada");
    expect(pushTitle(none)).toBe("New message");
  });
});

describe("push wording per channel (suite spec 02)", () => {
  const none = { name: null, phone: null, identityName: null, identityUsername: null };
  it("push body names the channel", () => {
    expect(pushBody("messenger", "text", "Hello")).toBe("Messenger: Hello");
    expect(pushBody("instagram", "image", null)).toBe("Instagram: 📷 Photo");
    expect(pushBody("whatsapp", "text", "Hi")).toBe("WhatsApp: Hi");
    expect(pushBody("messenger", "text", "x".repeat(300))).toHaveLength(120);
    expect(pushTitle(none, "instagram")).toBe("New Instagram message");
  });
  it("referral rows are not pushed", () => {
    const pending = [
      { id: "M1", type: "text", conversationId: "C1" },
      { id: "M2", type: "referral", conversationId: "C1" },
      { id: "M3", type: "referral", conversationId: "C2" },
    ];
    const picked = latestPushable(pending);
    expect([...picked.keys()]).toEqual(["C1"]);
    expect(picked.get("C1")!.id).toBe("M1"); // the referral after it does not replace it
  });
});

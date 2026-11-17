import { describe, it, expect } from "vitest";
import { deadTokens, wantsPush, type PushMessage } from "./inbox-push.js";
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

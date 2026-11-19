import { describe, expect, it } from "vitest";
import type { InboxViewer } from "@ms/domain";
import { shouldDeliver } from "../../src/inbox/realtime.js";

/** Suite spec 03, 5.9: who receives a live "comment.*" event. */

const LINE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function viewer(over: Partial<InboxViewer>): InboxViewer {
  return { userId: "u1", capabilities: ["inbox.view", "social.comments"], teamIds: [], numberIds: [LINE], ...over };
}

describe("live comment events", () => {
  const signal = { event: "comment.created" as const, id: "thread-1", phoneNumberId: LINE, assigneeId: null, direction: "in" as const };

  it("go to people with social.comments who may use the account", () => {
    expect(shouldDeliver(viewer({}), signal)).toBe(true);
    expect(shouldDeliver(viewer({ numberIds: "all" }), { ...signal, event: "comment.updated" })).toBe(true);
  });

  it("never go to someone without social.comments, even with every inbox permission", () => {
    expect(shouldDeliver(viewer({ capabilities: ["inbox.view", "inbox.view_all"], numberIds: "all" }), signal)).toBe(false);
  });

  it("never go to someone who may not use the account (R24)", () => {
    expect(shouldDeliver(viewer({ numberIds: [OTHER] }), signal)).toBe(false);
    expect(shouldDeliver(viewer({ numberIds: [] }), signal)).toBe(false);
  });

  it("are dropped when the event names no account", () => {
    expect(shouldDeliver(viewer({ numberIds: "all" }), { event: "comment.updated", id: "thread-1" })).toBe(false);
  });

  it("leave the conversation rule as it was", () => {
    const message = { event: "message.created" as const, conversationId: "c1", phoneNumberId: LINE, teamId: null, assigneeId: "u1" };
    expect(shouldDeliver(viewer({}), message)).toBe(true);
    expect(shouldDeliver(viewer({ capabilities: ["social.comments"] }), message)).toBe(false);
  });
});

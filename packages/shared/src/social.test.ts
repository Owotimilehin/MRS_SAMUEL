import { describe, expect, it } from "vitest";
import { canPrivateReply, commentActionsFor, type CommentFacts } from "./social.js";
import type { Capability } from "./permissions.js";

const NOW = new Date("2026-11-19T12:00:00Z");
const CAPS: Capability[] = ["social.comments", "inbox.reply"];

function comment(over: Partial<CommentFacts> = {}): CommentFacts {
  return {
    kind: "comment",
    status: "visible",
    fromBusiness: false,
    externalId: "123_456",
    likedByBusiness: false,
    commentedAt: new Date("2026-11-19T10:00:00Z"),
    privateReplyStatus: null,
    ...over,
  };
}

const on = (a: Record<string, boolean>) => Object.keys(a).filter((k) => a[k]).sort();

describe("commentActionsFor", () => {
  it("a visible customer comment on Facebook offers everything but unhide and unlike", () => {
    expect(on({ ...commentActionsFor(comment(), "facebook", CAPS, NOW) })).toEqual(["delete", "hide", "like", "private_reply", "reply"]);
  });
  it("hidden comment offers unhide and delete only", () => {
    expect(on({ ...commentActionsFor(comment({ status: "hidden" }), "facebook", CAPS, NOW) })).toEqual(["delete", "unhide"]);
    expect(on({ ...commentActionsFor(comment({ status: "hidden" }), "instagram", CAPS, NOW) })).toEqual(["delete", "unhide"]);
  });
  it("instagram never offers like", () => {
    const a = commentActionsFor(comment(), "instagram", CAPS, NOW);
    expect(a.like).toBe(false);
    expect(a.unlike).toBe(false);
    expect(commentActionsFor(comment({ likedByBusiness: true }), "instagram", CAPS, NOW).unlike).toBe(false);
    expect(a.reply).toBe(true);
  });
  it("live comment offers private reply only", () => {
    expect(on({ ...commentActionsFor(comment({ kind: "live" }), "instagram", CAPS, NOW) })).toEqual(["private_reply"]);
  });
  it("a mention offers nothing", () => {
    expect(on({ ...commentActionsFor(comment({ kind: "mention" }), "instagram", CAPS, NOW) })).toEqual([]);
  });
  it("a liked comment offers unlike, not like", () => {
    const a = commentActionsFor(comment({ likedByBusiness: true }), "facebook", CAPS, NOW);
    expect(a.like).toBe(false);
    expect(a.unlike).toBe(true);
  });
  it("the business's own comment can be answered and deleted, not hidden, liked or messaged", () => {
    expect(on({ ...commentActionsFor(comment({ fromBusiness: true }), "facebook", CAPS, NOW) })).toEqual(["delete", "reply"]);
  });
  it("a reply still being posted (no Meta ID yet) offers nothing", () => {
    expect(on({ ...commentActionsFor(comment({ fromBusiness: true, externalId: null }), "facebook", CAPS, NOW) })).toEqual([]);
  });
  it("a deleted comment offers nothing", () => {
    expect(on({ ...commentActionsFor(comment({ status: "deleted" }), "facebook", CAPS, NOW) })).toEqual([]);
  });
  it("without social.comments nothing is offered; without inbox.reply no private message", () => {
    expect(on({ ...commentActionsFor(comment(), "facebook", ["inbox.reply"], NOW) })).toEqual([]);
    expect(commentActionsFor(comment(), "facebook", ["social.comments"], NOW).private_reply).toBe(false);
    expect(commentActionsFor(comment(), "facebook", ["social.comments"], NOW).reply).toBe(true);
  });
  it("a switched-off account offers nothing", () => {
    expect(on({ ...commentActionsFor(comment(), "facebook", CAPS, NOW, { accountActive: false }) })).toEqual([]);
  });
});

describe("canPrivateReply", () => {
  it("false after 7 days, false when already sent, true after failed", () => {
    expect(canPrivateReply(comment({ commentedAt: new Date("2026-11-12T11:59:00Z") }), NOW)).toBe(false);
    expect(canPrivateReply(comment({ commentedAt: new Date("2026-11-12T12:01:00Z") }), NOW)).toBe(true);
    expect(canPrivateReply(comment({ privateReplyStatus: "sent" }), NOW)).toBe(false);
    expect(canPrivateReply(comment({ privateReplyStatus: "queued" }), NOW)).toBe(false);
    expect(canPrivateReply(comment({ privateReplyStatus: "failed" }), NOW)).toBe(true);
    expect(canPrivateReply(comment({ privateReplyStatus: "unknown" }), NOW)).toBe(true);
  });
  it("false for the business's own comment, a deleted or hidden one, a mention, and an ISO date works", () => {
    expect(canPrivateReply(comment({ fromBusiness: true }), NOW)).toBe(false);
    expect(canPrivateReply(comment({ status: "deleted" }), NOW)).toBe(false);
    expect(canPrivateReply(comment({ status: "hidden" }), NOW)).toBe(false);
    expect(canPrivateReply(comment({ kind: "mention" }), NOW)).toBe(false);
    expect(canPrivateReply(comment({ commentedAt: "2026-11-19T10:00:00Z" }), NOW)).toBe(true);
  });
});

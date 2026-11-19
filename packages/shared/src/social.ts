/**
 * Comments on Facebook and Instagram posts (suite spec 03): the types and the
 * pure rules shared by the API and the screens, so a button is never offered
 * for something the server would refuse.
 */
import type { Capability } from "./permissions.js";

export type SocialNetwork = "facebook" | "instagram";
export type CommentKind = "comment" | "live" | "mention";
export type CommentStatus = "visible" | "hidden" | "deleted";
export type CommentSendStatus = "queued" | "sent" | "failed" | "unknown";

/** The suite's own limit for a public reply and for a private reply (characters). */
export const COMMENT_MAX = 1000;
/** Meta allows one private reply, within this many days of the comment. */
export const PRIVATE_REPLY_DAYS = 7;

/** "Facebook" or "Instagram", for wording. */
export function networkName(network: SocialNetwork): string {
  return network === "instagram" ? "Instagram" : "Facebook";
}

/** The facts about one comment that decide which buttons it gets. */
export interface CommentFacts {
  kind: CommentKind;
  status: CommentStatus;
  fromBusiness: boolean;
  /** Meta's comment ID; null while a suite reply is still being posted. */
  externalId: string | null;
  likedByBusiness: boolean;
  commentedAt: Date | string;
  privateReplyStatus: CommentSendStatus | null;
}

export interface CommentActions {
  reply: boolean;
  hide: boolean;
  unhide: boolean;
  delete: boolean;
  like: boolean;
  unlike: boolean;
  private_reply: boolean;
}

const NO_ACTIONS: CommentActions = {
  reply: false,
  hide: false,
  unhide: false,
  delete: false,
  like: false,
  unlike: false,
  private_reply: false,
};

function millis(at: Date | string): number {
  return at instanceof Date ? at.getTime() : new Date(at).getTime();
}

/** Is the comment still inside Meta's 7 days for a private reply? */
export function withinPrivateReplyDays(commentedAt: Date | string, now: Date = new Date()): boolean {
  const t = millis(commentedAt);
  return Number.isFinite(t) && now.getTime() - t <= PRIVATE_REPLY_DAYS * 24 * 3600_000;
}

/**
 * May a private message be sent about this comment? A customer's own comment
 * (or live-video comment) that the public can still see, known to Meta, at most
 * 7 days old, with no private reply sent or on its way. After a failed or
 * unconfirmed attempt another one is allowed.
 */
export function canPrivateReply(c: CommentFacts, now: Date = new Date()): boolean {
  if (c.fromBusiness || !c.externalId) return false;
  if (c.status !== "visible") return false;
  if (c.kind !== "comment" && c.kind !== "live") return false;
  if (c.privateReplyStatus === "sent" || c.privateReplyStatus === "queued") return false;
  return withinPrivateReplyDays(c.commentedAt, now);
}

/**
 * Which buttons a comment gets (spec 03 rules R5 to R8, R16, R17). Everything
 * needs social.comments; a private message also needs inbox.reply. A switched-off
 * account (R25) offers nothing.
 */
export function commentActionsFor(
  c: CommentFacts,
  network: SocialNetwork,
  caps: readonly Capability[],
  now: Date = new Date(),
  opts: { accountActive?: boolean } = {},
): CommentActions {
  if (!caps.includes("social.comments") || opts.accountActive === false) return { ...NO_ACTIONS };
  const known = !!c.externalId;
  const privateReply = caps.includes("inbox.reply") && canPrivateReply(c, now);
  // Live-video comments: Meta allows only a private message. Mentions: nothing in Phase A.
  if (c.kind !== "comment") return { ...NO_ACTIONS, private_reply: privateReply };
  if (!known || c.status === "deleted") return { ...NO_ACTIONS };
  const visible = c.status === "visible";
  const facebook = network === "facebook";
  return {
    reply: visible,
    hide: visible && !c.fromBusiness,
    unhide: c.status === "hidden",
    delete: true,
    like: facebook && visible && !c.fromBusiness && !c.likedByBusiness,
    unlike: facebook && visible && !c.fromBusiness && c.likedByBusiness,
    private_reply: privateReply,
  };
}

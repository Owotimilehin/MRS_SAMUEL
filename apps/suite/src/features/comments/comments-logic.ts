/** Pure rules for the Comments screens (suite spec 03, section 7). No React, no network. */
import { networkName, type SocialNetwork } from "@ms/shared";
import type { CommentItem, PrivateReply, ThreadSummary } from "./comments-types.js";

export type CommentTab = "open" | "mine" | "done" | "hidden" | "mentions";

export const COMMENT_TABS: { id: CommentTab; label: string }[] = [
  { id: "open", label: "Needs a reply" },
  { id: "mine", label: "Mine" },
  { id: "done", label: "Done" },
  { id: "hidden", label: "Hidden" },
  { id: "mentions", label: "Mentions" },
];

export interface ThreadFilters {
  tab: CommentTab;
  account: string;
  q: string;
}

/** The query string GET /threads takes for a tab, an account and a search. */
export function threadQuery(f: ThreadFilters): string {
  const p = new URLSearchParams();
  if (f.tab === "open") p.set("state", "open");
  if (f.tab === "mine") {
    p.set("state", "open");
    p.set("view", "mine");
  }
  if (f.tab === "done") p.set("state", "done");
  if (f.tab === "hidden") {
    p.set("hidden", "1");
    p.set("state", "all");
  }
  if (f.tab === "mentions") {
    p.set("kind", "mention");
    p.set("state", "all");
  }
  if (f.account) p.set("account", f.account);
  if (f.q.trim()) p.set("q", f.q.trim());
  return p.toString();
}

export interface Chip {
  text: string;
  tone: "grey" | "amber" | "red" | "blue";
}

type ChipFacts = Pick<ThreadSummary, "status" | "hidden_source" | "kind" | "network" | "assignee_name"> & { post: { is_ad: boolean } };

/** The small labels on a list row, in the order shown. */
export function statusChip(t: ChipFacts): Chip[] {
  const chips: Chip[] = [];
  if (t.status === "hidden") {
    chips.push({ text: t.hidden_source === "suite" ? "Hidden by us" : `Hidden on ${networkName(t.network)}`, tone: "amber" });
  }
  if (t.status === "deleted") chips.push({ text: "Deleted", tone: "red" });
  if (t.kind === "mention") chips.push({ text: "Mention", tone: "blue" });
  if (t.kind === "live") chips.push({ text: "Live video", tone: "blue" });
  if (t.post.is_ad) chips.push({ text: "On an advert", tone: "grey" });
  const first = t.assignee_name?.trim().split(/\s+/)[0];
  if (first) chips.push({ text: first, tone: "grey" });
  return chips;
}

/** Who wrote: their name, else @username, else "Someone on Facebook". */
export function threadTitle(t: { author_name: string | null; author_username: string | null; network: SocialNetwork }): string {
  if (t.author_name?.trim()) return t.author_name.trim();
  if (t.author_username?.trim()) return `@${t.author_username.trim().replace(/^@/, "")}`;
  return `Someone on ${networkName(t.network)}`;
}

/** Who a comment row is by: "You" (with the staff member's name when we know it) or the customer. */
export function commentAuthor(c: CommentItem, network: SocialNetwork): string {
  if (c.from_business) return c.sent_by_name ? `You (${c.sent_by_name})` : "You";
  return threadTitle({ author_name: c.author_name, author_username: c.author_username, network });
}

/** What a comment row shows as its text (rule R22: a photo, sticker or GIF has none). */
export function commentText(c: Pick<CommentItem, "message">): string {
  return c.message?.trim() ? c.message : "Photo or video";
}

export interface PrivateReplyView {
  tone: "grey" | "red" | "amber";
  text: string;
  /** "Open the chat" is offered. */
  chat: boolean;
  /** "Try again" is offered. */
  retry: boolean;
  /** The line under a sent message that has no chat yet. */
  hint: string | null;
}

/** The box under a comment that has a private message (spec 03, 7, thread pane). */
export function privateReplyState(p: PrivateReply, when: string): PrivateReplyView {
  if (p.status === "failed") {
    return { tone: "red", text: `Private message not sent. ${p.error ?? ""}`.trim(), chat: false, retry: true, hint: null };
  }
  if (p.status === "unknown") {
    return { tone: "amber", text: "Private message not confirmed. Check the Inbox before trying again.", chat: !!p.conversation_id, retry: false, hint: null };
  }
  if (p.status === "queued") return { tone: "grey", text: "Sending the private message…", chat: false, retry: false, hint: null };
  const who = p.by_name ? ` by ${p.by_name}` : "";
  // The text is removed when the customer's inbox history is erased.
  const said = p.body ? `: “${p.body}”` : "";
  return {
    tone: "grey",
    text: `Private message sent${who}, ${when}${said}`,
    chat: !!p.conversation_id,
    retry: false,
    hint: p.conversation_id ? null : "The chat will appear in the Inbox when the customer answers.",
  };
}

/** What sits under a reply written in the suite, by its send state. */
export function sendStateLine(c: Pick<CommentItem, "send_status" | "error_message">, network: SocialNetwork): { tone: "grey" | "red" | "amber"; text: string } | null {
  if (c.send_status === "queued") return { tone: "grey", text: "Sending…" };
  if (c.send_status === "failed") return { tone: "red", text: `Not posted. ${c.error_message ?? ""}`.trim() };
  if (c.send_status === "unknown") {
    return { tone: "amber", text: `Not confirmed. It may have been posted. Check on ${networkName(network)} before trying again.` };
  }
  return null;
}

export interface CommentAlertContext {
  userId: string;
  level: "all" | "assigned" | "none";
  /** The thread open on screen, if any. */
  openThreadId: string | null;
  tabActive: boolean;
}

/** Should a live "comment.created" event make a sound and a pop-up for this person? */
export function shouldAlertForComment(
  e: { event: string; direction?: "in" | "out"; id?: string; assigneeId?: string | null },
  ctx: CommentAlertContext,
): boolean {
  if (e.event !== "comment.created" || e.direction !== "in" || !e.id) return false;
  if (ctx.level === "none") return false;
  if (ctx.level === "assigned" && e.assigneeId && e.assigneeId !== ctx.userId) return false;
  if (ctx.tabActive && ctx.openThreadId === e.id) return false;
  return true;
}

/** The thread in the address, if one is open: /comments/<id>. */
export function threadIdFromPath(pathname: string): string | null {
  const m = /^\/comments\/([^/]+)\/?$/.exec(pathname);
  return m ? m[1]! : null;
}

/** The empty list's title and text, by tab and whether a search is on. */
export function emptyText(tab: CommentTab, searching: boolean): { title: string; text: string } {
  if (searching) return { title: "No matches", text: "Try a different name or word." };
  if (tab === "open") return { title: "All caught up", text: "No comments are waiting for a reply." };
  return { title: "Nothing here", text: "No comments match this view." };
}

/** The wording of each confirm dialog (spec 03, 7, dialogs). */
export function confirmCopy(
  kind: "reply" | "hide" | "unhide" | "delete",
  network: SocialNetwork,
): { title: string; body: string; confirm: string; busy: string; danger: boolean } {
  const name = networkName(network);
  if (kind === "reply") {
    return { title: "Post this reply?", body: "Everyone who can see the post will see this reply.", confirm: "Post reply", busy: "Posting…", danger: false };
  }
  if (kind === "hide") {
    return {
      title: "Hide this comment?",
      body: "Other people will no longer see it under the post. You can show it again later.",
      confirm: "Hide comment",
      busy: "Hiding…",
      danger: false,
    };
  }
  if (kind === "unhide") {
    return { title: "Show this comment again?", body: "Everyone who can see the post will see it again.", confirm: "Show comment", busy: "Showing…", danger: false };
  }
  return {
    title: "Delete this comment?",
    body: `This removes the comment from ${name} for everyone. It cannot be undone.`,
    confirm: "Delete comment",
    busy: "Deleting…",
    danger: true,
  };
}

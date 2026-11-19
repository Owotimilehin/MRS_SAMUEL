import { describe, expect, it } from "vitest";
import {
  commentAuthor,
  commentText,
  confirmCopy,
  emptyText,
  privateReplyState,
  sendStateLine,
  shouldAlertForComment,
  statusChip,
  threadIdFromPath,
  threadQuery,
  threadTitle,
} from "./comments-logic.js";
import type { CommentItem } from "./comments-types.js";

const thread = (over: Record<string, unknown> = {}) => ({
  status: "visible" as const,
  hidden_source: null,
  kind: "comment" as const,
  network: "facebook" as const,
  assignee_name: null,
  post: { is_ad: false },
  ...over,
});

describe("statusChip", () => {
  it("hidden by us, hidden on Facebook, deleted, mention, advert", () => {
    expect(statusChip(thread())).toEqual([]);
    expect(statusChip(thread({ status: "hidden", hidden_source: "suite" })).map((c) => c.text)).toEqual(["Hidden by us"]);
    expect(statusChip(thread({ status: "hidden", hidden_source: "outside" })).map((c) => c.text)).toEqual(["Hidden on Facebook"]);
    expect(statusChip(thread({ status: "hidden", hidden_source: "outside", network: "instagram" })).map((c) => c.text)).toEqual(["Hidden on Instagram"]);
    expect(statusChip(thread({ status: "deleted" })).map((c) => c.text)).toEqual(["Deleted"]);
    expect(statusChip(thread({ kind: "mention" })).map((c) => c.text)).toEqual(["Mention"]);
    expect(statusChip(thread({ kind: "live" })).map((c) => c.text)).toEqual(["Live video"]);
    expect(statusChip(thread({ post: { is_ad: true } })).map((c) => c.text)).toEqual(["On an advert"]);
  });
  it("shows the assignee's first name last", () => {
    expect(statusChip(thread({ status: "hidden", hidden_source: "suite", assignee_name: "Funke Adeyemi" })).map((c) => c.text)).toEqual(["Hidden by us", "Funke"]);
  });
});

describe("shouldAlertForComment", () => {
  const e = { event: "comment.created", direction: "in" as const, id: "t1", assigneeId: null };
  const ctx = { userId: "me", level: "all" as const, openThreadId: null, tabActive: true };
  it("none never alerts; assigned skips other people's threads; open thread in an active tab is silent", () => {
    expect(shouldAlertForComment(e, ctx)).toBe(true);
    expect(shouldAlertForComment(e, { ...ctx, level: "none" })).toBe(false);
    expect(shouldAlertForComment({ ...e, assigneeId: "someone-else" }, { ...ctx, level: "assigned" })).toBe(false);
    expect(shouldAlertForComment({ ...e, assigneeId: "me" }, { ...ctx, level: "assigned" })).toBe(true);
    expect(shouldAlertForComment(e, { ...ctx, level: "assigned" })).toBe(true); // nobody's yet
    expect(shouldAlertForComment(e, { ...ctx, openThreadId: "t1" })).toBe(false);
    expect(shouldAlertForComment(e, { ...ctx, openThreadId: "t1", tabActive: false })).toBe(true);
  });
  it("only a customer's new comment alerts", () => {
    expect(shouldAlertForComment({ ...e, direction: "out" }, ctx)).toBe(false);
    expect(shouldAlertForComment({ ...e, event: "comment.updated" }, ctx)).toBe(false);
    expect(shouldAlertForComment({ ...e, event: "message.created" }, ctx)).toBe(false);
    expect(shouldAlertForComment({ event: "comment.created", direction: "in" }, ctx)).toBe(false);
  });
});

describe("names and text", () => {
  it("threadTitle falls back from name to @username to the network", () => {
    expect(threadTitle({ author_name: "Ada Obi", author_username: "ada", network: "facebook" })).toBe("Ada Obi");
    expect(threadTitle({ author_name: null, author_username: "bisi_juice", network: "instagram" })).toBe("@bisi_juice");
    expect(threadTitle({ author_name: " ", author_username: null, network: "facebook" })).toBe("Someone on Facebook");
    expect(threadTitle({ author_name: null, author_username: null, network: "instagram" })).toBe("Someone on Instagram");
  });
  it("a business reply shows as You, with the staff name when known", () => {
    const c = { from_business: true, sent_by_name: "Funke", author_name: "Mrs Samuel", author_username: null } as CommentItem;
    expect(commentAuthor(c, "facebook")).toBe("You (Funke)");
    expect(commentAuthor({ ...c, sent_by_name: null }, "facebook")).toBe("You");
    expect(commentAuthor({ ...c, from_business: false, author_name: "Ada Obi" }, "facebook")).toBe("Ada Obi");
  });
  it("an empty comment reads Photo or video (R22)", () => {
    expect(commentText({ message: null })).toBe("Photo or video");
    expect(commentText({ message: "  " })).toBe("Photo or video");
    expect(commentText({ message: "Hello" })).toBe("Hello");
  });
});

describe("privateReplyState", () => {
  const p = { status: "sent" as const, body: "Hello", by_name: "Funke", at: "2026-11-19T10:00:00Z", error: null, conversation_id: "c1" };
  it("sent with a chat, sent without one, failed, not confirmed", () => {
    expect(privateReplyState(p, "10:00")).toMatchObject({ text: "Private message sent by Funke, 10:00: “Hello”", chat: true, retry: false, hint: null });
    expect(privateReplyState({ ...p, conversation_id: null }, "10:00")).toMatchObject({
      chat: false,
      hint: "The chat will appear in the Inbox when the customer answers.",
    });
    expect(privateReplyState({ ...p, status: "failed", error: "Facebook refused this: too late (code 10)." }, "10:00")).toMatchObject({
      tone: "red",
      text: "Private message not sent. Facebook refused this: too late (code 10).",
      retry: true,
    });
    expect(privateReplyState({ ...p, status: "unknown" }, "10:00")).toMatchObject({
      tone: "amber",
      text: "Private message not confirmed. Check the Inbox before trying again.",
      retry: false,
    });
    expect(privateReplyState({ ...p, body: "", by_name: null }, "10:00").text).toBe("Private message sent, 10:00");
  });
});

describe("send state, filters and wording", () => {
  it("sendStateLine says Sending, Not posted or Not confirmed", () => {
    expect(sendStateLine({ send_status: "queued", error_message: null }, "facebook")).toEqual({ tone: "grey", text: "Sending…" });
    expect(sendStateLine({ send_status: "failed", error_message: "Facebook refused this: nope (code 1)." }, "facebook")).toEqual({
      tone: "red",
      text: "Not posted. Facebook refused this: nope (code 1).",
    });
    expect(sendStateLine({ send_status: "unknown", error_message: null }, "instagram")?.text).toBe(
      "Not confirmed. It may have been posted. Check on Instagram before trying again.",
    );
    expect(sendStateLine({ send_status: "sent", error_message: null }, "facebook")).toBeNull();
    expect(sendStateLine({ send_status: null, error_message: null }, "facebook")).toBeNull();
  });
  it("threadQuery builds the list request for each tab", () => {
    expect(threadQuery({ tab: "open", account: "", q: "" })).toBe("state=open");
    expect(threadQuery({ tab: "mine", account: "", q: "" })).toBe("state=open&view=mine");
    expect(threadQuery({ tab: "done", account: "", q: "" })).toBe("state=done");
    expect(threadQuery({ tab: "hidden", account: "", q: "" })).toBe("hidden=1&state=all");
    expect(threadQuery({ tab: "mentions", account: "a1", q: " ada " })).toBe("kind=mention&state=all&account=a1&q=ada");
  });
  it("emptyText depends on the tab and on searching", () => {
    expect(emptyText("open", false)).toEqual({ title: "All caught up", text: "No comments are waiting for a reply." });
    expect(emptyText("done", false)).toEqual({ title: "Nothing here", text: "No comments match this view." });
    expect(emptyText("open", true)).toEqual({ title: "No matches", text: "Try a different name or word." });
  });
  it("threadIdFromPath reads the open thread", () => {
    expect(threadIdFromPath("/comments/abc")).toBe("abc");
    expect(threadIdFromPath("/comments")).toBeNull();
    expect(threadIdFromPath("/inbox/abc")).toBeNull();
  });
  it("confirmCopy names the network when deleting and marks only delete as dangerous", () => {
    expect(confirmCopy("delete", "instagram")).toMatchObject({ title: "Delete this comment?", body: "This removes the comment from Instagram for everyone. It cannot be undone.", danger: true });
    expect(confirmCopy("reply", "facebook")).toMatchObject({ title: "Post this reply?", confirm: "Post reply", busy: "Posting…", danger: false });
    expect(confirmCopy("hide", "facebook")).toMatchObject({ confirm: "Hide comment", busy: "Hiding…" });
    expect(confirmCopy("unhide", "facebook")).toMatchObject({ title: "Show this comment again?", confirm: "Show comment", busy: "Showing…" });
  });
});

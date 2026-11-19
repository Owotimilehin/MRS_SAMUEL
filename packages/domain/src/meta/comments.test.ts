import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaApiError, type MetaConfig } from "../inbox/meta.js";
import { META_CHANGE_HANDLERS } from "../inbox/messenger-ingest.js";
import { clearPageTokenCache, type ChannelAccount } from "./accounts.js";
import { PAGE_WEBHOOK_FIELDS } from "./messaging.js";
import {
  classifyMetaError,
  deleteRemoteComment,
  ensurePageSubscribed,
  explainCommentError,
  fetchComment,
  fetchPost,
  isCommentEvent,
  listPostComments,
  listRecentPosts,
  oldestFirst,
  parseInstagramChange,
  parsePageChange,
  publishReply,
  sendPrivateReply,
  setCommentHidden,
  setCommentLiked,
  type RemoteComment,
} from "./comments.js";

/** Suite spec 03 unit tests. No database; every Graph call is a stub. */

const PAGE = "100200300400";
const IG = "17841400000000001";
const POST = `${PAGE}_555`;
const T = 1_795_000_000; // seconds

describe("parsePageChange", () => {
  const add = (over: Record<string, unknown> = {}) => ({
    item: "comment",
    verb: "add",
    comment_id: `${POST}_900`,
    post_id: POST,
    parent_id: POST,
    from: { id: "24000000000000001", name: "Ada Obi" },
    message: "Do you deliver to Ikeja?",
    created_time: T,
    post: { permalink_url: "https://www.facebook.com/posts/555" },
    ...over,
  });

  it("comment add becomes a top-level upsert when parent_id equals post_id", () => {
    const c = parsePageChange(PAGE, "feed", add(), T + 5);
    expect(c).toMatchObject({
      type: "upsert",
      network: "facebook",
      accountExternalId: PAGE,
      kind: "comment",
      externalId: `${POST}_900`,
      postExternalId: POST,
      parentExternalId: null,
      authorExternalId: "24000000000000001",
      authorName: "Ada Obi",
      message: "Do you deliver to Ikeja?",
      edited: false,
      postPermalink: "https://www.facebook.com/posts/555",
      isAd: false,
    });
    expect(parsePageChange(PAGE, "feed", add({ parent_id: undefined }), T)).toMatchObject({ parentExternalId: null });
  });

  it("comment add with a comment parent becomes a reply", () => {
    const c = parsePageChange(PAGE, "feed", add({ comment_id: `${POST}_901`, parent_id: `${POST}_900` }), T);
    expect(c).toMatchObject({ type: "upsert", externalId: `${POST}_901`, parentExternalId: `${POST}_900` });
  });

  it("edited sets edited true", () => {
    for (const verb of ["edited", "edit", "update"]) {
      expect(parsePageChange(PAGE, "feed", add({ verb }), T)).toMatchObject({ type: "upsert", edited: true });
    }
  });

  it("remove, hide and unhide become status changes", () => {
    const status = (verb: string) => parsePageChange(PAGE, "feed", { item: "comment", verb, comment_id: "c1", post_id: POST }, T);
    expect(status("remove")).toMatchObject({ type: "status", status: "deleted", externalId: "c1", network: "facebook" });
    expect(status("delete")).toMatchObject({ type: "status", status: "deleted" });
    expect(status("hide")).toMatchObject({ type: "status", status: "hidden" });
    expect(status("unhide")).toMatchObject({ type: "status", status: "visible" });
    const c = status("hide");
    expect(c.type === "status" && c.at.getTime()).toBe(T * 1000);
  });

  it("reaction and post items are ignored", () => {
    expect(parsePageChange(PAGE, "feed", { item: "reaction", verb: "add", post_id: POST, reaction_type: "like" }, T).type).toBe("ignored");
    expect(parsePageChange(PAGE, "feed", { item: "post", verb: "add", post_id: POST }, T).type).toBe("ignored");
    expect(parsePageChange(PAGE, "feed", { item: "comment", verb: "add", post_id: POST }, T).type).toBe("ignored"); // no comment id
    for (const verb of ["block", "follow", "mute", "unblock"]) {
      expect(parsePageChange(PAGE, "feed", add({ verb }), T).type).toBe("ignored");
    }
    expect(parsePageChange(PAGE, "ratings", add(), T).type).toBe("ignored");
  });

  it("created_time as a number and as an ISO string both parse", () => {
    const n = parsePageChange(PAGE, "feed", add({ created_time: T }), T + 60);
    const s = parsePageChange(PAGE, "feed", add({ created_time: "2026-11-19T10:00:00+0000" }), T + 60);
    const none = parsePageChange(PAGE, "feed", add({ created_time: undefined }), T + 60);
    expect(n.type === "upsert" && n.commentedAt.getTime()).toBe(T * 1000);
    expect(s.type === "upsert" && s.commentedAt.toISOString()).toBe("2026-11-19T10:00:00.000Z");
    expect(none.type === "upsert" && none.commentedAt.getTime()).toBe((T + 60) * 1000);
  });

  it("photo or video becomes the attachment; an empty message is null", () => {
    const c = parsePageChange(PAGE, "feed", add({ message: "", photo: "https://cdn.example/p.jpg" }), T);
    expect(c).toMatchObject({ message: null, attachmentUrl: "https://cdn.example/p.jpg" });
  });

  it("mention with comment_id becomes kind mention; without is ignored", () => {
    const m = parsePageChange(PAGE, "mention", { item: "comment", verb: "add", comment_id: "c9", post_id: "777_888", message: "@Mrs Samuel" }, T);
    expect(m).toMatchObject({ type: "upsert", kind: "mention", externalId: "c9", postExternalId: "777_888", edited: false });
    expect(parsePageChange(PAGE, "mention", { item: "post", verb: "add", post_id: "777_888" }, T).type).toBe("ignored");
    expect(parsePageChange(PAGE, "mention", { item: "comment", verb: "add", post_id: "777_888" }, T).type).toBe("ignored");
    expect(parsePageChange(PAGE, "mention", { item: "comment", verb: "add", comment_id: "c9" }, T).type).toBe("ignored");
  });
});

describe("parseInstagramChange", () => {
  const value = (over: Record<string, unknown> = {}) => ({
    from: { id: "980000000000000001", username: "bisi_juice" },
    media: { id: "17900000000000001", media_product_type: "FEED" },
    text: "How much is the big bottle?",
    ...over,
  });

  it("reads the id from value.id and from value.comment_id", () => {
    expect(parseInstagramChange(IG, "comments", value({ id: "c_ig_1" }), T)).toMatchObject({
      type: "upsert",
      network: "instagram",
      accountExternalId: IG,
      kind: "comment",
      externalId: "c_ig_1",
      postExternalId: "17900000000000001",
      parentExternalId: null,
      authorExternalId: "980000000000000001",
      authorUsername: "bisi_juice",
      authorName: null,
      message: "How much is the big bottle?",
      isAd: false,
    });
    expect(parseInstagramChange(IG, "comments", value({ comment_id: "c_ig_2" }), T)).toMatchObject({ externalId: "c_ig_2" });
    expect(parseInstagramChange(IG, "comments", value(), T).type).toBe("ignored");
    expect(parseInstagramChange(IG, "comments", value({ id: "c", media: {} }), T).type).toBe("ignored");
    const c = parseInstagramChange(IG, "comments", value({ id: "c" }), T);
    expect(c.type === "upsert" && c.commentedAt.getTime()).toBe(T * 1000);
  });

  it("parent_id makes a reply; ad_id sets isAd", () => {
    const c = parseInstagramChange(IG, "comments", value({ id: "c2", parent_id: "c1", media: { id: "m1", ad_id: "ad9" } }), T);
    expect(c).toMatchObject({ parentExternalId: "c1", isAd: true, postExternalId: "m1" });
  });

  it("live_comments sets kind live", () => {
    expect(parseInstagramChange(IG, "live_comments", value({ id: "c3" }), T)).toMatchObject({ type: "upsert", kind: "live" });
  });

  it("mentions with and without comment_id", () => {
    expect(parseInstagramChange(IG, "mentions", { media_id: "m5", comment_id: "c5" }, T)).toMatchObject({
      type: "mention_ref",
      mediaExternalId: "m5",
      commentExternalId: "c5",
    });
    expect(parseInstagramChange(IG, "mentions", { media_id: "m5" }, T)).toMatchObject({ type: "mention_ref", commentExternalId: null });
    expect(parseInstagramChange(IG, "mentions", { comment_id: "c5" }, T).type).toBe("ignored");
    expect(parseInstagramChange(IG, "story_insights", {}, T).type).toBe("ignored");
  });
});

describe("isCommentEvent", () => {
  it("true for feed and comments, false for a messaging payload", () => {
    expect(isCommentEvent({ object: "page", entry: [{ id: PAGE, changes: [{ field: "feed", value: {} }] }] })).toBe(true);
    expect(isCommentEvent({ object: "page", entry: [{ id: PAGE, changes: [{ field: "mention", value: {} }] }] })).toBe(true);
    expect(isCommentEvent({ object: "instagram", entry: [{ id: IG, changes: [{ field: "comments", value: {} }] }] })).toBe(true);
    expect(isCommentEvent({ object: "instagram", entry: [{ id: IG, changes: [{ field: "live_comments", value: {} }] }] })).toBe(true);
    expect(isCommentEvent({ object: "page", entry: [{ id: PAGE, messaging: [{ sender: { id: "1" }, message: { mid: "m" } }] }] })).toBe(false);
    expect(isCommentEvent({ object: "page", entry: [{ id: PAGE, changes: [{ field: "leadgen", value: {} }] }] })).toBe(false);
    // A Page field name under the Instagram object (and the other way round) is not ours.
    expect(isCommentEvent({ object: "instagram", entry: [{ id: IG, changes: [{ field: "feed", value: {} }] }] })).toBe(false);
    expect(isCommentEvent(null)).toBe(false);
    expect(isCommentEvent({ object: "user", entry: [] })).toBe(false);
  });

  it("the handlers are registered at the shared webhook's dispatch point", () => {
    for (const key of ["page.feed", "page.mention", "instagram.comments", "instagram.live_comments", "instagram.mentions"]) {
      expect(typeof META_CHANGE_HANDLERS[key]).toBe("function");
    }
  });
});

describe("classifyMetaError", () => {
  const meta = (code: string | null, status = 400, message = "refused", subcode: string | null = null) =>
    new MetaApiError(message, status, code, false, "not_sent", subcode);

  it('190/200/283 config, 80001/80002/613/429 temporary, 100 "does not exist" gone, timeout unknown, anything else refused', () => {
    for (const code of ["190", "200", "283", "10", "299"]) expect(classifyMetaError(meta(code))).toBe("config");
    for (const code of ["80001", "80002", "80006", "80007", "613", "4", "17", "32"]) expect(classifyMetaError(meta(code))).toBe("temporary");
    expect(classifyMetaError(meta(null, 429))).toBe("temporary");
    expect(classifyMetaError(meta("1", 500))).toBe("temporary");
    expect(classifyMetaError(meta("100", 400, "Unsupported get request. Object with ID 'x' does not exist"))).toBe("gone");
    expect(classifyMetaError(meta("100", 400, "(#100) The object cannot be loaded"))).toBe("gone");
    expect(classifyMetaError(meta("100", 400, "(#100) Invalid parameter"))).toBe("refused");
    expect(classifyMetaError(new MetaApiError("No answer from Meta", 0, null, true, "unknown"))).toBe("unknown");
    // A bare 5xx with no structured error leaves it unknown (the reply may have gone).
    expect(classifyMetaError(new MetaApiError("Meta API 502", 502, null, true, "unknown"))).toBe("unknown");
    expect(classifyMetaError(new MetaApiError("Could not reach Meta", 0, "ENOTFOUND", true, "not_sent"))).toBe("temporary");
    expect(classifyMetaError(meta("10900"))).toBe("refused");
    expect(classifyMetaError(meta("368"))).toBe("refused");
    expect(classifyMetaError(new Error("boom"))).toBe("refused");
  });

  it("code and subcode pairs about one person are refusals, not configuration (foundation C2)", () => {
    expect(classifyMetaError(meta("10", 400, "outside window", "2018278"))).toBe("refused");
    expect(classifyMetaError(meta("200", 400, "person unavailable", "1545041"))).toBe("refused");
    expect(classifyMetaError(meta("10", 400, "no permission", "999"))).toBe("config");
  });

  it("explains each class in plain words and keeps Meta's code for a refusal", () => {
    expect(explainCommentError(meta("190"), "facebook")).toContain("lost its permission");
    expect(explainCommentError(meta("613"), "instagram")).toContain("Instagram is busy");
    expect(explainCommentError(new MetaApiError("No answer from Meta", 0, null, true, "unknown"), "facebook")).toBe(
      "No answer from Facebook, so we can't tell if it worked.",
    );
    expect(explainCommentError(meta("10900", 400, "(#10900) Activity already replied to"), "instagram")).toBe(
      "Instagram refused this: (#10900) Activity already replied to (code 10900).",
    );
  });
});

// ── Graph calls ──────────────────────────────────────────────────────────────

const cfg: MetaConfig = { token: "SYSTEM-TOKEN", graphVersion: "v23.0", appId: "APP1" };
const fb: ChannelAccount = { id: "acc-fb", kind: "messenger", label: "Facebook Page", externalId: PAGE, pageId: PAGE, isActive: true };
const ig: ChannelAccount = { id: "acc-ig", kind: "instagram", label: "Instagram", externalId: IG, pageId: PAGE, isActive: true };
const BASE = "https://graph.facebook.com/v23.0/";

type Call = { method: string; path: string; auth: string | null; body: unknown };
let calls: Call[] = [];
let answer: (call: Call) => unknown = () => ({});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("comment Graph calls", () => {
  beforeEach(() => {
    calls = [];
    answer = () => ({});
    clearPageTokenCache();
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (!url.startsWith(BASE)) throw new Error(`unexpected call: ${url}`);
      const path = url.slice(BASE.length);
      const auth = (init.headers as Record<string, string> | undefined)?.authorization ?? null;
      if (path.endsWith("?fields=access_token")) return json({ access_token: "PAGE-TOKEN-1" });
      const call: Call = { method: init.method ?? "GET", path, auth, body: init.body ? JSON.parse(String(init.body)) : null };
      calls.push(call);
      const out = answer(call);
      return out instanceof Response ? out : json(out);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("publishReply posts to {comment}/comments on Facebook and {comment}/replies on Instagram, with the Page token", async () => {
    answer = () => ({ id: "new_1" });
    expect(await publishReply(cfg, fb, `${POST}_900`, "Yes, every day.")).toBe("new_1");
    expect(await publishReply(cfg, ig, "c_ig_1", "Yes, every day.")).toBe("new_1");
    expect(calls).toEqual([
      { method: "POST", path: `${POST}_900/comments`, auth: "Bearer PAGE-TOKEN-1", body: { message: "Yes, every day." } },
      { method: "POST", path: "c_ig_1/replies", auth: "Bearer PAGE-TOKEN-1", body: { message: "Yes, every day." } },
    ]);
  });

  it("publishReply with no id in the answer is 'unknown', never a failure to retry", async () => {
    answer = () => ({});
    const err = await publishReply(cfg, fb, "c1", "x").catch((e: unknown) => e);
    expect(classifyMetaError(err)).toBe("unknown");
  });

  it("hide, show and delete call the right endpoints on each network", async () => {
    answer = () => ({ success: true });
    await setCommentHidden(cfg, fb, "c1", true);
    await setCommentHidden(cfg, fb, "c1", false);
    await setCommentHidden(cfg, ig, "c2", true);
    await setCommentHidden(cfg, ig, "c2", false);
    await deleteRemoteComment(cfg, fb, "c1");
    await deleteRemoteComment(cfg, ig, "c2");
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "c1", { is_hidden: true }],
      ["POST", "c1", { is_hidden: false }],
      ["POST", "c2?hide=true", null],
      ["POST", "c2?hide=false", null],
      ["DELETE", "c1", null],
      ["DELETE", "c2", null],
    ]);
    answer = () => ({ success: false });
    await expect(setCommentHidden(cfg, fb, "c1", true)).rejects.toBeInstanceOf(MetaApiError);
  });

  it("like and unlike are Facebook only", async () => {
    answer = () => ({ success: true });
    await setCommentLiked(cfg, fb, "c1", true);
    await setCommentLiked(cfg, fb, "c1", false);
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", "c1/likes"],
      ["DELETE", "c1/likes"],
    ]);
    await expect(setCommentLiked(cfg, ig, "c2", true)).rejects.toThrow("not supported");
    expect(calls).toHaveLength(2);
  });

  it("sendPrivateReply sends recipient.comment_id to the Page (Facebook) or the Instagram account", async () => {
    answer = () => ({ recipient_id: "PSID1", message_id: "m_out_1" });
    expect(await sendPrivateReply(cfg, fb, "c1", "Hello")).toEqual({ recipientId: "PSID1", messageId: "m_out_1" });
    answer = () => ({ message_id: "m_out_2" });
    expect(await sendPrivateReply(cfg, ig, "c2", "Hello")).toEqual({ recipientId: null, messageId: "m_out_2" });
    expect(calls).toEqual([
      { method: "POST", path: `${PAGE}/messages`, auth: "Bearer PAGE-TOKEN-1", body: { recipient: { comment_id: "c1" }, message: { text: "Hello" } } },
      { method: "POST", path: `${IG}/messages`, auth: "Bearer PAGE-TOKEN-1", body: { recipient: { comment_id: "c2" }, message: { text: "Hello" } } },
    ]);
  });

  it("fetchPost reads a Facebook post and an Instagram media", async () => {
    answer = () => ({
      id: POST,
      story: "Mrs Samuel updated her cover photo.",
      created_time: "2026-11-18T08:00:00+0000",
      updated_time: "2026-11-19T09:00:00+0000",
      permalink_url: "https://www.facebook.com/posts/555",
      full_picture: "https://cdn.example/p.jpg",
      status_type: "added_photos",
    });
    expect(await fetchPost(cfg, fb, POST)).toEqual({
      externalId: POST,
      message: "Mrs Samuel updated her cover photo.",
      permalinkUrl: "https://www.facebook.com/posts/555",
      pictureUrl: "https://cdn.example/p.jpg",
      mediaType: "added_photos",
      postedAt: new Date("2026-11-18T08:00:00Z"),
      commentCount: null,
      updatedAt: new Date("2026-11-19T09:00:00Z"),
    });
    expect(calls[0]!.path).toBe(`${POST}?fields=id,message,story,created_time,updated_time,permalink_url,full_picture,status_type`);

    answer = () => ({ id: "m1", caption: "New flavour", media_type: "VIDEO", media_url: "https://cdn.example/v.mp4", thumbnail_url: "https://cdn.example/t.jpg", permalink: "https://www.instagram.com/p/x/", timestamp: "2026-11-18T08:00:00+0000", comments_count: 4 });
    expect(await fetchPost(cfg, ig, "m1")).toMatchObject({ externalId: "m1", message: "New flavour", pictureUrl: "https://cdn.example/t.jpg", commentCount: 4, updatedAt: null });
    // media_url can be missing: fall back to the thumbnail, then to no picture.
    answer = () => ({ id: "m2", media_type: "IMAGE" });
    expect(await fetchPost(cfg, ig, "m2")).toMatchObject({ pictureUrl: null, message: null });
  });

  it("listRecentPosts asks the Page feed or the Instagram media edge with since and limit", async () => {
    answer = () => ({ data: [{ id: POST, message: "Hello" }, { nope: true }] });
    const since = new Date("2026-11-01T00:00:00Z");
    expect(await listRecentPosts(cfg, fb, { since, limit: 50 })).toHaveLength(1);
    await listRecentPosts(cfg, ig, { since, limit: 25 });
    const unix = Math.floor(since.getTime() / 1000);
    expect(calls[0]!.path).toBe(`${PAGE}/feed?fields=id,message,created_time,updated_time,permalink_url,full_picture&limit=50&since=${unix}`);
    expect(calls[1]!.path).toBe(
      `${IG}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count&limit=25&since=${unix}`,
    );
  });

  it("listPostComments follows the cursor (never Meta's own next link), stops at maxPages, and flattens Instagram replies", async () => {
    answer = (c) =>
      c.path.includes("after=CUR1")
        ? { data: [{ id: "c2", message: "second", created_time: "2026-11-19T10:01:00+0000", parent: { id: "c1" } }] }
        : {
            data: [{ id: "c1", message: "first", created_time: "2026-11-19T10:00:00+0000", from: { id: "U1", name: "Ada" }, is_hidden: true, like_count: 2, user_likes: true }],
            paging: { cursors: { after: "CUR1" }, next: "https://graph.facebook.com/v23.0/x?access_token=SECRET" },
          };
    const all = await listPostComments(cfg, fb, POST, { maxPages: 3 });
    expect(all.map((c) => [c.externalId, c.parentExternalId, c.hidden, c.likedByBusiness])).toEqual([
      ["c1", null, true, true],
      ["c2", "c1", null, null],
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.path).toContain(`${POST}/comments?filter=stream&order=reverse_chronological&limit=100&fields=id,message,created_time,from,parent`);
    expect(calls.every((c) => !c.path.includes("SECRET"))).toBe(true);

    calls = [];
    expect(await listPostComments(cfg, fb, POST, { maxPages: 1 })).toHaveLength(1);
    expect(calls).toHaveLength(1);

    calls = [];
    answer = () => ({
      data: [
        {
          id: "ig1",
          text: "top",
          timestamp: "2026-11-19T10:00:00+0000",
          username: "bisi_juice",
          hidden: false,
          replies: { data: [{ id: "ig2", text: "reply", timestamp: "2026-11-19T10:05:00+0000", from: { id: IG, username: "mrs_samuelfruitjuice" } }] },
        },
      ],
    });
    const igAll = await listPostComments(cfg, ig, "m1", { maxPages: 3 });
    expect(igAll.map((c) => [c.externalId, c.parentExternalId, c.authorUsername, c.authorExternalId])).toEqual([
      ["ig1", null, "bisi_juice", null],
      ["ig2", "ig1", "mrs_samuelfruitjuice", IG],
    ]);
    expect(calls[0]!.path).toContain("m1/comments?limit=50&fields=id,text,timestamp,username,from,hidden,like_count,parent_id,replies{");
  });

  it("fetchComment returns the comment with its replies; an Instagram mention goes through mentioned_comment", async () => {
    answer = () => ({ id: "c1", message: "top", created_time: T, comments: { data: [{ id: "c2", message: "r", created_time: T + 5 }] } });
    const thread = await fetchComment(cfg, fb, "c1", "comment");
    expect(thread.replies.map((r) => [r.externalId, r.parentExternalId])).toEqual([["c2", "c1"]]);
    expect(thread.repliesComplete).toBe(true);

    answer = () => ({ id: IG, mentioned_comment: { id: "c5", text: "@mrs_samuelfruitjuice lovely", timestamp: "2026-11-19T10:00:00+0000", media: { id: "m5" } } });
    const mention = await fetchComment(cfg, ig, "c5", "mention");
    expect(mention).toMatchObject({ externalId: "c5", message: "@mrs_samuelfruitjuice lovely", postExternalId: "m5" });
    expect(calls[1]!.path).toBe(`${IG}?fields=mentioned_comment.comment_id(c5){id,text,timestamp,like_count,media{id,permalink}}`);

    answer = () => ({ id: "ig1", text: "top", replies: { data: [], paging: { next: "https://graph.facebook.com/more" } } });
    expect((await fetchComment(cfg, ig, "ig1", "comment")).repliesComplete).toBe(false);
  });

  it("ensurePageSubscribed adds feed and mention to the fields already subscribed and never sends a shorter list", async () => {
    const messaging = [...PAGE_WEBHOOK_FIELDS];
    answer = (c) => (c.method === "GET" ? { data: [{ id: "OTHER", subscribed_fields: ["leadgen"] }, { id: "APP1", subscribed_fields: messaging }] } : { success: true });
    expect(await ensurePageSubscribed(cfg, fb)).toEqual({ changed: true });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe(`${PAGE}/subscribed_apps?subscribed_fields=${[...messaging, "feed", "mention"].join(",")}`);
    expect(post.auth).toBe("Bearer PAGE-TOKEN-1");
  });

  it("ensurePageSubscribed changes nothing when both fields are there, and makes no call for Instagram", async () => {
    answer = () => ({ data: [{ id: "APP1", subscribed_fields: [{ name: "messages" }, { name: "feed" }, { name: "mention" }] }] });
    expect(await ensurePageSubscribed(cfg, fb)).toEqual({ changed: false });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    calls = [];
    expect(await ensurePageSubscribed(cfg, ig)).toEqual({ changed: false });
    expect(calls).toHaveLength(0);
  });

  it("ensurePageSubscribed falls back to feed alone when Meta refuses the pair", async () => {
    answer = (c) => {
      if (c.method === "GET") return { data: [{ id: "APP1", subscribed_fields: ["messages"] }] };
      if (c.path.includes("mention")) return json({ error: { message: "(#100) Invalid field mention", code: 100 } }, 400);
      return { success: true };
    };
    expect(await ensurePageSubscribed(cfg, fb)).toEqual({ changed: true });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      `${PAGE}/subscribed_apps?subscribed_fields=messages,feed,mention`,
      `${PAGE}/subscribed_apps?subscribed_fields=messages,feed`,
    ]);
  });

  it("a permission refusal on a comment call is a configuration problem", async () => {
    answer = () => json({ error: { message: "(#200) Permissions error", code: 200 } }, 403);
    const err = await deleteRemoteComment(cfg, fb, "c1").catch((e: unknown) => e);
    expect(classifyMetaError(err)).toBe("config");
  });
});

describe("oldestFirst", () => {
  it("sorts by time and puts a parent before a reply made in the same second", () => {
    const c = (externalId: string, at: number, parent: string | null): RemoteComment => ({
      externalId,
      parentExternalId: parent,
      authorExternalId: null,
      authorName: null,
      authorUsername: null,
      message: null,
      commentedAt: new Date(at),
      hidden: null,
      likeCount: null,
      likedByBusiness: null,
      attachmentUrl: null,
    });
    expect(oldestFirst([c("r", 2000, "p"), c("late", 3000, null), c("p", 2000, null), c("first", 1000, null)]).map((x) => x.externalId)).toEqual([
      "first",
      "p",
      "r",
      "late",
    ]);
  });
});

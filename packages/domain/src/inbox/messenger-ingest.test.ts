import { describe, it, expect } from "vitest";
import { metaEventKind, metaEventTime, parseMetaMessage, type MetaEntry } from "./messenger-ingest.js";

describe("metaEventKind", () => {
  const ev = (e: object): MetaEntry => ({ id: "1", messaging: [e] });
  const cases: [string, string, MetaEntry][] = [
    ["page", "page.feed", { id: "1", changes: [{ field: "feed" }] }],
    ["instagram", "instagram.comments", { id: "1", changes: [{ field: "comments" }] }],
    ["page", "page.standby", { id: "1", standby: [{ message: { mid: "m" } }] }],
    ["page", "page.messages", ev({ message: { mid: "m", text: "hi" } })],
    ["instagram", "instagram.messages", ev({ message: { mid: "m", text: "hi" } })],
    ["page", "page.message_echoes", ev({ message: { mid: "m", is_echo: true } })],
    ["instagram", "instagram.messages", ev({ message: { mid: "m", is_echo: true } })],
    ["page", "page.message_deliveries", ev({ delivery: { watermark: 1 } })],
    ["page", "page.message_reads", ev({ read: { watermark: 1 } })],
    ["instagram", "instagram.messaging_seen", ev({ read: { mid: "m" } })],
    ["page", "page.messaging_postbacks", ev({ postback: { payload: "x" } })],
    ["instagram", "instagram.messaging_postbacks", ev({ postback: { payload: "x" } })],
    ["page", "page.messaging_referrals", ev({ referral: { source: "ADS" } })],
    ["instagram", "instagram.messaging_referral", ev({ referral: { source: "ADS" } })],
    ["page", "page.message_reactions", ev({ reaction: { mid: "m", action: "react" } })],
    ["instagram", "instagram.message_reactions", ev({ reaction: { mid: "m", action: "react" } })],
    ["page", "page.message_edits", ev({ message_edit: { mid: "m", text: "x" } })],
    ["instagram", "instagram.message_edit", ev({ message_edit: { mid: "m", text: "x" } })],
    ["page", "page.unknown", ev({ optin: {} })],
    ["page", "page.unknown", { id: "1" }],
  ];
  for (const [object, kind, entry] of cases) {
    it(`${object} → ${kind}`, () => expect(metaEventKind(object, entry)).toBe(kind));
  }
});

describe("metaEventTime", () => {
  it("event time accepts milliseconds and seconds (R3)", () => {
    const now = new Date("2026-11-19T12:00:00Z");
    expect(metaEventTime(1763553600000, now).toISOString()).toBe("2025-11-19T12:00:00.000Z");
    expect(metaEventTime(1763553600, now).toISOString()).toBe("2025-11-19T12:00:00.000Z");
    expect(metaEventTime(undefined, now)).toBe(now);
    expect(metaEventTime("1763553600", now)).toBe(now);
  });
});

describe("parseMetaMessage", () => {
  const row = (type: string, body: string | null, mediaUrl: string | null = null, idSuffix = "") => ({
    idSuffix,
    type,
    body,
    mediaUrl,
    mediaMime: null,
  });
  const att = (type: string, payload: object = {}) => ({ mid: "m1", attachments: [{ type, payload }] });

  it("is_unsupported", () => {
    expect(parseMetaMessage("instagram", { mid: "m1", is_unsupported: true })).toEqual([
      row("unsupported", "This message can't be shown here. Open the Instagram app to see it."),
    ]);
  });
  it("plain text, and a quick reply is interactive", () => {
    expect(parseMetaMessage("messenger", { mid: "m1", text: "Hello" })).toEqual([row("text", "Hello")]);
    expect(parseMetaMessage("messenger", { mid: "m1", text: "Yes", quick_reply: { payload: "Y" } })).toEqual([
      row("interactive", "Yes"),
    ]);
  });
  it("stickers (sticker type, or image with sticker_id)", () => {
    expect(parseMetaMessage("messenger", att("sticker", { url: "https://cdn/s.png" }))).toEqual([row("sticker", null, "https://cdn/s.png")]);
    expect(parseMetaMessage("messenger", att("image", { url: "https://cdn/s.png", sticker_id: 369239263222822 }))).toEqual([
      row("sticker", null, "https://cdn/s.png"),
    ]);
  });
  it("image, video, audio keep their type and link", () => {
    for (const t of ["image", "video", "audio"]) {
      expect(parseMetaMessage("instagram", att(t, { url: `https://cdn/${t}` }))).toEqual([row(t, null, `https://cdn/${t}`)]);
    }
  });
  it("file becomes document", () => {
    expect(parseMetaMessage("messenger", att("file", { url: "https://cdn/a.pdf" }))).toEqual([row("document", null, "https://cdn/a.pdf")]);
  });
  it("story_mention keeps no media link", () => {
    expect(parseMetaMessage("instagram", att("story_mention", { url: "https://cdn/story" }))).toEqual([
      row("story_mention", "Mentioned you in their story"),
    ]);
  });
  it("shares: posts, reels and stories, with the title", () => {
    expect(parseMetaMessage("instagram", att("ig_reel", { url: "u", title: "Mango time" }))).toEqual([row("share", "Shared a reel: Mango time")]);
    expect(parseMetaMessage("instagram", att("reel", { url: "u" }))).toEqual([row("share", "Shared a reel")]);
    expect(parseMetaMessage("instagram", att("ig_story", {}))).toEqual([row("share", "Shared a story")]);
    expect(parseMetaMessage("instagram", att("story", {}))).toEqual([row("share", "Shared a story")]);
    for (const t of ["share", "post", "ig_post", "media"]) {
      expect(parseMetaMessage("instagram", att(t, { url: "u" }))).toEqual([row("share", "Shared a post")]);
    }
  });
  it("fallback is text: the text, else the title, else the link", () => {
    expect(parseMetaMessage("messenger", { ...att("fallback", { url: "https://x", title: "T" }), text: "look" })).toEqual([row("text", "look")]);
    expect(parseMetaMessage("messenger", att("fallback", { url: "https://x", title: "T" }))).toEqual([row("text", "T")]);
    expect(parseMetaMessage("messenger", att("fallback", { url: "https://x" }))).toEqual([row("text", "https://x")]);
    expect(parseMetaMessage("messenger", att("fallback", {}))).toEqual([row("text", "Shared a link")]);
  });
  it("anything else is unsupported, naming the right app", () => {
    expect(parseMetaMessage("messenger", att("template", {}))).toEqual([
      row("unsupported", "This message can't be shown here. Open the Facebook app to see it."),
    ]);
    expect(parseMetaMessage("instagram", att("appointment_booking", {}))).toEqual([
      row("unsupported", "This message can't be shown here. Open the Instagram app to see it."),
    ]);
  });
  it("text with two images gives two image rows and the text once", () => {
    const rows = parseMetaMessage("messenger", {
      mid: "m1",
      text: "These two",
      attachments: [
        { type: "image", payload: { url: "https://cdn/1" } },
        { type: "image", payload: { url: "https://cdn/2" } },
      ],
    });
    expect(rows).toEqual([row("image", "These two", "https://cdn/1"), row("image", null, "https://cdn/2", "#2")]);
  });
  it("a share with text adds the text as its own last row", () => {
    const rows = parseMetaMessage("instagram", { mid: "m1", text: "see this", attachments: [{ type: "ig_post", payload: {} }] });
    expect(rows).toEqual([row("share", "Shared a post"), row("text", "see this", null, "#2")]);
  });
});

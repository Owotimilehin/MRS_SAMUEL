import { describe, expect, it } from "vitest";
import {
  SOCIAL_MEDIA_KEY_RE,
  countHashtags,
  countMentions,
  effectiveCaption,
  validatePostForNetwork,
  validateSchedule,
  type PostDraftShape,
} from "./social-post.js";

const jpeg = (width = 1080, height = 1080, bytes = 500_000) => ({ mime: "image/jpeg", bytes, width, height, durationS: null });
const mp4 = (durationS: number | null = 10) => ({ mime: "video/mp4", bytes: 5_000_000, width: 1080, height: 1920, durationS });
const post = (over: Partial<PostDraftShape> = {}): PostDraftShape => ({ kind: "photo", caption: "Hello", linkUrl: null, media: [jpeg()], ...over });
const codes = (p: PostDraftShape, network: "facebook" | "instagram", caption = p.caption) =>
  validatePostForNetwork(p, network, caption).map((x) => x.code);
const blocking = (p: PostDraftShape, network: "facebook" | "instagram", caption = p.caption) =>
  validatePostForNetwork(p, network, caption)
    .filter((x) => x.blocking)
    .map((x) => x.code);

describe("validatePostForNetwork", () => {
  it("validatePostForNetwork: text post is refused for instagram (ig_needs_media)", () => {
    const p = post({ kind: "text", media: [] });
    expect(blocking(p, "instagram")).toEqual(["ig_needs_media"]);
    expect(blocking(p, "facebook")).toEqual([]);
    expect(blocking(post({ kind: "link", media: [], linkUrl: "https://www.mrssamuel.com" }), "instagram")).toEqual(["ig_needs_media"]);
  });

  it("validatePostForNetwork: an empty text post and a link without https are refused", () => {
    expect(blocking(post({ kind: "text", media: [], caption: "" }), "facebook", "")).toEqual(["empty"]);
    expect(blocking(post({ kind: "link", media: [], linkUrl: null }), "facebook")).toEqual(["link_missing"]);
    expect(blocking(post({ kind: "link", media: [], linkUrl: "http://example.com" }), "facebook")).toEqual(["link_missing"]);
    expect(blocking(post({ kind: "link", media: [], linkUrl: "https://example.com/a" }), "facebook")).toEqual([]);
  });

  it("validatePostForNetwork: caption of 2201 characters blocks instagram, not facebook", () => {
    const caption = "a".repeat(2201);
    const p = post({ caption });
    const ig = validatePostForNetwork(p, "instagram", caption);
    expect(ig.map((x) => x.code)).toEqual(["ig_caption_long"]);
    expect(ig[0]!.message).toBe("Instagram captions can be at most 2,200 characters. This has 2201.");
    expect(blocking(p, "facebook")).toEqual([]);
    expect(blocking(post(), "instagram", "a".repeat(2200))).toEqual([]);
    expect(blocking(post(), "facebook", "a".repeat(5001))).toEqual(["fb_caption_long"]);
  });

  it("validatePostForNetwork: 31 hashtags blocks instagram", () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#juice${i}`).join(" ");
    expect(blocking(post(), "instagram", tags(31))).toEqual(["ig_hashtags"]);
    expect(blocking(post(), "instagram", tags(30))).toEqual([]);
    expect(blocking(post(), "facebook", tags(31))).toEqual([]);
  });

  it("validatePostForNetwork: 21 mentions blocks instagram", () => {
    const at = (n: number) => Array.from({ length: n }, (_, i) => `@friend${i}`).join(" ");
    expect(blocking(post(), "instagram", at(21))).toEqual(["ig_mentions"]);
    expect(blocking(post(), "instagram", at(20))).toEqual([]);
  });

  it("validatePostForNetwork: 3:5 picture gives ig_ratio; 4:5 and 1.91:1 pass", () => {
    const tall = validatePostForNetwork(post({ media: [jpeg(600, 1000)] }), "instagram", "Hello");
    expect(tall.map((x) => x.code)).toEqual(["ig_ratio"]);
    expect(tall[0]!.message).toBe("Instagram needs pictures between 4:5 (tall) and 1.91:1 (wide). Crop picture 1.");
    expect(blocking(post({ media: [jpeg(1080, 1350)] }), "instagram")).toEqual([]);
    expect(blocking(post({ media: [jpeg(1910, 1000)] }), "instagram")).toEqual([]);
    expect(blocking(post({ media: [jpeg(1920, 1000)] }), "instagram")).toEqual(["ig_ratio"]);
    expect(blocking(post({ media: [jpeg(600, 1000)] }), "facebook")).toEqual([]);
    // The second picture of an album is named by its place.
    const album = validatePostForNetwork(post({ kind: "album", media: [jpeg(), jpeg(600, 1000)] }), "instagram", "Hello");
    expect(album[0]!.message).toContain("Crop picture 2.");
  });

  it("validatePostForNetwork: album needs 2 to 10 pictures", () => {
    const album = (n: number) => post({ kind: "album", media: Array.from({ length: n }, () => jpeg()) });
    for (const network of ["facebook", "instagram"] as const) {
      expect(blocking(album(1), network)).toEqual(["media_count"]);
      expect(blocking(album(2), network)).toEqual([]);
      expect(blocking(album(10), network)).toEqual([]);
      expect(blocking(album(11), network)).toEqual(["media_count"]);
    }
    expect(blocking(post({ media: [] }), "facebook")).toEqual(["media_count"]);
    expect(blocking(post({ kind: "video", media: [mp4(), mp4()] }), "facebook")).toEqual(["media_count"]);
  });

  it("validatePostForNetwork: pictures must be JPEG and videos MP4 or MOV", () => {
    expect(blocking(post({ media: [{ ...jpeg(), mime: "image/png" }] }), "facebook")).toEqual(["media_type"]);
    expect(blocking(post({ kind: "video", media: [{ ...mp4(), mime: "video/webm" }] }), "facebook")).toEqual(["media_type"]);
    expect(blocking(post({ kind: "video", media: [{ ...mp4(), mime: "video/quicktime" }] }), "instagram")).toEqual([]);
  });

  it("validatePostForNetwork: story is refused for facebook", () => {
    const story = post({ kind: "story", caption: "" });
    expect(blocking(story, "facebook")).toEqual(["fb_story"]);
    expect(blocking(story, "instagram")).toEqual([]);
    // A caption on a story is only a warning.
    expect(validatePostForNetwork(story, "instagram", "Hi")).toEqual([
      { code: "ig_story_caption", message: "Instagram stories posted from the suite have no caption. The text will not appear.", blocking: false },
    ]);
  });

  it("validatePostForNetwork: link in instagram caption is a warning, not blocking", () => {
    const problems = validatePostForNetwork(post(), "instagram", "See https://www.mrssamuel.com");
    expect(problems).toEqual([{ code: "ig_link_in_caption", message: "Links in an Instagram caption cannot be tapped.", blocking: false }]);
    expect(codes(post(), "facebook", "See https://www.mrssamuel.com")).toEqual([]);
  });

  it("validatePostForNetwork: picture and video size rules", () => {
    expect(blocking(post({ media: [jpeg(1080, 1080, 9 * 1024 * 1024)] }), "instagram")).toEqual(["ig_photo_big"]);
    expect(blocking(post({ media: [jpeg(1080, 1080, 9 * 1024 * 1024)] }), "facebook")).toEqual([]);
    expect(blocking(post({ media: [jpeg(1080, 1080, 11 * 1024 * 1024)] }), "facebook")).toEqual(["fb_photo_big"]);
    expect(blocking(post({ media: [jpeg(300, 300)] }), "instagram")).toEqual(["ig_narrow"]);
    expect(blocking(post({ kind: "video", media: [mp4(2)] }), "instagram")).toEqual(["ig_video_length"]);
    expect(blocking(post({ kind: "video", media: [mp4(901)] }), "instagram")).toEqual(["ig_video_length"]);
    expect(blocking(post({ kind: "video", media: [mp4(900)] }), "instagram")).toEqual([]);
    expect(blocking(post({ kind: "story", caption: "", media: [mp4(61)] }), "instagram", "")).toEqual(["ig_video_length"]);
    expect(blocking(post({ kind: "video", media: [mp4(2)] }), "facebook")).toEqual([]);
  });
});

describe("validateSchedule", () => {
  it("validateSchedule: 9 minutes ahead is too_soon, 91 days is too_far", () => {
    const now = new Date("2026-11-20T08:00:00.000Z");
    const at = (ms: number) => validateSchedule(new Date(now.getTime() + ms), now).map((p) => p.code);
    expect(at(9 * 60_000)).toEqual(["too_soon"]);
    expect(at(10 * 60_000)).toEqual([]);
    expect(at(90 * 86_400_000)).toEqual([]);
    expect(at(91 * 86_400_000)).toEqual(["too_far"]);
    expect(at(-60_000)).toEqual(["too_soon"]);
    expect(validateSchedule(new Date("nonsense"), now).map((p) => p.code)).toEqual(["too_soon"]);
  });
});

describe("captions", () => {
  it("effectiveCaption: empty-string override wins over base", () => {
    expect(effectiveCaption("Base text", "")).toBe("");
    expect(effectiveCaption("Base text", null)).toBe("Base text");
    expect(effectiveCaption("Base text", undefined)).toBe("Base text");
    expect(effectiveCaption("  Base text \n", " Other ")).toBe("Other");
  });

  it("countHashtags / countMentions: ignore # and @ inside words and emails", () => {
    expect(countHashtags("#fresh juice #Lagos2026 and c#sharp, a#b")).toBe(2);
    expect(countHashtags("line one\n#two")).toBe(1);
    expect(countHashtags("# alone")).toBe(0);
    expect(countMentions("@mrs_samuel says hi to hello@mrssamuel.com and @ada.b")).toBe(2);
    expect(countMentions("mail me: a@b.com")).toBe(0);
  });

  it("the media key pattern takes only our own post files", () => {
    expect(SOCIAL_MEDIA_KEY_RE.test("social/posts/2026/11/0b0e5f1c-1a2b-4c3d-8e9f-001122334455.jpg")).toBe(true);
    expect(SOCIAL_MEDIA_KEY_RE.test("social/posts/2026/11/0b0e5f1c-1a2b-4c3d-8e9f-001122334455.mov")).toBe(true);
    expect(SOCIAL_MEDIA_KEY_RE.test("inbox/outgoing/2026/11/0b0e5f1c-1a2b-4c3d-8e9f-001122334455.jpg")).toBe(false);
    expect(SOCIAL_MEDIA_KEY_RE.test("social/posts/2026/11/../../secret.jpg")).toBe(false);
    expect(SOCIAL_MEDIA_KEY_RE.test("social/posts/2026/11/0b0e5f1c-1a2b-4c3d-8e9f-001122334455.png")).toBe(false);
  });
});

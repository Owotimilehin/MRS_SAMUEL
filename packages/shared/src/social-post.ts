/**
 * Publishing posts to Facebook and Instagram (suite spec 09, section 5.4): the types and
 * the pure rules shared by the API, the worker and the composer. No network, no database.
 */

export type SocialNetwork = "facebook" | "instagram";
export const SOCIAL_NETWORKS = ["facebook", "instagram"] as const;

export type SocialPostKind = "text" | "link" | "photo" | "album" | "video" | "story";
export const SOCIAL_POST_KINDS = ["text", "link", "photo", "album", "video", "story"] as const;

export type SocialPostStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "published"
  | "partly_published"
  | "failed"
  | "needs_check"
  | "missed";
export const SOCIAL_POST_STATUSES = [
  "draft",
  "scheduled",
  "publishing",
  "published",
  "partly_published",
  "failed",
  "needs_check",
  "missed",
] as const;

export type SocialTargetStatus = "pending" | "publishing" | "published" | "failed" | "unknown" | "removed";

/** The R2 key of a post's picture or video. Enforced everywhere a key is accepted. */
export const SOCIAL_MEDIA_KEY_RE = /^social\/posts\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(jpg|jpeg|mp4|mov)$/;

export const SOCIAL_LIMITS = {
  facebookCaption: 5000,
  instagramCaption: 2200,
  instagramHashtags: 30,
  instagramMentions: 20,
  facebookPhotoBytes: 10 * 1024 * 1024,
  instagramPhotoBytes: 8 * 1024 * 1024,
  albumMin: 2,
  albumMax: 10,
  instagramMinWidth: 320,
  videoMinSeconds: 3,
  reelMaxSeconds: 900,
  storyMaxSeconds: 60,
  scheduleMinMinutes: 10,
  scheduleMaxDays: 90,
} as const;

export interface PostDraftShape {
  kind: SocialPostKind;
  caption: string;
  linkUrl: string | null;
  media: { mime: string; bytes: number; width: number; height: number; durationS: number | null }[];
}

export interface PostProblem {
  code: string;
  message: string;
  blocking: boolean;
}

/** The text one network gets: the override if it is a string (even ""), else the base. Trimmed. */
export function effectiveCaption(base: string, override: string | null | undefined): string {
  return (typeof override === "string" ? override : base).trim();
}

export function countHashtags(text: string): number {
  return text.match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

export function countMentions(text: string): number {
  return text.match(/(^|\s)@[A-Za-z0-9._]+/g)?.length ?? 0;
}

const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime"]);
const isPicture = (mime: string): boolean => mime.startsWith("image/");

function isHttpsUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Every problem one network has with this post. `caption` is the text that network gets (effectiveCaption). */
export function validatePostForNetwork(post: PostDraftShape, network: SocialNetwork, caption: string): PostProblem[] {
  const out: PostProblem[] = [];
  const block = (code: string, message: string): void => void out.push({ code, message, blocking: true });
  const warn = (code: string, message: string): void => void out.push({ code, message, blocking: false });
  const { kind, media } = post;
  const n = media.length;

  if (kind === "text" && caption === "") block("empty", "Write something to post.");

  if (kind === "photo" && n !== 1) block("media_count", "A photo post needs one picture.");
  if (kind === "video" && n !== 1) block("media_count", "A video post needs one video.");
  if (kind === "story" && n !== 1) block("media_count", "A story needs one picture or one video.");
  if (kind === "album" && (n < SOCIAL_LIMITS.albumMin || n > SOCIAL_LIMITS.albumMax)) {
    block("media_count", "An album needs 2 to 10 pictures.");
  }
  if ((kind === "text" || kind === "link") && n !== 0) {
    block("media_count", kind === "text" ? "A text post has no pictures or videos." : "A link post has no pictures or videos.");
  }

  if ((kind === "photo" || kind === "album") && media.some((m) => m.mime !== "image/jpeg")) {
    block("media_type", "Pictures must be JPEG.");
  }
  if (kind === "video" && media.some((m) => !VIDEO_TYPES.has(m.mime))) block("media_type", "Videos must be MP4 or MOV.");
  if (kind === "story") {
    for (const m of media) {
      if (isPicture(m.mime) && m.mime !== "image/jpeg") block("media_type", "Pictures must be JPEG.");
      else if (!isPicture(m.mime) && !VIDEO_TYPES.has(m.mime)) block("media_type", "Videos must be MP4 or MOV.");
    }
  }

  if (network === "facebook") {
    if (kind === "link" && !isHttpsUrl(post.linkUrl)) block("link_missing", "Add the full web address, starting with https://.");
    if (caption.length > SOCIAL_LIMITS.facebookCaption) {
      block("fb_caption_long", `Facebook text is limited to 5,000 characters here. This has ${caption.length}.`);
    }
    if (kind === "story") block("fb_story", "Stories can only be posted to Instagram from the suite.");
    if ((kind === "photo" || kind === "album") && media.some((m) => m.bytes > SOCIAL_LIMITS.facebookPhotoBytes)) {
      block("fb_photo_big", "Facebook pictures can be at most 10 MB.");
    }
    return out;
  }

  // Instagram
  if (kind === "text" || kind === "link") block("ig_needs_media", "Instagram posts need a picture or a video.");
  if (caption.length > SOCIAL_LIMITS.instagramCaption) {
    block("ig_caption_long", `Instagram captions can be at most 2,200 characters. This has ${caption.length}.`);
  }
  const hashtags = countHashtags(caption);
  if (hashtags > SOCIAL_LIMITS.instagramHashtags) block("ig_hashtags", `Instagram allows at most 30 hashtags. This has ${hashtags}.`);
  const mentions = countMentions(caption);
  if (mentions > SOCIAL_LIMITS.instagramMentions) block("ig_mentions", `Instagram allows at most 20 @mentions. This has ${mentions}.`);

  const pictures = kind === "photo" || kind === "album" || kind === "story" ? media.filter((m) => isPicture(m.mime)) : [];
  if (pictures.some((m) => m.bytes > SOCIAL_LIMITS.instagramPhotoBytes)) block("ig_photo_big", "Instagram pictures can be at most 8 MB.");
  media.forEach((m, i) => {
    if (!isPicture(m.mime)) return;
    if (kind === "photo" || kind === "album") {
      // Whole-number comparison so 4:5 and 1.91:1 themselves always pass.
      if (m.width * 5 < m.height * 4 || m.width * 100 > m.height * 191) {
        block("ig_ratio", `Instagram needs pictures between 4:5 (tall) and 1.91:1 (wide). Crop picture ${i + 1}.`);
      }
    }
    if ((kind === "photo" || kind === "album" || kind === "story") && m.width < SOCIAL_LIMITS.instagramMinWidth) {
      block("ig_narrow", `Picture ${i + 1} is too small for Instagram (at least 320 pixels wide).`);
    }
  });
  for (const m of media) {
    if (isPicture(m.mime) || m.durationS === null) continue;
    if (kind === "video" && (m.durationS < SOCIAL_LIMITS.videoMinSeconds || m.durationS > SOCIAL_LIMITS.reelMaxSeconds)) {
      block("ig_video_length", "Instagram videos must be between 3 seconds and 15 minutes.");
    }
    if (kind === "story" && (m.durationS < SOCIAL_LIMITS.videoMinSeconds || m.durationS > SOCIAL_LIMITS.storyMaxSeconds)) {
      block("ig_video_length", "Story videos must be between 3 and 60 seconds.");
    }
  }
  if (kind === "story") {
    if (caption !== "") warn("ig_story_caption", "Instagram stories posted from the suite have no caption. The text will not appear.");
  } else if (/https?:\/\//i.test(caption)) {
    warn("ig_link_in_caption", "Links in an Instagram caption cannot be tapped.");
  }
  return out;
}

/** A scheduled time must be 10 minutes to 90 days ahead. */
export function validateSchedule(scheduledAt: Date, now: Date): PostProblem[] {
  const ahead = scheduledAt.getTime() - now.getTime();
  if (!Number.isFinite(ahead) || ahead < SOCIAL_LIMITS.scheduleMinMinutes * 60_000) {
    return [{ code: "too_soon", message: "Pick a time at least 10 minutes from now.", blocking: true }];
  }
  if (ahead > SOCIAL_LIMITS.scheduleMaxDays * 86_400_000) {
    return [{ code: "too_far", message: "Pick a time within the next 90 days.", blocking: true }];
  }
  return [];
}

/** The network a channel account of this kind posts to, or null for a phone line. */
export function networkForAccountKind(kind: string): SocialNetwork | null {
  if (kind === "messenger") return "facebook";
  if (kind === "instagram") return "instagram";
  return null;
}

export function networkName(network: SocialNetwork | string): string {
  return network === "instagram" ? "Instagram" : "Facebook";
}

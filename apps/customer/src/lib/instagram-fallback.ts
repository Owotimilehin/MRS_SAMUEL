/**
 * Shown in the home page Instagram block when the live feed is empty
 * (API down, or the IG_ACCESS_TOKEN has expired).
 *
 * Only OUR OWN posts go here (creators' reels live in lib/press.ts).
 * `image` is optional: drop the photo into
 * apps/customer/public/media/instagram/ and set e.g. "/media/instagram/1.jpg".
 * Without an image the post renders as a branded "reel" tile with its caption.
 */
export interface FallbackPost {
  url: string;
  caption: string;
  image?: string;
  isVideo?: boolean;
}

export const INSTAGRAM_FALLBACK: FallbackPost[] = [
  {
    url: "https://www.instagram.com/reel/DbRSDhwsWUK/",
    caption: "We only make big bottles. Lagos's best fresh fruit juice, no small talk.",
    isVideo: true,
  },
  {
    url: "https://www.instagram.com/reel/DZ4i_QeMj7M/",
    caption: "Come to the store and you might be served by @_egungun himself. Fresh juice, pressed in Ajao Estate.",
    isVideo: true,
  },
];

export const INSTAGRAM_PROFILE = "https://www.instagram.com/mrs_samuelfruitjuice/";

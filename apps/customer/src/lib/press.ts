/**
 * Creators and press who have featured Mrs. Samuel. Rendered on the home
 * page as server-side text + links (crawlable, unlike Instagram embeds).
 *
 * Rules: link to the public post (no share-tracking query params like
 * ?srtk= / ?xtok=), describe it in our own neutral words — never invent a
 * quote — and only list third parties (not our own reels).
 * When a creator also writes about us on a website/blog/YouTube, add that
 * URL too: those are the links that count for Google.
 */
export interface Feature {
  name: string;
  handle: string;
  url: string;
  /** Our one-line description of the feature. */
  blurb: string;
}

export const FEATURES: Feature[] = [
  {
    name: "Cook with Mimii",
    handle: "cookwith_mimii",
    url: "https://www.instagram.com/reel/DcVbJdTo_bo/",
    blurb: "A Lagos food and lifestyle creator's pick for natural fruit juice, in a joint post with us.",
  },
  {
    name: "JayTee",
    handle: "jaytee.thecreator",
    url: "https://www.instagram.com/reel/Dfj6WpOsf08/",
    blurb: "Swapped soda for fresh juice on a fitness journey and gave us an honest review.",
  },
  {
    name: "Julie",
    handle: "julie_adaugo",
    url: "https://www.instagram.com/reel/DZaJVGVAwSm/",
    blurb: "Featured Mrs. Samuel fresh juice delivery in Lagos for her followers.",
  },
  {
    name: "Ekene",
    handle: "ekene.effects",
    url: "https://www.instagram.com/reel/DZFleV3ogSn/",
    blurb: "Showcased our range of 100% fresh juice flavours.",
  },
];

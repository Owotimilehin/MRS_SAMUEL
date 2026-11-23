// apps/customer/src/lib/media.ts
//
// Fast images (SEO roadmap F8). The API hands out bottle pictures as
// `/media/bottles/<name>.png`: ~1 MB, 896×1200 PNGs. Those PNGs stay in
// public/media because the database, the admin app and the Meta catalogue all
// point at them. Next to each one sits a resized WebP twin (600×804, ~25 KB),
// and the storefront shows the twin instead.

/** Files in public/media that have a `.webp` twin. media.test.ts keeps this in step with the folder. */
export const WEBP_TWINS: ReadonlySet<string> = new Set([
  "bottles/bottle-avocado",
  "bottles/bottle-banana",
  "bottles/bottle-beet",
  "bottles/bottle-blueberry",
  "bottles/bottle-coral",
  "bottles/bottle-cream-pink",
  "bottles/bottle-cucumber",
  "bottles/bottle-dragonfruit",
  "bottles/bottle-golden",
  "bottles/bottle-green",
  "bottles/bottle-hibiscus",
  "bottles/bottle-mint",
  "bottles/bottle-passion",
  "bottles/bottle-pink",
  "bottles/bottle-ruby",
  "bottles/bottle-soursop",
  "bottles/bottle-sunrise",
  "bottles/bottle-tigernut",
  "bottles/bottle-turmeric",
  "bottles/bottle-watermelon",
  "bottles/bottle-yellow",
  "decor/cluster-berry",
  "decor/cluster-citrus",
  "decor/cluster-green",
  "decor/cluster-root",
  "decor/cluster-tropical",
  "decor/cluster-watermelon",
  "decor/fruit-beet-root",
  "decor/fruit-berry-mix",
  "decor/fruit-creamy",
  "decor/fruit-ginger",
  "decor/fruit-kiwi",
  "decor/fruit-mango",
  "decor/fruit-orange-slice",
  "decor/fruit-pineapple",
  "decor/fruit-watermelon-slice",
  "decor/leaf-mint",
  "decor/splash-burst",
  "decor/splash-green",
  "decor/splash-orange",
  "decor/splash-red",
]);

const MEDIA_PNG =
  /^(?:https:\/\/(?:www\.)?mrssamuel\.com)?\/media\/((?:bottles|decor)\/[a-z0-9-]+)\.png$/;

/**
 * The URL to put in an `<img src>` for a product or decor picture: the WebP
 * twin when there is one, otherwise the URL unchanged (uploads, CDNs, tests).
 */
export function webpSrc(url: string): string {
  const m = MEDIA_PNG.exec(url);
  return m && WEBP_TWINS.has(m[1]) ? `/media/${m[1]}.webp` : url;
}

/** Intrinsic sizes of the WebP files, for `width`/`height` on `<img>` (stops layout shift). */
export const IMG_SIZE = {
  bottle: { width: 600, height: 804 },
  cluster: { width: 800, height: 800 },
  fruit: { width: 480, height: 480 },
  leaf: { width: 600, height: 600 },
  splash: { width: 960, height: 768 },
  logo: { width: 480, height: 229 },
} as const;

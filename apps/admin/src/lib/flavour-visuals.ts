// Flavour → bottle / fruit / splash / palette resolution for the admin "Juice
// Skin". Mirrors the customer storefront's visual vocabulary (see
// apps/customer/src/lib/visuals.ts) but reads from the assets copied into
// apps/admin/public/flavours so the admin can render them without cross-app
// imports.
//
// Priority when a product is shown:
//   1. the product's ASSIGNED bottle image (API image_url / media asset URL)
//   2. a per-slug mapping (below)
//   3. a deterministic fallback derived from the slug hash
// Palette likewise prefers the product's own `palette`, then the slug default.

const BASE = "/flavours";
const bottle = (n: string): string => `${BASE}/bottle-${n}.png`;
const fruit = (n: string): string => `${BASE}/decor/fruit-${n}.png`;
const splash = (n: string): string => `${BASE}/decor/splash-${n}.png`;

export interface Palette {
  surface: string;
  accent: string;
}

export interface FlavourVisual {
  /** Bottle image URL to render (assigned or mapped). */
  bottle: string;
  /** Small fruit accent image URL. */
  fruit: string;
  /** Decorative splash image URL behind the bottle. */
  splash: string;
  /** Soft tint behind the bottle. */
  surface: string;
  /** Brand accent for tags/edges. */
  accent: string;
}

const SPLASH_ORANGE = splash("orange");
const SPLASH_GREEN = splash("green");
const SPLASH_RED = splash("red");

export const DEFAULT_VISUAL: FlavourVisual = {
  bottle: bottle("sunrise"),
  fruit: fruit("orange-slice"),
  splash: SPLASH_ORANGE,
  surface: "#fdecd2",
  accent: "#e85d1c",
};

// Known flavour slugs → full visual. Slugs match the storefront catalogue.
const SLUG_VISUAL: Record<string, FlavourVisual> = {
  sunrise: { bottle: bottle("sunrise"), fruit: fruit("orange-slice"), splash: SPLASH_ORANGE, surface: "#fdecd2", accent: "#e85d1c" },
  "zesty-sunrise": { bottle: bottle("sunrise"), fruit: fruit("orange-slice"), splash: SPLASH_ORANGE, surface: "#fdecd2", accent: "#e85d1c" },
  orange: { bottle: bottle("sunrise"), fruit: fruit("orange-slice"), splash: SPLASH_ORANGE, surface: "#fde4c4", accent: "#e8731c" },
  "lemon-sip": { bottle: bottle("yellow"), fruit: fruit("ginger"), splash: SPLASH_ORANGE, surface: "#fdf3c8", accent: "#caa23a" },
  "crimson-garden": { bottle: bottle("beet"), fruit: fruit("beet-root"), splash: SPLASH_RED, surface: "#f7dada", accent: "#b3204a" },
  "veggie-burst": { bottle: bottle("beet"), fruit: fruit("beet-root"), splash: SPLASH_RED, surface: "#f6dcd9", accent: "#b3354a" },
  "crimson-elixir": { bottle: bottle("watermelon"), fruit: fruit("watermelon-slice"), splash: SPLASH_RED, surface: "#fbe0e3", accent: "#e8536a" },
  "crimson-cooler": { bottle: bottle("watermelon"), fruit: fruit("watermelon-slice"), splash: SPLASH_RED, surface: "#fbe0e3", accent: "#e8536a" },
  "watermelon-cooler": { bottle: bottle("watermelon"), fruit: fruit("watermelon-slice"), splash: SPLASH_RED, surface: "#fbe0e3", accent: "#e8536a" },
  melongrape: { bottle: bottle("watermelon"), fruit: fruit("watermelon-slice"), splash: SPLASH_RED, surface: "#f6dde6", accent: "#c0286a" },
  "sweet-pepper-splash": { bottle: bottle("ruby"), fruit: fruit("watermelon-slice"), splash: SPLASH_RED, surface: "#fbdfe0", accent: "#c0392b" },
  "tropical-mango": { bottle: bottle("golden"), fruit: fruit("mango"), splash: SPLASH_ORANGE, surface: "#fce8c8", accent: "#f59e0b" },
  "nourish-blend": { bottle: bottle("golden"), fruit: fruit("mango"), splash: SPLASH_ORANGE, surface: "#fce8c8", accent: "#e8951c" },
  pineapple: { bottle: bottle("yellow"), fruit: fruit("pineapple"), splash: SPLASH_ORANGE, surface: "#fdf0c2", accent: "#d9a404" },
  pinecado: { bottle: bottle("avocado"), fruit: fruit("creamy"), splash: SPLASH_GREEN, surface: "#e8f0d8", accent: "#6aa023" },
  "creamy-paradise": { bottle: bottle("cream-pink"), fruit: fruit("creamy"), splash: SPLASH_RED, surface: "#fbe6ea", accent: "#d27a90" },
  "pure-green": { bottle: bottle("green"), fruit: fruit("kiwi"), splash: SPLASH_GREEN, surface: "#dcefd9", accent: "#2f9e44" },
  "ginger-spark": { bottle: bottle("turmeric"), fruit: fruit("ginger"), splash: SPLASH_ORANGE, surface: "#fdeec2", accent: "#d98a04" },
  "ginger-mint-splash": { bottle: bottle("mint"), fruit: fruit("kiwi"), splash: SPLASH_GREEN, surface: "#dbefe4", accent: "#1f9e74" },
  "vitamin-vibe": { bottle: bottle("turmeric"), fruit: fruit("ginger"), splash: SPLASH_ORANGE, surface: "#fdeec2", accent: "#d98a04" },
  guyabano: { bottle: bottle("soursop"), fruit: fruit("berry-mix"), splash: SPLASH_GREEN, surface: "#e9f2e0", accent: "#7aa23a" },
  "berry-bliss": { bottle: bottle("blueberry"), fruit: fruit("berry-mix"), splash: SPLASH_RED, surface: "#e3def2", accent: "#6b4ea8" },
  hibiscus: { bottle: bottle("hibiscus"), fruit: fruit("berry-mix"), splash: SPLASH_RED, surface: "#f7d7e1", accent: "#c0286a" },
  "hibiscus-chill": { bottle: bottle("hibiscus"), fruit: fruit("berry-mix"), splash: SPLASH_RED, surface: "#f7d7e1", accent: "#c0286a" },
  tigernut: { bottle: bottle("tigernut"), fruit: fruit("creamy"), splash: SPLASH_ORANGE, surface: "#fff1cf", accent: "#caa23a" },
  "tiger-nut-cream": { bottle: bottle("tigernut"), fruit: fruit("creamy"), splash: SPLASH_ORANGE, surface: "#fff1cf", accent: "#caa23a" },
  banana: { bottle: bottle("banana"), fruit: fruit("creamy"), splash: SPLASH_ORANGE, surface: "#fdf2c4", accent: "#d6a528" },
  dragonfruit: { bottle: bottle("dragonfruit"), fruit: fruit("berry-mix"), splash: SPLASH_RED, surface: "#fbdce8", accent: "#d62f7a" },
  passion: { bottle: bottle("passion"), fruit: fruit("mango"), splash: SPLASH_ORANGE, surface: "#fde7c6", accent: "#e07a1c" },
  cucumber: { bottle: bottle("cucumber"), fruit: fruit("kiwi"), splash: SPLASH_GREEN, surface: "#e0f0df", accent: "#3a9e6a" },
};

// Bottles to cycle through for unknown slugs, so even an unmapped flavour gets a
// stable, on-brand bottle instead of the same default every time.
const FALLBACK_BOTTLES = [
  "sunrise", "golden", "green", "watermelon", "beet", "blueberry",
  "mint", "ruby", "coral", "turmeric", "pink", "avocado",
];
const FALLBACK_FRUITS = ["orange-slice", "mango", "kiwi", "watermelon-slice", "beet-root", "berry-mix"];
const FALLBACK_SURFACES = ["#fdecd2", "#fce8c8", "#dcefd9", "#fbe0e3", "#f7dada", "#e3def2"];
const FALLBACK_ACCENTS = ["#e85d1c", "#f59e0b", "#2f9e44", "#e8536a", "#b3204a", "#6b4ea8"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function fallbackForSlug(slug: string): FlavourVisual {
  const h = hash(slug || "flavour");
  const i = h % FALLBACK_BOTTLES.length;
  return {
    bottle: bottle(FALLBACK_BOTTLES[i]!),
    fruit: fruit(FALLBACK_FRUITS[h % FALLBACK_FRUITS.length]!),
    splash: [SPLASH_ORANGE, SPLASH_GREEN, SPLASH_RED][h % 3]!,
    surface: FALLBACK_SURFACES[i % FALLBACK_SURFACES.length]!,
    accent: FALLBACK_ACCENTS[i % FALLBACK_ACCENTS.length]!,
  };
}

export interface ProductLike {
  slug?: string | null | undefined;
  /** Assigned bottle / hero image from the API, if any. */
  imageUrl?: string | null | undefined;
  image_url?: string | null | undefined;
  palette?: Palette | { surface: string; accent: string } | null | undefined;
}

/**
 * Resolve the full visual for a product. Prefers the product's assigned bottle
 * image and its own palette, falling back to the slug mapping, then a
 * deterministic slug-hash fallback.
 */
export function getFlavourVisual(p: ProductLike): FlavourVisual {
  const slug = (p.slug ?? "").toLowerCase();
  const base = SLUG_VISUAL[slug] ?? fallbackForSlug(slug);
  const assigned = p.imageUrl ?? p.image_url ?? null;
  return {
    ...base,
    bottle: assigned || base.bottle,
    surface: p.palette?.surface || base.surface,
    accent: p.palette?.accent || base.accent,
  };
}

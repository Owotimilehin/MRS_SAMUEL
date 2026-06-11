// apps/customer/src/lib/visuals.ts
import bottleSunrise from "@/assets/bottle-sunrise.png";
import bottlePink from "@/assets/bottle-pink.png";
import bottleWatermelon from "@/assets/bottle-watermelon.png";
import bottleGreen from "@/assets/bottle-green.png";
import bottleYellow from "@/assets/bottle-yellow.png";
import bottleBeet from "@/assets/bottle-beet.png";
import bottleGolden from "@/assets/bottle-golden.png";
import bottleBanana from "@/assets/bottle-banana.png";
import bottleMint from "@/assets/bottle-mint.png";
import bottleAvocado from "@/assets/bottle-avocado.png";
import bottleRuby from "@/assets/bottle-ruby.png";
import bottleCreamPink from "@/assets/bottle-cream-pink.png";
import bottleCoral from "@/assets/bottle-coral.png";

import clusterCitrus from "@/assets/decor/cluster-citrus.png";
import clusterBerry from "@/assets/decor/cluster-berry.png";
import clusterTropical from "@/assets/decor/cluster-tropical.png";
import clusterGreen from "@/assets/decor/cluster-green.png";
import clusterRoot from "@/assets/decor/cluster-root.png";
import clusterWatermelon from "@/assets/decor/cluster-watermelon.png";

import fruitMango from "@/assets/decor/fruit-mango.png";
import fruitPineapple from "@/assets/decor/fruit-pineapple.png";
import fruitBerryMix from "@/assets/decor/fruit-berry-mix.png";
import fruitKiwi from "@/assets/decor/fruit-kiwi.png";
import fruitGinger from "@/assets/decor/fruit-ginger.png";
import fruitWatermelonSlice from "@/assets/decor/fruit-watermelon-slice.png";
import fruitCreamy from "@/assets/decor/fruit-creamy.png";
import fruitBeetRoot from "@/assets/decor/fruit-beet-root.png";
import fruitOrangeSlice from "@/assets/decor/fruit-orange-slice.png";

export type Size = "330ml" | "650ml";
export type Cluster = "citrus" | "berry" | "tropical" | "green" | "root" | "watermelon";

export const CLUSTERS: Record<Cluster, string> = {
  citrus: clusterCitrus,
  berry: clusterBerry,
  tropical: clusterTropical,
  green: clusterGreen,
  root: clusterRoot,
  watermelon: clusterWatermelon,
};

// Default bottle image used when the API has no media URL yet (dev fallback).
export const DEFAULT_BOTTLE = bottleSunrise;
// Keep the remaining bottle imports referenced so tree-shaking keeps the assets
// available for any future slug→bottle mapping; harmless no-op export.
export const BOTTLES = {
  bottleSunrise, bottlePink, bottleWatermelon, bottleGreen, bottleYellow,
  bottleBeet, bottleGolden, bottleBanana, bottleMint, bottleAvocado,
  bottleRuby, bottleCreamPink, bottleCoral,
};

export const PRODUCT_FRUITS: Record<string, string> = {
  sunrise: fruitOrangeSlice,
  "crimson-garden": fruitBeetRoot,
  "crimson-elixir": fruitWatermelonSlice,
  "crimson-cooler": fruitWatermelonSlice,
  "ginger-spark": fruitGinger,
  orange: fruitOrangeSlice,
  pineapple: fruitPineapple,
  pinecado: fruitCreamy,
  guyabano: fruitBerryMix,
  "vitamin-vibe": fruitGinger,
  "ginger-mint-splash": fruitKiwi,
  "zesty-sunrise": fruitOrangeSlice,
  "veggie-burst": fruitBeetRoot,
  "lemon-sip": fruitGinger,
  "sweet-pepper-splash": fruitWatermelonSlice,
  melongrape: fruitWatermelonSlice,
  "creamy-paradise": fruitCreamy,
  "nourish-blend": fruitMango,
  "tropical-mango": fruitMango,
  "pure-green": fruitKiwi,
};

// Slug → cluster, so the API (which doesn't store cluster) can still get the
// right decoration. Falls back to "tropical".
const SLUG_CLUSTER: Record<string, Cluster> = {
  sunrise: "citrus", orange: "citrus", "zesty-sunrise": "citrus", "lemon-sip": "citrus",
  "crimson-garden": "root", "veggie-burst": "root",
  "crimson-elixir": "watermelon", "crimson-cooler": "watermelon",
  "sweet-pepper-splash": "watermelon", melongrape: "watermelon",
  guyabano: "berry",
  pineapple: "tropical", pinecado: "tropical", "tropical-mango": "tropical",
  "nourish-blend": "tropical", "creamy-paradise": "tropical",
  "ginger-spark": "green", "vitamin-vibe": "green", "ginger-mint-splash": "green",
  "pure-green": "green",
};

export const clusterForSlug = (slug: string): Cluster => SLUG_CLUSTER[slug] ?? "tropical";
export const getFruitFor = (slug: string, cluster: Cluster): string =>
  PRODUCT_FRUITS[slug] ?? CLUSTERS[cluster];

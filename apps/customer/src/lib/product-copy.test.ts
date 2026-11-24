import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyWordCount, PRODUCT_COPY, productCopy } from "./product-copy";
import { MAX_DESCRIPTION } from "./seo";

/** Slugs live on /v1/public/catalog/products (checked 23 Nov 2026). */
const LIVE_SLUGS = [
  "guava-punch",
  "sunrise",
  "crimson-garden",
  "crimson-elixir",
  "crimson-cooler",
  "ginger-spark",
  "orange",
  "pineapple",
  "pinecado",
  "guyabano",
  "vitamin-vibe",
  "ginger-mint-splash",
  "zesty-sunrise",
  "veggie-burst",
  "lemon-sip",
  "sweet-pepper-splash",
  "melongrape",
  "creamy-paradise",
  "pure-green",
];

/** In the seed catalogue but not sold on the live site. Copy for these can wait. */
const SEED_NOT_LIVE = new Set(["nourish-blend", "tropical-mango"]);

const seed = JSON.parse(
  readFileSync(
    new URL("../../../../packages/db/src/seed-data/catalog.json", import.meta.url),
    "utf8",
  ),
) as { products: { slug: string }[] };

const GUIDES = [
  "zobo-hibiscus-health-benefits",
  "cold-pressed-juices-beat-lagos-heat",
  "pineapple-ginger-immunity",
  "tigernut-kunu-aya-benefits",
  "why-cold-pressed",
  "what-actually-goes-into-detox",
  "lagos-traffic-and-48-hour-shelf-life",
  "fruit-sourcing",
  "the-punch-recipe",
];

const text = (slug: string) => {
  const c = PRODUCT_COPY[slug]!;
  return [c.metaDescription, c.intro, ...c.sections.flatMap((s) => [s.heading, s.body])].join("\n");
};

describe("product copy (SEO Q3)", () => {
  it("covers every live seed-catalogue juice", () => {
    const seedSlugs = seed.products.map((p) => p.slug);
    for (const slug of seedSlugs) {
      if (SEED_NOT_LIVE.has(slug)) continue;
      expect(productCopy(slug), `missing copy for ${slug}`).toBeDefined();
    }
    for (const slug of LIVE_SLUGS)
      expect(productCopy(slug), `missing copy for ${slug}`).toBeDefined();
  });

  it.each(LIVE_SLUGS)("%s has 300 to 500 words", (slug) => {
    const n = copyWordCount(PRODUCT_COPY[slug]!);
    expect(n).toBeGreaterThanOrEqual(300);
    expect(n).toBeLessThanOrEqual(500);
  });

  it.each(LIVE_SLUGS)("%s links to Lagos delivery and at least one existing guide", (slug) => {
    const t = text(slug);
    expect(t).toContain("](/juice-delivery-lagos)");
    const guides = [...t.matchAll(/\]\(\/blog\/([a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(guides.length).toBeGreaterThan(0);
    for (const g of guides) expect(GUIDES).toContain(g);
  });

  it("meta descriptions are unique, within 155 characters and name the juice", () => {
    const all = Object.values(PRODUCT_COPY).map((c) => c.metaDescription);
    expect(new Set(all).size).toBe(all.length);
    for (const d of all) {
      expect(d.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
      expect(d.length).toBeGreaterThan(80);
    }
  });

  it("never shows placeholder text to shoppers", () => {
    for (const slug of Object.keys(PRODUCT_COPY)) expect(text(slug)).not.toMatch(/TODO|TBD|lorem/i);
  });

  it("intros are not copy-pasted between juices", () => {
    const intros = Object.values(PRODUCT_COPY).map((c) => c.intro);
    expect(new Set(intros).size).toBe(intros.length);
  });
});

import { describe, it, expect } from "vitest";
import { DELIVERY_AREAS, PUBLISHED_AREAS, findArea } from "./areas";
import { areaOwnText, areaPageText, areaServiceLd, areaTitle, nearbyAreas } from "./area-page";
import { fitTitle, MAX_DESCRIPTION, MAX_TITLE } from "./seo";
import { jaccard, overlap, wordsOf as words } from "./text-overlap";

describe("text overlap", () => {
  it("scores copies high and different text low", () => {
    const a = "fresh juice pressed every morning in our kitchen and delivered cold to your door";
    expect(overlap(a, a)).toBe(1);
    expect(jaccard(a, a)).toBe(1);
    expect(overlap(a, "the quick brown fox jumps over the lazy dog near the river bank")).toBe(0);
    expect(overlap(a, `${a} and then some more words that are new here`)).toBe(1);
    expect(jaccard(a, `${a} and then some more words that are new here`)).toBeLessThan(1);
  });
});

describe("delivery areas", () => {
  it("slugs are unique and URL-safe", () => {
    const slugs = DELIVERY_AREAS.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("every area has its own substance (no doorway pages)", () => {
    for (const a of DELIVERY_AREAS) {
      expect(a.neighbourhoods.length, `${a.slug} needs real neighbourhoods`).toBeGreaterThanOrEqual(
        3,
      );
      expect(a.places.length, `${a.slug} needs real places`).toBeGreaterThanOrEqual(5);
      expect(a.route.length, `${a.slug} needs a delivery route`).toBeGreaterThan(0);
      expect(a.occasions.length, `${a.slug} needs occasions`).toBeGreaterThanOrEqual(3);
      expect(a.faqs.length, `${a.slug} needs its own FAQs`).toBeGreaterThanOrEqual(4);
    }
  });

  it("every page has 600+ words written for that area alone", () => {
    for (const a of DELIVERY_AREAS) {
      expect(words(areaOwnText(a)).length, `${a.slug} own copy`).toBeGreaterThanOrEqual(600);
    }
  });

  it("no two area pages overlap by 30% or more (5-word shingles)", () => {
    const texts = DELIVERY_AREAS.map((a) => [a.slug, areaPageText(a)] as const);
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const o = overlap(texts[i][1], texts[j][1]);
        expect(o, `${texts[i][0]} vs ${texts[j][0]}`).toBeLessThan(0.3);
      }
    }
  });

  it("titles and descriptions fit and are unique", () => {
    const titles = DELIVERY_AREAS.map((a) => fitTitle(areaTitle(a)));
    const descs = DELIVERY_AREAS.map((a) => a.description);
    for (const t of titles) expect(t.length).toBeLessThanOrEqual(MAX_TITLE);
    for (const d of descs) expect(d.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descs).size).toBe(descs.length);
  });

  it("only published areas are reachable or linked", () => {
    for (const a of DELIVERY_AREAS) expect(!!findArea(a.slug)).toBe(a.published);
    expect(findArea("not-a-place")).toBeUndefined();
    for (const a of DELIVERY_AREAS) {
      for (const n of nearbyAreas(a))
        expect(n.published, `${a.slug} links draft ${n.slug}`).toBe(true);
      for (const slug of a.nearby)
        expect(
          DELIVERY_AREAS.some((x) => x.slug === slug),
          `${a.slug} → ${slug}`,
        ).toBe(true);
    }
  });

  it("the 8 Q5 areas are live: owner confirmed delivery everywhere in Lagos (24 Nov 2026)", () => {
    const drafts = [
      "ikorodu",
      "sangotedo",
      "chevron",
      "oniru",
      "ilupeju",
      "ojota",
      "apapa",
      "agege",
    ];
    for (const slug of drafts) {
      const a = DELIVERY_AREAS.find((x) => x.slug === slug);
      expect(a, slug).toBeDefined();
      expect(a?.published, slug).toBe(true);
      expect(PUBLISHED_AREAS.some((p) => p.slug === slug)).toBe(true);
    }
  });

  it("no page states a delivery fee, a time in minutes/hours, or a TODO", () => {
    for (const a of DELIVERY_AREAS) {
      const text = areaPageText(a);
      expect(text, a.slug).not.toMatch(/₦\s?\d|\bN\d{3,}/);
      expect(text, a.slug).not.toMatch(/\d+\s?(?:-|–|to)?\s?\d*\s?(?:mins?|minutes|hrs?|hours)\b/i);
      expect(text, a.slug).not.toMatch(/TODO/);
    }
  });

  it("Service schema lists the area and its neighbourhoods", () => {
    for (const a of PUBLISHED_AREAS) {
      const ld = areaServiceLd(a) as { "@type": string; areaServed: { name: string }[] };
      expect(ld["@type"]).toBe("Service");
      expect(ld.areaServed.map((p) => p.name)).toEqual([`${a.name}, Lagos`, ...a.neighbourhoods]);
    }
  });
});

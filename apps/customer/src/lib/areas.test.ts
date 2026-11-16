import { describe, it, expect } from "vitest";
import { DELIVERY_AREAS, PUBLISHED_AREAS, findArea } from "./areas";

describe("delivery areas", () => {
  it("slugs are unique and URL-safe", () => {
    const slugs = DELIVERY_AREAS.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("every published area has its own substance (no doorway pages)", () => {
    for (const a of PUBLISHED_AREAS) {
      expect(a.neighbourhoods.length, `${a.slug} needs real neighbourhoods`).toBeGreaterThanOrEqual(2);
      expect(a.intro.length, `${a.slug} intro too short`).toBeGreaterThan(120);
    }
  });

  it("intros are not copies of each other", () => {
    const intros = DELIVERY_AREAS.map((a) => a.intro.replace(a.name, "").toLowerCase());
    expect(new Set(intros).size).toBe(intros.length);
  });

  it("only published areas are reachable", () => {
    for (const a of DELIVERY_AREAS) expect(!!findArea(a.slug)).toBe(a.published);
    expect(findArea("not-a-place")).toBeUndefined();
  });

  it("no page states a delivery fee (checkout uses live courier quotes)", () => {
    for (const a of DELIVERY_AREAS) {
      expect(`${a.intro} ${a.localNotes.join(" ")}`).not.toMatch(/₦\s?\d/);
    }
  });
});

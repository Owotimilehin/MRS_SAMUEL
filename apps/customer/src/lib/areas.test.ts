import { describe, it, expect } from "vitest";
import { DELIVERY_AREAS, PUBLISHED_AREAS, findArea, areaFee } from "./areas";

describe("delivery areas", () => {
  it("slugs are unique and URL-safe", () => {
    const slugs = DELIVERY_AREAS.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("a published area has real owner-supplied local facts (no doorway pages)", () => {
    for (const a of PUBLISHED_AREAS) {
      expect(a.localNotes.length, `${a.slug} needs localNotes`).toBeGreaterThan(0);
      expect(a.neighbourhoods.length, `${a.slug} needs neighbourhoods`).toBeGreaterThan(0);
      expect(a.intro.length, `${a.slug} intro too short`).toBeGreaterThan(120);
    }
  });

  it("intros are not copies of each other", () => {
    const intros = DELIVERY_AREAS.map((a) => a.intro.replace(a.name, "").toLowerCase());
    expect(new Set(intros).size).toBe(intros.length);
  });

  it("drafts are not reachable", () => {
    for (const a of DELIVERY_AREAS.filter((x) => !x.published)) expect(findArea(a.slug)).toBeUndefined();
    expect(findArea("ikeja")?.name).toBeTruthy();
  });

  it("fee comes from matching admin zones, lowest wins, case-insensitive", () => {
    const area = { ...DELIVERY_AREAS[0], zoneNames: ["Lekki Phase 1", "lekki ii"] };
    const zones = [
      { name: "lekki phase 1", fee_ngn: 3000 },
      { name: "Lekki II", fee_ngn: 2500 },
      { name: "Ajao Estate area", fee_ngn: 1500 },
    ];
    expect(areaFee(area, zones)).toBe(2500);
    expect(areaFee({ ...area, zoneNames: [] }, zones)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { fitDescription, fitTitle, seo, MAX_DESCRIPTION, MAX_TITLE } from "./seo";

describe("fitTitle (F2)", () => {
  it("keeps titles that already fit", () => {
    expect(fitTitle("Fresh Fruit Juice in Lagos — Delivered Cold | Mrs. Samuel")).toBe(
      "Fresh Fruit Juice in Lagos — Delivered Cold | Mrs. Samuel",
    );
  });

  it("drops the brand suffix first", () => {
    expect(fitTitle("Sweet Pepper Splash — Fresh Cold-Pressed Juice in Lagos | Mrs. Samuel")).toBe(
      "Sweet Pepper Splash — Fresh Cold-Pressed Juice in Lagos",
    );
    expect(
      fitTitle("Kunu Aya Benefits: What Tigernut Drink Does for Your Body — Mrs. Samuel Journal"),
    ).toBe("Kunu Aya Benefits: What Tigernut Drink Does for Your Body");
  });

  it("then trims at a word without a dangling separator", () => {
    const t = fitTitle(
      "Zobo (Hibiscus) Drink: Health Benefits, Side Effects and How to Make It — Mrs. Samuel Journal",
    );
    expect(t.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(t).toBe("Zobo (Hibiscus) Drink: Health Benefits, Side Effects and How");
  });
});

describe("fitDescription (F2)", () => {
  it("ends on a whole sentence when one fits", () => {
    const d = fitDescription(
      "Cold-pressed Sweet Pepper Splash made fresh in Lagos with red pepper, carrot, orange and apple. No added sugar, no preservatives, delivered cold to your door today.",
    );
    expect(d).toBe(
      "Cold-pressed Sweet Pepper Splash made fresh in Lagos with red pepper, carrot, orange and apple.",
    );
  });

  it("otherwise trims at a word with an ellipsis", () => {
    const d = fitDescription(`${"word ".repeat(60)}`);
    expect(d.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(d.endsWith("word…")).toBe(true);
  });
});

describe("seo()", () => {
  it("applies both limits to the <title> and meta description", () => {
    const head = seo({ title: "x ".repeat(50), description: "y ".repeat(100), path: "/a" });
    const title = head.meta.find((m) => "title" in m)!.title!;
    const desc = head.meta.find((m) => m.name === "description")!.content!;
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(desc.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(head.links).toEqual([{ rel: "canonical", href: "https://mrssamuel.com/a" }]);
  });
});

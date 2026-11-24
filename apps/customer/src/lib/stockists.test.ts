import { describe, expect, it } from "vitest";
import data from "./stockists.json";
import { parseStockists, stockistEntries, stockistsLd, STOCKISTS } from "./stockists";
import { buildSitemapXml, collectSitemapEntries } from "./sitemap";

const gym = {
  name: "Example Gym",
  type: "gym",
  area: "Lekki Phase 1",
  address: "1 Example Street, Lekki Phase 1, Lagos",
  url: "https://instagram.com/examplegym",
};

describe("stockists (A5)", () => {
  it("ships with an empty list, so the page stays out of the sitemap", async () => {
    expect(STOCKISTS).toEqual(parseStockists(data));
    expect(stockistEntries([])).toEqual([]);
    if (STOCKISTS.length === 0) {
      const entries = await collectSitemapEntries((async () => []) as never);
      expect(buildSitemapXml(entries)).not.toContain("/stockists");
    }
  });

  it("adds /stockists to the sitemap once there is an entry", () => {
    const list = parseStockists({ stockists: [gym] });
    expect(stockistEntries(list)).toEqual([
      { path: "/stockists", changefreq: "monthly", priority: 0.5 },
    ]);
  });

  it("drops incomplete rows and unsafe links instead of breaking the page", () => {
    const list = parseStockists({
      stockists: [
        gym,
        { name: "No address", type: "salon", area: "Ikeja" },
        { name: "  Spa  ", type: "SPA", area: "VI", address: "2 Road", url: "javascript:alert(1)" },
        { name: "Odd type", type: "bakery", area: "Yaba", address: "3 Road" },
        null,
      ],
    });
    expect(list.map((s) => s.name)).toEqual(["Example Gym", "Spa", "Odd type"]);
    expect(list[1]).toEqual({ name: "Spa", type: "spa", area: "VI", address: "2 Road" });
    expect(list[2]!.type).toBe("other");
    expect(parseStockists(null)).toEqual([]);
    expect(parseStockists({ stockists: "nope" })).toEqual([]);
  });

  it("emits one LocalBusiness-type node per stockist", () => {
    const ld = stockistsLd(parseStockists({ stockists: [gym] })) as {
      itemListElement: { item: Record<string, unknown> }[];
    };
    expect(ld.itemListElement).toHaveLength(1);
    const item = ld.itemListElement[0]!.item;
    expect(item["@type"]).toBe("ExerciseGym");
    expect(item.name).toBe("Example Gym");
    expect(item.url).toBe("https://instagram.com/examplegym");
    expect((item.address as Record<string, string>).addressLocality).toBe("Lekki Phase 1");
  });
});

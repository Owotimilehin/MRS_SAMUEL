import { describe, it, expect } from "vitest";
import { buildSitemapXml, collectSitemapEntries, handleSitemapRequest, STATIC_ENTRIES } from "./sitemap";
import { DELIVERY_AREAS } from "./areas";

const fakeApi = (data: Record<string, unknown>) =>
  (async <T,>(path: string): Promise<T> => {
    if (!(path in data)) throw new Error(`unexpected ${path}`);
    const v = data[path];
    if (v instanceof Error) throw v;
    return v as T;
  }) as <T>(path: string) => Promise<T>;

describe("sitemap", () => {
  it("lists static pages, area pages, every juice and every blog post", async () => {
    const entries = await collectSitemapEntries(
      fakeApi({
        "/v1/public/catalog/products": [{ slug: "pineapple" }, { slug: "zobo" }],
        "/v1/public/blog": [{ slug: "zobo-benefits", published_at: "2026-10-01T09:00:00Z" }],
      }),
    );
    const xml = buildSitemapXml(entries);
    expect(xml).toContain("<loc>https://mrssamuel.com/juices/pineapple</loc>");
    expect(xml).toContain("<loc>https://mrssamuel.com/juices/zobo</loc>");
    expect(xml).toContain("<loc>https://mrssamuel.com/blog/zobo-benefits</loc><lastmod>2026-10-01</lastmod>");
    expect(xml).toContain("<loc>https://mrssamuel.com/delivery</loc>");
    for (const a of DELIVERY_AREAS) {
      expect(xml).toContain(`<loc>https://mrssamuel.com/juice-delivery-lagos/${a.slug}</loc>`);
    }
    expect(xml).not.toContain("/checkout");
    expect(xml).not.toContain("/track");
  });

  it("still returns the static pages when the API is down", async () => {
    const entries = await collectSitemapEntries(
      fakeApi({ "/v1/public/catalog/products": new Error("down"), "/v1/public/blog": new Error("down") }),
    );
    expect(entries.length).toBe(STATIC_ENTRIES.length + DELIVERY_AREAS.length);
  });

  it("dedupes and escapes", () => {
    const xml = buildSitemapXml([{ path: "/a?x=1&y=2" }, { path: "/a?x=1&y=2" }]);
    expect(xml.match(/<url>/g)?.length).toBe(1);
    expect(xml).toContain("&amp;");
  });

  it("only answers GET/HEAD /sitemap.xml", async () => {
    const api = fakeApi({ "/v1/public/catalog/products": [], "/v1/public/blog": [] });
    expect(await handleSitemapRequest(new Request("https://mrssamuel.com/shop"), api)).toBeNull();
    expect(await handleSitemapRequest(new Request("https://mrssamuel.com/sitemap.xml", { method: "POST" }), api)).toBeNull();
    const res = await handleSitemapRequest(new Request("https://mrssamuel.com/sitemap.xml"), api);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("application/xml");
  });
});

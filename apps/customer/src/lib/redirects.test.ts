import { describe, expect, it } from "vitest";
import { REDIRECTS, handleRedirect, normalisePath } from "./redirects";
import { STATIC_ENTRIES } from "./sitemap";

const req = (url: string, init: RequestInit = {}) => new Request(url, init);

describe("redirect map", () => {
  it("has no chains or loops: no target is itself a redirected path", () => {
    const froms = new Set(REDIRECTS.map((r) => normalisePath(r.from)));
    for (const r of REDIRECTS) {
      expect(froms.has(normalisePath(r.to)), `${r.from} -> ${r.to}`).toBe(false);
    }
  });

  it("never redirects a page the sitemap lists", () => {
    const froms = new Set(REDIRECTS.map((r) => normalisePath(r.from)));
    for (const e of STATIC_ENTRIES) expect(froms.has(e.path), e.path).toBe(false);
  });

  it("has unique sources and site-relative targets", () => {
    const froms = REDIRECTS.map((r) => normalisePath(r.from));
    expect(new Set(froms).size).toBe(froms.length);
    for (const r of REDIRECTS) expect(r.to.startsWith("/")).toBe(true);
  });
});

describe("handleRedirect", () => {
  it("301s a retired product URL to its replacement in one hop", () => {
    const res = handleRedirect(req("https://mrssamuel.com/juices/orange-juice"))!;
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://mrssamuel.com/juices/orange");
  });

  it("matches a trailing slash and the encoded template paths", () => {
    expect(
      handleRedirect(req("https://mrssamuel.com/subscription/"))!.headers.get("location"),
    ).toBe("https://mrssamuel.com/shop");
    expect(handleRedirect(req("https://mrssamuel.com/blog/%24slug"))!.headers.get("location")).toBe(
      "https://mrssamuel.com/blog",
    );
    expect(handleRedirect(req("https://mrssamuel.com/juices/$id"))!.headers.get("location")).toBe(
      "https://mrssamuel.com/juices",
    );
  });

  it("sends an http visit to an old URL straight to the https target", () => {
    const res = handleRedirect(
      req("http://mrssamuel.com/juices/pineapple-juice", {
        headers: { "cf-visitor": '{"scheme":"http"}' },
      }),
    )!;
    expect(res.headers.get("location")).toBe("https://mrssamuel.com/juices/pineapple");
  });

  it("always sends production hosts to the canonical origin", () => {
    expect(
      handleRedirect(req("https://www.mrssamuel.com/specials"))!.headers.get("location"),
    ).toBe("https://mrssamuel.com/shop");
    expect(handleRedirect(req("http://localhost:3000/specials"))!.headers.get("location")).toBe(
      "https://localhost:3000/shop",
    );
  });

  it("upgrades a plain-http visit, keeping path and query", () => {
    const res = handleRedirect(
      req("http://mrssamuel.com/juices?x=1", { headers: { "cf-visitor": '{"scheme":"http"}' } }),
    )!;
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://mrssamuel.com/juices?x=1");
  });

  it("leaves https visits, live pages, unknown URLs and POSTs alone", () => {
    const https = { headers: { "cf-visitor": '{"scheme":"https"}' } };
    expect(handleRedirect(req("http://mrssamuel.com/juices", https))).toBeNull();
    expect(handleRedirect(req("https://mrssamuel.com/juices/orange"))).toBeNull();
    expect(handleRedirect(req("https://mrssamuel.com/no-such-page"))).toBeNull();
    expect(handleRedirect(req("https://mrssamuel.com/cart", { method: "POST" }))).toBeNull();
    expect(
      handleRedirect(
        req("http://mrssamuel.com/checkout", {
          method: "POST",
          headers: { "cf-visitor": '{"scheme":"http"}' },
        }),
      ),
    ).toBeNull();
  });
});

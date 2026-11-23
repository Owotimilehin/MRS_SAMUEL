/**
 * SEO C7: structured data checks.
 *
 * 1. Every indexable, non-home route declares a BreadcrumbList.
 * 2. JSON-LD built for a sample of pages has the fields Google's Rich Results
 *    Test requires (Product, BreadcrumbList, Organization, WebSite,
 *    BlogPosting, FAQPage).
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  articleLd,
  breadcrumbLd,
  faqPageLd,
  organizationLd,
  productLd,
  seo,
  SITE_URL,
  websiteLd,
} from "./seo";
import { PRODUCT_COPY } from "./product-copy";
import { productOffer } from "./product-offer";

const ROUTES = new URL("../routes/", import.meta.url);

/** Routes that are home, noindex, or private utility pages (no breadcrumb). */
const NO_BREADCRUMB: Record<string, string> = {
  "index.tsx": "home page",
  "ig.tsx": "noindex link hub",
  "checkout.tsx": "checkout utility",
  "order.$orderNumber.tsx": "private order status",
  "__root.tsx": "root layout",
};

type Ld = Record<string, unknown>;

function checkBreadcrumb(ld: Ld) {
  expect(ld["@context"]).toBe("https://schema.org");
  expect(ld["@type"]).toBe("BreadcrumbList");
  const items = ld.itemListElement as Ld[];
  expect(items.length).toBeGreaterThanOrEqual(2);
  items.forEach((it, i) => {
    expect(it["@type"]).toBe("ListItem");
    expect(it.position).toBe(i + 1);
    expect(typeof it.name).toBe("string");
    expect((it.name as string).length).toBeGreaterThan(0);
    expect(it.item).toMatch(new RegExp(`^${SITE_URL}/`));
  });
  expect(items[0]!.item).toBe(`${SITE_URL}/`);
}

function checkProduct(ld: Ld) {
  expect(ld["@type"]).toBe("Product");
  for (const k of ["name", "image", "description", "url"]) {
    expect(typeof ld[k], k).toBe("string");
    expect((ld[k] as string).length, k).toBeGreaterThan(0);
  }
  expect(ld.image).toMatch(/^https:\/\//);
  expect((ld.brand as Ld).name).toBeTruthy();
  const offer = ld.offers as Ld;
  expect(offer["@type"]).toBe("Offer");
  expect(offer.priceCurrency).toBe("NGN");
  expect(typeof offer.price).toBe("number");
  expect(offer.price as number).toBeGreaterThan(0);
  expect(offer.availability).toMatch(/^https:\/\/schema\.org\/(InStock|OutOfStock|PreOrder)$/);
  // Never ship invented ratings, reviews or nutrition.
  for (const k of ["aggregateRating", "review", "nutrition"]) expect(ld[k]).toBeUndefined();
}

/** Parse the JSON-LD scripts back out of a seo() head payload. */
const lds = (head: ReturnType<typeof seo>) => head.scripts.map((s) => JSON.parse(s.children) as Ld);

describe("BreadcrumbList on every indexable non-home route (C7)", () => {
  const files = readdirSync(ROUTES).filter((f) => f.endsWith(".tsx"));
  for (const f of files) {
    const src = readFileSync(new URL(f, ROUTES), "utf8");
    const hasHead = /\bhead:\s*\(/.test(src);
    if (!hasHead || f in NO_BREADCRUMB) continue;
    it(`${f} declares a breadcrumb`, () => {
      expect(src).toMatch(/breadcrumbLd\(/);
    });
  }
});

describe("JSON-LD for sample pages has required fields (C7)", () => {
  it("product pages", () => {
    const p = {
      id: "lemon-sip",
      name: "Lemon Sip",
      image: "/media/bottles/bottle-lemon.png",
      prices: { "330ml": 2500, "650ml": 3500 },
      variantIds: { "330ml": "a", "650ml": "b" },
      availableBySize: { "330ml": 0, "650ml": 36 },
    };
    const offer = productOffer(p)!;
    const path = `/juices/${p.id}`;
    const description = PRODUCT_COPY[p.id]!.metaDescription;
    const head = seo({
      title: `${p.name} | Mrs. Samuel`,
      description,
      path,
      image: p.image,
      type: "product",
      jsonLd: [
        productLd({
          name: p.name,
          description,
          image: p.image,
          path,
          priceNgn: offer.priceNgn,
          availability: offer.availability,
        }),
        breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Our Juices", path: "/juices" },
          { name: p.name, path },
        ]),
      ],
    });
    const [product, crumbs] = lds(head);
    checkProduct(product!);
    expect((product!.offers as Ld).price).toBe(3500);
    expect((product!.offers as Ld).availability).toBe("https://schema.org/InStock");
    checkBreadcrumb(crumbs!);
    expect(head.meta.find((m) => m.name === "description")!.content).toBe(description);
  });

  it.each([
    ["/about", "About"],
    ["/juices", "Our Juices"],
    ["/blog", "Journal"],
    ["/contact", "Contact"],
    ["/delivery", "Delivery Information"],
    ["/track", "Track your order"],
    ["/juice-delivery-lagos", "Juice Delivery in Lagos"],
  ])("static page %s", (path, name) => {
    const [crumbs] = lds(
      seo({
        title: name,
        path,
        jsonLd: [
          breadcrumbLd([
            { name: "Home", path: "/" },
            { name, path },
          ]),
        ],
      }),
    );
    checkBreadcrumb(crumbs!);
  });

  it("blog post with FAQ", () => {
    const path = "/blog/why-cold-pressed";
    const [article, crumbs, faq] = lds(
      seo({
        title: "Why cold-pressed",
        path,
        type: "article",
        jsonLd: [
          articleLd({ title: "Why cold-pressed", description: "d", image: "/x.png", path }),
          breadcrumbLd([
            { name: "Home", path: "/" },
            { name: "Journal", path: "/blog" },
            { name: "Why cold-pressed", path },
          ]),
          faqPageLd([{ q: "Is it pasteurised?", a: "No." }]),
        ],
      }),
    );
    expect(article!["@type"]).toBe("BlogPosting");
    expect(article!.headline).toBeTruthy();
    expect(article!.image).toMatch(/^https:\/\//);
    checkBreadcrumb(crumbs!);
    const q = (faq!.mainEntity as Ld[])[0]!;
    expect(q["@type"]).toBe("Question");
    expect((q.acceptedAnswer as Ld).text).toBe("No.");
  });

  it("organization and website", () => {
    const org = organizationLd() as Ld;
    expect(org.name).toBeTruthy();
    expect(org.url).toBe(SITE_URL);
    expect(org.logo).toMatch(/^https:\/\//);
    expect((org.address as Ld).addressCountry).toBe("NG");
    const site = websiteLd() as Ld;
    expect(site["@type"]).toBe("WebSite");
    expect(site.url).toBe(SITE_URL);
  });
});

/**
 * Central SEO helpers. One source of truth for titles, canonical URLs, Open
 * Graph + Twitter cards, and JSON-LD structured data so every page ships
 * complete, consistent, crawlable metadata. Safe for client + server (no
 * secrets) — just strings.
 *
 * Usage in a route:
 *   head: ({ loaderData }) => seo({
 *     title: "...", description: "...", path: "/shop",
 *     jsonLd: [organizationLd(), breadcrumbLd([...])],
 *   })
 */

export const SITE_URL = "https://mrssamuel.com";
export const SITE_NAME = "Mrs. Samuel Fruit Juice";
export const DEFAULT_DESCRIPTION =
  "100% natural, cold-pressed Nigerian fruit juice, pressed fresh every morning in Lagos. No added sugar, no preservatives — just real fruit.";
/** 1200x630 capture of the landing hero. Bump ?v= when replacing the file — WhatsApp/FB cache by URL. */
export const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image.png?v=2`;
export const TWITTER_HANDLE = "@Mrs_samuelfruitjuice";
export const PHONE = "+2349019512246";
/** Business contact inbox (Cloudflare Email Routing → owner's mailbox). */
export const EMAIL = "info@mrssamuel.com";

interface MetaTag {
  [k: string]: string;
}
interface LinkTag {
  rel: string;
  href: string;
  [k: string]: string;
}
interface ScriptTag {
  type: string;
  children: string;
}

/** Make a possibly-relative image path absolute against the site origin. */
export function absUrl(pathOrUrl: string | null | undefined): string {
  if (!pathOrUrl) return DEFAULT_OG_IMAGE;
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${SITE_URL}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

export interface SeoInput {
  title: string;
  description?: string;
  /** Site-root-relative path, e.g. "/juices/zobo-blast". Drives canonical + og:url. */
  path: string;
  image?: string | null;
  type?: "website" | "article" | "product";
  noIndex?: boolean;
  jsonLd?: object[];
}

/** Google shows about 60 characters of a title and 155 of a description. */
export const MAX_TITLE = 60;
export const MAX_DESCRIPTION = 155;

/** Cut at the last word boundary that fits, without a dangling separator. */
function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : s.slice(0, max)).replace(/[\s,:;|—–-]+$/, "");
}

/** Keep a <title> within MAX_TITLE: first drop the brand suffix
 *  ("| Mrs. Samuel", "— Mrs. Samuel Journal"), then trim at a word. */
export function fitTitle(title: string): string {
  const t = title.trim();
  if (t.length <= MAX_TITLE) return t;
  const noBrand = t.replace(/\s+[|—–-]\s+Mrs\. Samuel[^|—–]*$/, "").trim();
  return cutAtWord(noBrand, MAX_TITLE);
}

/** Keep a meta description within MAX_DESCRIPTION: end on a full sentence
 *  when one fits, otherwise trim at a word and add an ellipsis. */
export function fitDescription(description: string): string {
  const d = description.replace(/\s+/g, " ").trim();
  if (d.length <= MAX_DESCRIPTION) return d;
  const head = d.slice(0, MAX_DESCRIPTION);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (end >= 80) return head.slice(0, end + 1);
  return `${cutAtWord(d, MAX_DESCRIPTION - 1)}…`;
}

/** Build the full {meta, links, scripts} head payload for a page. */
export function seo(input: SeoInput): { meta: MetaTag[]; links: LinkTag[]; scripts: ScriptTag[] } {
  const url = `${SITE_URL}${input.path}`;
  const description = fitDescription(input.description?.trim() || DEFAULT_DESCRIPTION);
  const image = absUrl(input.image);
  const meta: MetaTag[] = [
    { title: fitTitle(input.title) },
    { name: "description", content: description },
    { name: "robots", content: input.noIndex ? "noindex, nofollow" : "index, follow" },
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:locale", content: "en_NG" },
    { property: "og:type", content: input.type ?? "website" },
    { property: "og:title", content: input.title },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: image },
    { property: "og:image:alt", content: input.title },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:site", content: TWITTER_HANDLE },
    { name: "twitter:creator", content: TWITTER_HANDLE },
    { name: "twitter:title", content: input.title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
  ];
  const scripts = (input.jsonLd ?? []).map((obj) => ({
    type: "application/ld+json",
    children: JSON.stringify(obj),
  }));
  return { meta, links: [{ rel: "canonical", href: url }], scripts };
}

// ---- JSON-LD builders -----------------------------------------------------

/** Organization + LocalBusiness (FoodEstablishment) for the brand. Site-wide. */
export function organizationLd(): object {
  return {
    "@context": "https://schema.org",
    "@type": ["Organization", "FoodEstablishment"],
    "@id": `${SITE_URL}/#organization`,
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/favicon.png`,
    image: DEFAULT_OG_IMAGE,
    description: DEFAULT_DESCRIPTION,
    telephone: PHONE,
    email: EMAIL,
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer service",
      telephone: PHONE,
      email: EMAIL,
      areaServed: "NG",
      availableLanguage: "en",
    },
    priceRange: "₦₦",
    areaServed: { "@type": "City", name: "Lagos", containedInPlace: { "@type": "Country", name: "Nigeria" } },
    // TODO(owner): add `hasMap: "<Google Maps listing URL>"` and the Maps URL
    // to `sameAs` once shared — it ties this site to the Business Profile.
    servesCuisine: "Cold-pressed fruit juice",
    address: {
      "@type": "PostalAddress",
      streetAddress: "30 Asa Afariogun Street, Ajao Estate",
      addressLocality: "Ikeja",
      addressRegion: "Lagos",
      addressCountry: "NG",
    },
    openingHoursSpecification: [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
        opens: "08:00",
        closes: "20:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "Sunday",
        opens: "10:00",
        closes: "20:00",
      },
    ],
    sameAs: ["https://instagram.com/Mrs_samuelfruitjuice"],
  };
}

/** WebSite node (helps Google show the site name + enables future sitelinks). */
export function websiteLd(): object {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    url: SITE_URL,
    name: SITE_NAME,
    publisher: { "@id": `${SITE_URL}/#organization` },
  };
}

/** Product offer for a juice page. */
export function productLd(p: {
  name: string;
  description: string;
  image: string;
  path: string;
  priceNgn?: number;
  /** schema.org ItemAvailability short name. Defaults to InStock. */
  availability?: "InStock" | "OutOfStock" | "PreOrder";
}): object {
  // TODO(owner): no nutrition facts, reviews or ratings are added here on
  // purpose. Add `nutrition`, `review` or `aggregateRating` only once real,
  // verified values exist (lab-tested nutrition, genuine customer reviews).
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    description: p.description,
    image: absUrl(p.image),
    brand: { "@type": "Brand", name: SITE_NAME },
    url: `${SITE_URL}${p.path}`,
    ...(p.priceNgn != null
      ? {
          offers: {
            "@type": "Offer",
            priceCurrency: "NGN",
            price: p.priceNgn,
            availability: `https://schema.org/${p.availability ?? "InStock"}`,
            url: `${SITE_URL}${p.path}`,
          },
        }
      : {}),
  };
}

/** BlogPosting / Article for a journal post. */
export function articleLd(a: {
  title: string;
  description: string;
  image: string;
  path: string;
  author?: string;
  datePublished?: string;
}): object {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: a.title,
    description: a.description,
    image: absUrl(a.image),
    url: `${SITE_URL}${a.path}`,
    mainEntityOfPage: `${SITE_URL}${a.path}`,
    author: { "@type": "Organization", name: a.author || SITE_NAME },
    publisher: { "@id": `${SITE_URL}/#organization` },
    ...(a.datePublished ? { datePublished: a.datePublished } : {}),
  };
}

/** FAQPage — only for Q&As that are visibly rendered on the same page. */
export function faqPageLd(faqs: { q: string; a: string }[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

/** Breadcrumb trail. Pass [{name, path}] root-first. */
export function breadcrumbLd(items: { name: string; path: string }[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: `${SITE_URL}${it.path}`,
    })),
  };
}

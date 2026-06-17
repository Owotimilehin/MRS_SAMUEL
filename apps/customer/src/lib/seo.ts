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
export const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image.png`;
export const TWITTER_HANDLE = "@Mrs_samuelfruitjuice";
export const PHONE = "+2349019512246";

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

/** Build the full {meta, links, scripts} head payload for a page. */
export function seo(input: SeoInput): { meta: MetaTag[]; links: LinkTag[]; scripts: ScriptTag[] } {
  const url = `${SITE_URL}${input.path}`;
  const description = input.description?.trim() || DEFAULT_DESCRIPTION;
  const image = absUrl(input.image);
  const meta: MetaTag[] = [
    { title: input.title },
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
    logo: `${SITE_URL}/og-image.png`,
    image: DEFAULT_OG_IMAGE,
    description: DEFAULT_DESCRIPTION,
    telephone: PHONE,
    priceRange: "₦₦",
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
}): object {
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
            availability: "https://schema.org/InStock",
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

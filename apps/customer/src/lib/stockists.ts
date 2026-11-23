/**
 * Stockists (SEO roadmap task A5): gyms, salons, offices and hotels that sell
 * our juice. The owner edits ./stockists.json; nothing else needs to change.
 *
 * The /stockists sitemap entry (and indexing) is gated on the list being
 * non-empty, so we never ask Google to index an empty page.
 */
import data from "./stockists.json";
import { SITE_URL } from "./seo";

export const STOCKIST_TYPES = [
  "gym",
  "salon",
  "office",
  "hotel",
  "cafe",
  "restaurant",
  "shop",
  "spa",
  "other",
] as const;
export type StockistType = (typeof STOCKIST_TYPES)[number];

export interface Stockist {
  name: string;
  type: StockistType;
  area: string;
  address: string;
  url?: string;
  phone?: string;
  mapsUrl?: string;
}

/** schema.org subtype for each kind of stockist (all are LocalBusiness). */
const SCHEMA_TYPE: Record<StockistType, string> = {
  gym: "ExerciseGym",
  salon: "BeautySalon",
  office: "LocalBusiness",
  hotel: "Hotel",
  cafe: "CafeOrCoffeeShop",
  restaurant: "Restaurant",
  shop: "Store",
  spa: "DaySpa",
  other: "LocalBusiness",
};

export const STOCKIST_LABEL: Record<StockistType, string> = {
  gym: "Gym",
  salon: "Salon",
  office: "Office",
  hotel: "Hotel",
  cafe: "Café",
  restaurant: "Restaurant",
  shop: "Shop",
  spa: "Spa",
  other: "Stockist",
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const httpUrl = (v: unknown): string | undefined => {
  const s = str(v);
  return /^https?:\/\/\S+$/i.test(s) ? s : undefined;
};

/** Keep only well-formed rows, so one typo in the JSON can't break the page. */
export function parseStockists(raw: unknown): Stockist[] {
  const list = (raw as { stockists?: unknown } | null)?.stockists;
  if (!Array.isArray(list)) return [];
  const out: Stockist[] = [];
  for (const row of list) {
    const r = (row ?? {}) as Record<string, unknown>;
    const name = str(r.name);
    const area = str(r.area);
    const address = str(r.address);
    if (!name || !area || !address) continue;
    const t = str(r.type).toLowerCase();
    const type = (STOCKIST_TYPES as readonly string[]).includes(t) ? (t as StockistType) : "other";
    const s: Stockist = { name, type, area, address };
    const url = httpUrl(r.url);
    const mapsUrl = httpUrl(r.mapsUrl);
    const phone = str(r.phone);
    if (url) s.url = url;
    if (mapsUrl) s.mapsUrl = mapsUrl;
    if (phone) s.phone = phone;
    out.push(s);
  }
  return out;
}

export const STOCKISTS: Stockist[] = parseStockists(data);

export const STOCKISTS_PATH = "/stockists";

/** Sitemap rows for the stockists page: none while the list is empty. */
export function stockistEntries(list: Stockist[] = STOCKISTS): {
  path: string;
  changefreq: "monthly";
  priority: number;
}[] {
  return list.length > 0 ? [{ path: STOCKISTS_PATH, changefreq: "monthly", priority: 0.5 }] : [];
}

/** One LocalBusiness node per stockist, wrapped in an ItemList. */
export function stockistsLd(list: Stockist[] = STOCKISTS): object {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Where to buy Mrs. Samuel Fruit Juice",
    url: `${SITE_URL}${STOCKISTS_PATH}`,
    itemListElement: list.map((s, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": SCHEMA_TYPE[s.type],
        name: s.name,
        address: {
          "@type": "PostalAddress",
          streetAddress: s.address,
          addressLocality: s.area,
          addressRegion: "Lagos",
          addressCountry: "NG",
        },
        ...(s.url ? { url: s.url } : {}),
        ...(s.phone ? { telephone: s.phone } : {}),
        ...(s.mapsUrl ? { hasMap: s.mapsUrl } : {}),
      },
    })),
  };
}

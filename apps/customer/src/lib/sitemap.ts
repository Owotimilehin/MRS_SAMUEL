/**
 * Dynamic /sitemap.xml. Replaces the old hand-written public/sitemap.xml,
 * which only listed 9 static pages — none of the juice pages, blog posts or
 * local landing pages, so Google had to discover them by crawling.
 *
 * Served from src/server.ts before TanStack sees the request. If the API is
 * unreachable we still return the static pages (never a 500 to Googlebot).
 */
import { SITE_URL } from "./seo";
import { PUBLISHED_AREAS } from "./areas";

export interface SitemapEntry {
  path: string;
  changefreq?: "daily" | "weekly" | "monthly" | "yearly";
  priority?: number;
  lastmod?: string | null;
}

/** Indexable pages that exist regardless of catalog/blog content. */
export const STATIC_ENTRIES: SitemapEntry[] = [
  { path: "/", changefreq: "daily", priority: 1.0 },
  { path: "/juices", changefreq: "weekly", priority: 0.9 },
  { path: "/shop", changefreq: "weekly", priority: 0.9 },
  { path: "/juice-delivery-lagos", changefreq: "monthly", priority: 0.9 },
  { path: "/bulk-orders", changefreq: "monthly", priority: 0.8 },
  { path: "/white-label", changefreq: "monthly", priority: 0.7 },
  { path: "/blog", changefreq: "weekly", priority: 0.7 },
  { path: "/about", changefreq: "monthly", priority: 0.6 },
  { path: "/delivery", changefreq: "monthly", priority: 0.6 },
  { path: "/contact", changefreq: "monthly", priority: 0.5 },
  { path: "/returns", changefreq: "yearly", priority: 0.3 },
  { path: "/terms", changefreq: "yearly", priority: 0.3 },
];

export function areaEntries(): SitemapEntry[] {
  return PUBLISHED_AREAS.map((a) => ({
    path: `/juice-delivery-lagos/${a.slug}`,
    changefreq: "monthly" as const,
    priority: 0.8,
  }));
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Pure XML builder — dedupes by path, keeps first occurrence. */
export function buildSitemapXml(entries: SitemapEntry[]): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const e of entries) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    const parts = [`<loc>${esc(`${SITE_URL}${e.path}`)}</loc>`];
    if (e.lastmod) {
      const d = new Date(e.lastmod);
      if (!Number.isNaN(d.getTime())) parts.push(`<lastmod>${d.toISOString().slice(0, 10)}</lastmod>`);
    }
    if (e.changefreq) parts.push(`<changefreq>${e.changefreq}</changefreq>`);
    if (e.priority != null) parts.push(`<priority>${e.priority.toFixed(1)}</priority>`);
    rows.push(`  <url>${parts.join("")}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join("\n")}\n</urlset>\n`;
}

type Fetcher = <T>(path: string) => Promise<T>;

/** Collect every indexable URL. Each remote source fails independently. */
export async function collectSitemapEntries(fetchJson: Fetcher): Promise<SitemapEntry[]> {
  const [products, posts] = await Promise.all([
    fetchJson<{ slug: string }[]>("/v1/public/catalog/products").catch(() => []),
    // NOTE: /v1/public/blog returns at most 50 posts; add a sitemap-specific
    // endpoint before the blog passes that.
    fetchJson<{ slug: string; published_at: string | null }[]>("/v1/public/blog").catch(() => []),
  ]);
  return [
    ...STATIC_ENTRIES,
    ...areaEntries(),
    ...products
      .filter((p) => p?.slug)
      .map((p) => ({ path: `/juices/${encodeURIComponent(p.slug)}`, changefreq: "weekly" as const, priority: 0.8 })),
    ...posts
      .filter((p) => p?.slug)
      .map((p) => ({
        path: `/blog/${encodeURIComponent(p.slug)}`,
        changefreq: "monthly" as const,
        priority: 0.6,
        lastmod: p.published_at,
      })),
  ];
}

let memo: { xml: string; until: number } | null = null;
/** Test hook. */
export function resetSitemapCache(): void {
  memo = null;
}

/** Returns a Response for GET /sitemap.xml, else null.
 *  Built XML is memoised in-process (1h, matching Cache-Control) so crawler
 *  hits don't each cost two API calls; a degraded build (no products, e.g.
 *  API down) is only kept for a minute. */
export async function handleSitemapRequest(request: Request, fetchJson: Fetcher): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (new URL(request.url).pathname !== "/sitemap.xml") return null;
  const now = Date.now();
  if (!memo || now >= memo.until) {
    const entries = await collectSitemapEntries(fetchJson);
    const complete = entries.some((e) => e.path.startsWith("/juices/"));
    memo = { xml: buildSitemapXml(entries), until: now + (complete ? 3600_000 : 60_000) };
  }
  return new Response(request.method === "HEAD" ? null : memo.xml, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

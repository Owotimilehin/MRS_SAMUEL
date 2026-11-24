/**
 * Permanent redirects for dead URLs Google still has indexed (roadmap task F1),
 * plus http → https. Runs in src/server.ts before TanStack sees the request.
 *
 * The map lives in ./redirects.json (built from Search Console's 404 report).
 * Add a row there to retire a URL; tests guard against chains and loops.
 */
import data from "./redirects.json";
import { SITE_URL } from "./seo";

export interface RedirectRule {
  from: string;
  to: string;
  note?: string;
}

export const REDIRECTS: RedirectRule[] = data.redirects;

/** Normalise a request path for matching: decoded ("%24" → "$"), no trailing slash. */
export function normalisePath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    // Malformed escapes: match on the raw path.
  }
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

const BY_PATH = new Map(REDIRECTS.map((r) => [normalisePath(r.from), r.to]));

/** True when Cloudflare says the visitor connected over plain http. */
function visitorUsedHttp(request: Request): boolean {
  const visitor = request.headers.get("cf-visitor");
  if (!visitor) return false;
  try {
    return (JSON.parse(visitor) as { scheme?: string }).scheme === "http";
  } catch {
    return false;
  }
}

function moved(location: string): Response {
  return new Response(null, {
    status: 301,
    headers: { location, "cache-control": "public, max-age=86400" },
  });
}

/**
 * A 301 Response for a retired URL or a plain-http visit, else null.
 * Only GET/HEAD are redirected: a 301 would turn a POST into a GET.
 * A retired path goes straight to its https target in one hop, so an http
 * visit to an old URL is not a chain.
 */
export function handleRedirect(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  // Production hosts (mrssamuel.com, www.) always land on the canonical
  // origin; any other host (staging, local) keeps its own.
  const origin = /(^|\.)mrssamuel\.com$/.test(url.hostname) ? SITE_URL : `https://${url.host}`;
  const target = BY_PATH.get(normalisePath(url.pathname));
  if (target) return moved(`${origin}${target}`);
  if (visitorUsedHttp(request)) return moved(`${origin}${url.pathname}${url.search}`);
  return null;
}

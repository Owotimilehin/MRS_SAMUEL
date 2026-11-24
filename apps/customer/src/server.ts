import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleCheckoutPost } from "./lib/checkout-server";
import { handleSitemapRequest } from "./lib/sitemap";
import { handleRedirect } from "./lib/redirects";
import { apiFetch, setApiHeaderSource } from "./lib/api/client";
import { withShopper, currentShopperHeaders } from "./lib/api/shopper.server";

// Every API call made while serving a request carries that shopper's address
// (see shopper.server.ts), so the API rate-limits shoppers individually.
setApiHeaderSource(currentShopperHeaders);

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  fetch(request: Request, env: unknown, ctx: unknown) {
    return withShopper(request, () => ssrEntry.fetch(request, env, ctx));
  },
};

const ssrEntry = {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      // Retired URLs (Search Console 404s) and plain-http visits: one 301 hop.
      const redirect = handleRedirect(request);
      if (redirect) return redirect;

      // No-JS checkout submit: create the order + redirect to payment before
      // TanStack ever sees the request. Returns null for everything else.
      const checkoutRedirect = await handleCheckoutPost(request);
      if (checkoutRedirect) return checkoutRedirect;

      // Dynamic sitemap: every juice, blog post and local landing page.
      const sitemap = await handleSitemapRequest(request, apiFetch);
      if (sitemap) return sitemap;

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};

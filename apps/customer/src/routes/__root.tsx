import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { gaHeadScripts, installContactClickTracking } from "../lib/analytics";

import appCss from "../styles.css?url";
import { CartProvider } from "../lib/cart";
import { RouteError } from "../components/RouteError";
import { OngoingOrders } from "../components/OngoingOrders";
import {
  SITE_NAME,
  DEFAULT_DESCRIPTION,
  DEFAULT_OG_IMAGE,
  TWITTER_HANDLE,
  organizationLd,
  websiteLd,
} from "../lib/seo";

// Brand fonts (Fraunces + Plus Jakarta Sans) for every page, not just home.
const FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..900;1,9..144,300..700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap";

/** Inline script that attaches a stylesheet without holding up the first paint (SEO F8). */
function loadStylesheetScript(href: string): string {
  return `(function(){var l=document.createElement("link");l.rel="stylesheet";l.href=${JSON.stringify(href)};document.head.appendChild(l)})()`;
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    // Site-wide defaults. Leaf routes override title/description/canonical and
    // add their own JSON-LD via the `seo()` helper; whatever they set wins.
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: `${SITE_NAME} — Cold-Pressed Nigerian Juice, Fresh Every Morning` },
      { name: "description", content: DEFAULT_DESCRIPTION },
      { name: "author", content: SITE_NAME },
      { name: "robots", content: "index, follow" },
      { name: "theme-color", content: "#0b6b3a" },
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:locale", content: "en_NG" },
      { property: "og:type", content: "website" },
      { property: "og:title", content: SITE_NAME },
      { property: "og:description", content: DEFAULT_DESCRIPTION },
      { property: "og:image", content: DEFAULT_OG_IMAGE },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:site", content: TWITTER_HANDLE },
      { name: "twitter:title", content: SITE_NAME },
      { name: "twitter:description", content: DEFAULT_DESCRIPTION },
      { name: "twitter:image", content: DEFAULT_OG_IMAGE },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/favicon.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      // Fonts are fetched early but no longer block the first paint: the inline
      // script in `scripts` attaches the stylesheet. Text shows in the fallback
      // font and swaps in (display=swap), as before.
      { rel: "preload", as: "style", href: FONTS_CSS },
    ],
    scripts: [
      { type: "application/ld+json", children: JSON.stringify(organizationLd()) },
      { type: "application/ld+json", children: JSON.stringify(websiteLd()) },
      { children: loadStylesheetScript(FONTS_CSS) },
      // GA4 (SEO F5): empty until GA_MEASUREMENT_ID is set in lib/analytics.ts.
      ...gaHeadScripts(),
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: RouteError,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  // GA4: count WhatsApp and phone taps anywhere on the site (no-op without an ID).
  useEffect(() => installContactClickTracking(), []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Cart state is shared app-wide so it survives route navigation (e.g. product → checkout). */}
      <CartProvider>
        {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
        <Outlet />
        {/* Site-wide recovery banner for orders placed from this browser. */}
        <OngoingOrders />
      </CartProvider>
    </QueryClientProvider>
  );
}

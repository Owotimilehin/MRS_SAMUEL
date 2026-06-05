/* eslint-disable react-hooks/rules-of-hooks */
// TanStack Router calls each route's `component` arrow function as a render
// function rather than a React component; useParams is intentional here.
import {
  createRouter,
  createRoute,
  createRootRoute,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { MenuPage } from "./routes/menu.js";
import { CartPage } from "./routes/cart.js";
import { CheckoutPage } from "./routes/checkout.js";
import { TrackPage } from "./routes/track.js";
import { OrderPage } from "./routes/order.js";
import { ShopPage } from "./routes/shop.js";
import { ProductDetailPage } from "./routes/product-detail.js";
import { PrivacyPage } from "./routes/privacy.js";
import { TermsPage } from "./routes/terms.js";
import { StyleguidePage } from "./routes/styleguide.js";
import { AboutPage } from "./routes/about.js";
import { SpecialsPage } from "./routes/specials.js";
import { LocationsPage } from "./routes/locations.js";
import { BlogListPage } from "./routes/blog-list.js";
import { BlogDetailPage } from "./routes/blog-detail.js";
import { NotFound } from "./components/NotFound.js";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: NotFound,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: MenuPage,
});
const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: AboutPage,
});
const specialsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specials",
  component: SpecialsPage,
});
const locationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/locations",
  component: LocationsPage,
});
const blogIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/blog",
  component: BlogListPage,
});
const blogDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/blog/$slug",
  component: () => {
    const params = useParams({ from: "/blog/$slug" });
    return <BlogDetailPage slug={params.slug} />;
  },
});
const shopRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/shop",
  component: ShopPage,
});
const productDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/shop/$productId",
  component: () => {
    const params = useParams({ from: "/shop/$productId" });
    return <ProductDetailPage productId={params.productId} />;
  },
});
const cartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cart",
  component: CartPage,
});
const checkoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/checkout",
  component: CheckoutPage,
});
const trackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/track",
  component: TrackPage,
});
const orderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/order/$orderNumber",
  component: () => {
    const params = useParams({ from: "/order/$orderNumber" });
    return <OrderPage orderNumber={params.orderNumber} />;
  },
});
const legacyTrackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/order/$orderNumber/track",
  component: () => {
    const params = useParams({ from: "/order/$orderNumber/track" });
    if (typeof window !== "undefined") {
      window.location.replace(`/order/${params.orderNumber}?paid=1`);
    }
    return null;
  },
});
const styleguideRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/styleguide",
  component: StyleguidePage,
});
const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacy",
  component: PrivacyPage,
});
const termsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/terms",
  component: TermsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  aboutRoute,
  specialsRoute,
  locationsRoute,
  blogIndexRoute,
  blogDetailRoute,
  shopRoute,
  productDetailRoute,
  cartRoute,
  checkoutRoute,
  trackRoute,
  orderRoute,
  legacyTrackRoute,
  styleguideRoute,
  privacyRoute,
  termsRoute,
]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

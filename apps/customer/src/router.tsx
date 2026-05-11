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

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: MenuPage,
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
  path: "/order/$orderNumber/track",
  component: () => {
    const params = useParams({ from: "/order/$orderNumber/track" });
    return <TrackPage orderNumber={params.orderNumber} />;
  },
});

const routeTree = rootRoute.addChildren([indexRoute, cartRoute, checkoutRoute, trackRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

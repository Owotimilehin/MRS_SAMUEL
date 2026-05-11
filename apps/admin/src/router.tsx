import { createRouter, createRoute, createRootRoute, Outlet } from "@tanstack/react-router";
import { LoginPage } from "./routes/login.js";
import { DashboardPage } from "./routes/owner/dashboard.js";
import { ReviewPage } from "./routes/owner/review.js";
import { ProductsPage } from "./routes/owner/products.js";
import { BranchesPage } from "./routes/owner/branches.js";
import { ProductionRunsPage } from "./routes/factory/production-runs.js";
import { TransfersPage } from "./routes/transfers.js";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => {
    // Send signed-in users to the owner dashboard by default.
    // (Server gates the actual access on the API side.)
    if (typeof window !== "undefined") {
      window.location.replace("/owner/dashboard");
    }
    return null;
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/dashboard",
  component: DashboardPage,
});
const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/review",
  component: ReviewPage,
});
const productsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/products",
  component: ProductsPage,
});
const branchesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/branches",
  component: BranchesPage,
});
const productionRunsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/factory/production-runs",
  component: ProductionRunsPage,
});
const transfersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/transfers",
  component: TransfersPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  dashboardRoute,
  reviewRoute,
  productsRoute,
  branchesRoute,
  productionRunsRoute,
  transfersRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

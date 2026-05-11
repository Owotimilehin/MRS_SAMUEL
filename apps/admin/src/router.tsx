import {
  createRouter,
  createRoute,
  createRootRoute,
  Outlet,
} from "@tanstack/react-router";
import { LoginPage } from "./routes/login.js";
import { DashboardPage } from "./routes/owner/dashboard.js";
import { ReviewPage } from "./routes/owner/review.js";
import { ProductsPage } from "./routes/owner/products.js";
import { BranchesPage } from "./routes/owner/branches.js";
import { ProductionRunsPage } from "./routes/factory/production-runs.js";
import { TransfersPage } from "./routes/transfers.js";
import { SellPage } from "./routes/branch/sell.js";
import { BranchSalesPage } from "./routes/branch/sales.js";
import { BranchTransfersPage } from "./routes/branch/transfers.js";
import { BranchStockPage } from "./routes/branch/stock.js";
import { BranchReturnsPage } from "./routes/branch/returns.js";
import { useEffect, useState, type ReactNode } from "react";

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

/**
 * Branch routes resolve the user's effective branch via /v1/auth/me at
 * mount. Owners that don't have a branch_id assigned fall back to the
 * first active branch (suitable for single-branch v1 operations).
 */
function WithBranchId({
  render,
}: {
  render: (branchId: string) => ReactNode;
}): JSX.Element {
  const [branchId, setBranchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await fetch("/v1/auth/me", { credentials: "include" });
        if (!me.ok) throw new Error("Sign in required");
        const meBody = (await me.json()) as {
          data: { branch_id: string | null };
        };
        if (meBody.data.branch_id) {
          if (!cancelled) setBranchId(meBody.data.branch_id);
          return;
        }
        // Owner with no branch — pick the first active.
        const br = await fetch("/v1/branches", { credentials: "include" });
        const brBody = (await br.json()) as {
          data: Array<{ id: string }>;
        };
        if (brBody.data[0]) {
          if (!cancelled) setBranchId(brBody.data[0].id);
        } else if (!cancelled) {
          setError("No branch configured");
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <main style={{ padding: 24 }}>
        <p style={{ color: "var(--ms-danger)" }}>{error}</p>
        <a href="/login">Sign in</a>
      </main>
    );
  }
  if (!branchId) {
    return (
      <main style={{ padding: 24 }}>
        <p style={{ color: "var(--ms-ink-3)" }}>Loading branch…</p>
      </main>
    );
  }
  return <>{render(branchId)}</>;
}

const branchSellRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/sell",
  component: () => <WithBranchId render={(id) => <SellPage branchId={id} />} />,
});
const branchSalesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/sales",
  component: () => <WithBranchId render={(id) => <BranchSalesPage branchId={id} />} />,
});
const branchTransfersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/transfers",
  component: () => <WithBranchId render={(id) => <BranchTransfersPage branchId={id} />} />,
});
const branchStockRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/stock",
  component: () => <WithBranchId render={(id) => <BranchStockPage branchId={id} />} />,
});
const branchReturnsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/returns",
  component: () => <WithBranchId render={(id) => <BranchReturnsPage branchId={id} />} />,
});
const branchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch",
  component: () => {
    if (typeof window !== "undefined") {
      window.location.replace("/branch/sell");
    }
    return null;
  },
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
  branchRoute,
  branchSellRoute,
  branchSalesRoute,
  branchTransfersRoute,
  branchStockRoute,
  branchReturnsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

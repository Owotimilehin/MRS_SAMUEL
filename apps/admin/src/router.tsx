import {
  createRouter,
  createRoute,
  createRootRoute,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { LoginPage } from "./routes/login.js";
import { DashboardPage } from "./routes/owner/dashboard.js";
import { ReviewPage } from "./routes/owner/review.js";
import { ProductsPage } from "./routes/owner/products.js";
import { ProductDetailPage } from "./routes/owner/product-detail.js";
import { BranchesPage } from "./routes/owner/branches.js";
import { BranchDetailPage } from "./routes/owner/branch-detail.js";
import { FactoriesPage } from "./routes/owner/factories.js";
import { InventoryPage } from "./routes/owner/inventory.js";
import { UsersPage } from "./routes/owner/users.js";
import { AuditLogPage } from "./routes/owner/audit-log.js";
import { BlogPage } from "./routes/owner/blog.js";
import { OrdersPage } from "./routes/owner/orders.js";
import { OrderDetailPage } from "./routes/owner/order-detail.js";
import { CustomersPage } from "./routes/owner/customers.js";
import { ZonesPage } from "./routes/owner/zones.js";
import { OwnerReturnsPage } from "./routes/owner/returns.js";
import { OwnerReturnDetailPage } from "./routes/owner/return-detail.js";
import { DevicesPage } from "./routes/owner/devices.js";
import { SettingsPage } from "./routes/owner/settings.js";
import { ProductionRunsPage } from "./routes/factory/production-runs.js";
import { RunDetailPage } from "./routes/factory/run-detail.js";
import { TransfersPage } from "./routes/transfers.js";
import { TransferDetailPage } from "./routes/transfer-detail.js";
import { SellPage } from "./routes/branch/sell.js";
import { BranchSalesPage } from "./routes/branch/sales.js";
import { SaleDetailPage } from "./routes/branch/sale-detail.js";
import { BranchTransfersPage } from "./routes/branch/transfers.js";
import { BranchStockPage } from "./routes/branch/stock.js";
import { BranchReturnsPage } from "./routes/branch/returns.js";
import { ReturnDetailPage } from "./routes/branch/return-detail.js";
import { BranchClosePage } from "./routes/branch/close.js";
import { BranchClosesPage } from "./routes/branch/closes.js";
import { BranchHomePage } from "./routes/branch/home.js";
import { BranchQueuePage } from "./routes/branch/queue.js";
import { BranchDevicePage } from "./routes/branch/device.js";
import { OwnerClosesPage } from "./routes/owner/closes.js";
import { CloseDetailPage } from "./routes/owner/close-detail.js";
import { NotFound } from "./components/NotFound.js";
import { RequireAuth, useAuthUser } from "./lib/auth.js";
import { useEffect, useState, type ReactNode } from "react";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: NotFound,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

/**
 * Role-aware root redirect. Calls /v1/auth/me once to discover the role, then
 * sends the user where they actually work:
 *  - owner / manager → /owner/dashboard
 *  - factory        → /factory/production-runs
 *  - staff or any user with a branch_id → /branch
 *  - anon → /login
 */
function RootRedirect(): JSX.Element {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/v1/auth/me", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled && typeof window !== "undefined") {
            window.location.replace("/login");
          }
          return;
        }
        const body = (await res.json()) as {
          data: { role: string; branch_id: string | null };
        };
        const dest =
          body.data.role === "owner" || body.data.role === "manager"
            ? "/owner/dashboard"
            : body.data.role === "factory"
              ? "/factory/production-runs"
              : "/branch";
        if (!cancelled && typeof window !== "undefined") {
          window.location.replace(dest);
        }
      } catch {
        if (!cancelled && typeof window !== "undefined") {
          window.location.replace("/login");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <main style={{ padding: 24, color: "var(--ink-soft)" }}>Redirecting…</main>
  );
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RootRedirect,
});

function guarded(node: ReactNode): JSX.Element {
  return <RequireAuth>{node}</RequireAuth>;
}

/**
 * Branch routes resolve the user's effective branch from the auth context.
 * Owners that don't have a branch_id assigned fall back to the first active
 * branch (suitable for single-branch v1 operations).
 */
function WithBranchId({
  render,
}: {
  render: (branchId: string) => ReactNode;
}): JSX.Element {
  const user = useAuthUser();
  const [branchId, setBranchId] = useState<string | null>(user.branch_id);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (branchId) return;
    let cancelled = false;
    void (async () => {
      try {
        const br = await fetch("/v1/branches", { credentials: "include" });
        const brBody = (await br.json()) as { data: Array<{ id: string }> };
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
  }, [branchId]);

  if (error) {
    return (
      <main style={{ padding: 24 }}>
        <p style={{ color: "var(--danger)" }}>{error}</p>
      </main>
    );
  }
  if (!branchId) {
    return (
      <main style={{ padding: 24 }}>
        <p style={{ color: "var(--ink-soft)" }}>Loading branch…</p>
      </main>
    );
  }
  return <>{render(branchId)}</>;
}

// ───── Owner routes ─────
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/dashboard",
  component: () => guarded(<DashboardPage />),
});
const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/review",
  component: () => guarded(<ReviewPage />),
});
const ordersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/orders",
  component: () => guarded(<OrdersPage />),
});
const orderDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/orders/$saleId",
  component: () => {
    const params = useParams({ from: "/owner/orders/$saleId" });
    return guarded(<OrderDetailPage saleId={params.saleId} />);
  },
});
const customersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/customers",
  component: () => guarded(<CustomersPage />),
});
const zonesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/zones",
  component: () => guarded(<ZonesPage />),
});
const ownerReturnsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/returns",
  component: () => guarded(<OwnerReturnsPage />),
});
const ownerReturnDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/returns/$branchId/$returnId",
  component: () => {
    const params = useParams({ from: "/owner/returns/$branchId/$returnId" });
    return guarded(
      <OwnerReturnDetailPage branchId={params.branchId} returnId={params.returnId} />,
    );
  },
});
const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/devices",
  component: () => guarded(<DevicesPage />),
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/settings",
  component: () => guarded(<SettingsPage />),
});
const productsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/products",
  component: () => guarded(<ProductsPage />),
});
const productDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/products/$productId",
  component: () => {
    const params = useParams({ from: "/owner/products/$productId" });
    return guarded(<ProductDetailPage productId={params.productId} />);
  },
});
const branchesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/branches",
  component: () => guarded(<BranchesPage />),
});
const branchDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/branches/$branchId",
  component: () => {
    const params = useParams({ from: "/owner/branches/$branchId" });
    return guarded(<BranchDetailPage branchId={params.branchId} />);
  },
});
const factoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/factories",
  component: () => guarded(<FactoriesPage />),
});
const inventoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/inventory",
  component: () => guarded(<InventoryPage />),
});
const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/users",
  component: () => guarded(<UsersPage />),
});
const auditLogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/audit-log",
  component: () => guarded(<AuditLogPage />),
});
const blogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/blog",
  component: () => guarded(<BlogPage />),
});
const ownerClosesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/closes",
  component: () => guarded(<OwnerClosesPage />),
});
const closeDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/closes/$branchId/$closeId",
  component: () => {
    const params = useParams({ from: "/closes/$branchId/$closeId" });
    return guarded(<CloseDetailPage branchId={params.branchId} closeId={params.closeId} />);
  },
});

// ───── Factory routes ─────
const productionRunsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/factory/production-runs",
  component: () => guarded(<ProductionRunsPage />),
});
const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/factory/production-runs/$runId",
  component: () => {
    const params = useParams({ from: "/factory/production-runs/$runId" });
    return guarded(<RunDetailPage runId={params.runId} />);
  },
});

// ───── Cross-cutting ─────
const transfersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/transfers",
  component: () => guarded(<TransfersPage />),
});
const ownerTransfersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/transfers",
  component: () => guarded(<TransfersPage />),
});
const factoryTransfersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/factory/transfers",
  component: () => guarded(<TransfersPage />),
});
const transferDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/transfers/$transferId",
  component: () => {
    const params = useParams({ from: "/transfers/$transferId" });
    return guarded(<TransferDetailPage transferId={params.transferId} />);
  },
});

// ───── Branch routes ─────
const branchSellRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/sell",
  component: () =>
    guarded(<WithBranchId render={(id) => <SellPage branchId={id} />} />),
});
const branchSalesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/sales",
  component: () =>
    guarded(<WithBranchId render={(id) => <BranchSalesPage branchId={id} />} />),
});
const branchSaleDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/sales/$saleId",
  component: () => {
    const params = useParams({ from: "/branch/sales/$saleId" });
    return guarded(
      <WithBranchId render={(id) => <SaleDetailPage branchId={id} saleId={params.saleId} />} />,
    );
  },
});
const branchTransfersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/transfers",
  component: () =>
    guarded(<WithBranchId render={(id) => <BranchTransfersPage branchId={id} />} />),
});
const branchStockRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/stock",
  component: () =>
    guarded(<WithBranchId render={(id) => <BranchStockPage branchId={id} />} />),
});
const branchReturnsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/returns",
  component: () =>
    guarded(<WithBranchId render={(id) => <BranchReturnsPage branchId={id} />} />),
});
const branchReturnDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/returns/$returnId",
  component: () => {
    const params = useParams({ from: "/branch/returns/$returnId" });
    return guarded(
      <WithBranchId render={(id) => <ReturnDetailPage branchId={id} returnId={params.returnId} />} />,
    );
  },
});
const branchCloseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/close",
  component: () =>
    guarded(<WithBranchId render={(id) => <BranchClosePage branchId={id} />} />),
});
const branchClosesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/closes",
  component: () =>
    guarded(<WithBranchId render={(id) => <BranchClosesPage branchId={id} />} />),
});
const branchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch",
  component: () =>
    guarded(<WithBranchId render={(id) => <BranchHomePage branchId={id} />} />),
});
const branchQueueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/queue",
  component: () =>
    guarded(<WithBranchId render={(id) => <BranchQueuePage branchId={id} />} />),
});
const branchDeviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/device",
  component: () =>
    guarded(<WithBranchId render={(id) => <BranchDevicePage branchId={id} />} />),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  // owner
  dashboardRoute,
  reviewRoute,
  ordersRoute,
  orderDetailRoute,
  customersRoute,
  zonesRoute,
  ownerReturnsRoute,
  ownerReturnDetailRoute,
  devicesRoute,
  settingsRoute,
  productsRoute,
  productDetailRoute,
  branchesRoute,
  branchDetailRoute,
  factoriesRoute,
  inventoryRoute,
  usersRoute,
  auditLogRoute,
  blogRoute,
  ownerClosesRoute,
  closeDetailRoute,
  // factory
  productionRunsRoute,
  runDetailRoute,
  // cross
  transfersRoute,
  ownerTransfersRoute,
  factoryTransfersRoute,
  transferDetailRoute,
  // branch
  branchRoute,
  branchSellRoute,
  branchSalesRoute,
  branchSaleDetailRoute,
  branchTransfersRoute,
  branchStockRoute,
  branchReturnsRoute,
  branchReturnDetailRoute,
  branchCloseRoute,
  branchClosesRoute,
  branchQueueRoute,
  branchDeviceRoute,
]);

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFound,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

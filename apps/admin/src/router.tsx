import {
  createRouter,
  createRoute,
  createRootRoute,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { LoginPage } from "./routes/login.js";
import { NotFound } from "./components/NotFound.js";
import { InlineLoader, PageLoader } from "./components/Spinner.js";
import { RequireAuth, useAuthUser } from "./lib/auth.js";
import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

/**
 * Lazy helper: every route page is a NAMED export, so wrap the dynamic import
 * to surface the named export as a default for React.lazy. Generic preserves
 * the source component's prop shape — pass `<{ id: string }>` etc. at the
 * call site for routes whose pages take params.
 */
function lazyNamed<P = Record<string, never>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loader: () => Promise<Record<string, ComponentType<any>>>,
  name: string,
): ComponentType<P> {
  return lazy(() =>
    loader().then((m) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      default: m[name] as ComponentType<any>,
    })),
  ) as unknown as ComponentType<P>;
}

function L({ children }: { children: ReactNode }): JSX.Element {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>;
}

// ───── Lazy route components ─────
const DashboardPage = lazyNamed(() => import("./routes/owner/dashboard.js"), "DashboardPage");
const ReviewPage = lazyNamed(() => import("./routes/owner/review.js"), "ReviewPage");
const ProductsPage = lazyNamed(() => import("./routes/owner/products.js"), "ProductsPage");
const ProductDetailPage = lazyNamed<{ productId: string }>(
  () => import("./routes/owner/product-detail.js"),
  "ProductDetailPage",
);
const BranchesPage = lazyNamed(() => import("./routes/owner/branches.js"), "BranchesPage");
const BranchDetailPage = lazyNamed<{ branchId: string }>(
  () => import("./routes/owner/branch-detail.js"),
  "BranchDetailPage",
);
const FactoriesPage = lazyNamed(() => import("./routes/owner/factories.js"), "FactoriesPage");
const InventoryPage = lazyNamed(() => import("./routes/owner/inventory.js"), "InventoryPage");
const UsersPage = lazyNamed(() => import("./routes/owner/users.js"), "UsersPage");
const AuditLogPage = lazyNamed(() => import("./routes/owner/audit-log.js"), "AuditLogPage");
const BlogPage = lazyNamed(() => import("./routes/owner/blog.js"), "BlogPage");
const OrdersPage = lazyNamed(() => import("./routes/owner/orders.js"), "OrdersPage");
const OrderDetailPage = lazyNamed<{ saleId: string }>(
  () => import("./routes/owner/order-detail.js"),
  "OrderDetailPage",
);
const CustomersPage = lazyNamed(() => import("./routes/owner/customers.js"), "CustomersPage");
const ZonesPage = lazyNamed(() => import("./routes/owner/zones.js"), "ZonesPage");
const OwnerReturnsPage = lazyNamed(
  () => import("./routes/owner/returns.js"),
  "OwnerReturnsPage",
);
const OwnerReturnDetailPage = lazyNamed<{ branchId: string; returnId: string }>(
  () => import("./routes/owner/return-detail.js"),
  "OwnerReturnDetailPage",
);
const DevicesPage = lazyNamed(() => import("./routes/owner/devices.js"), "DevicesPage");
const SettingsPage = lazyNamed(() => import("./routes/owner/settings.js"), "SettingsPage");
const OwnerClosesPage = lazyNamed(() => import("./routes/owner/closes.js"), "OwnerClosesPage");
const CloseDetailPage = lazyNamed<{ branchId: string; closeId: string }>(
  () => import("./routes/owner/close-detail.js"),
  "CloseDetailPage",
);

const ProductionRunsPage = lazyNamed(
  () => import("./routes/factory/production-runs.js"),
  "ProductionRunsPage",
);
const RunDetailPage = lazyNamed<{ runId: string }>(
  () => import("./routes/factory/run-detail.js"),
  "RunDetailPage",
);

const TransfersPage = lazyNamed(() => import("./routes/transfers.js"), "TransfersPage");
const TransferDetailPage = lazyNamed<{ transferId: string }>(
  () => import("./routes/transfer-detail.js"),
  "TransferDetailPage",
);

const SellPage = lazyNamed<{ branchId: string }>(
  () => import("./routes/branch/sell.js"),
  "SellPage",
);
const BranchSalesPage = lazyNamed<{ branchId: string }>(
  () => import("./routes/branch/sales.js"),
  "BranchSalesPage",
);
const SaleDetailPage = lazyNamed<{ branchId: string; saleId: string }>(
  () => import("./routes/branch/sale-detail.js"),
  "SaleDetailPage",
);
const BranchTransfersPage = lazyNamed<{ branchId: string }>(
  () => import("./routes/branch/transfers.js"),
  "BranchTransfersPage",
);
const BranchStockPage = lazyNamed<{ branchId: string }>(
  () => import("./routes/branch/stock.js"),
  "BranchStockPage",
);
const BranchReturnsPage = lazyNamed<{ branchId: string }>(
  () => import("./routes/branch/returns.js"),
  "BranchReturnsPage",
);
const ReturnDetailPage = lazyNamed<{ branchId: string; returnId: string }>(
  () => import("./routes/branch/return-detail.js"),
  "ReturnDetailPage",
);
const BranchClosePage = lazyNamed<{ branchId: string }>(
  () => import("./routes/branch/close.js"),
  "BranchClosePage",
);
const BranchClosesPage = lazyNamed<{ branchId: string }>(
  () => import("./routes/branch/closes.js"),
  "BranchClosesPage",
);
const BranchHomePage = lazyNamed<{ branchId: string }>(
  () => import("./routes/branch/home.js"),
  "BranchHomePage",
);
const BranchQueuePage = lazyNamed<{ branchId: string }>(
  () => import("./routes/branch/queue.js"),
  "BranchQueuePage",
);
const BranchDevicePage = lazyNamed<{ branchId: string }>(
  () => import("./routes/branch/device.js"),
  "BranchDevicePage",
);

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
          body.data.role === "owner"
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
  return <PageLoader label="Redirecting…" />;
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
    return <InlineLoader label="Finding your branch…" />;
  }
  return <>{render(branchId)}</>;
}

// ───── Owner routes ─────
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/dashboard",
  component: () => guarded(<L><DashboardPage /></L>),
});
const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/review",
  component: () => guarded(<L><ReviewPage /></L>),
});
const ordersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/orders",
  component: () => guarded(<L><OrdersPage /></L>),
});
const orderDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/orders/$saleId",
  component: () => {
    const params = useParams({ from: "/owner/orders/$saleId" });
    return guarded(<L><OrderDetailPage saleId={params.saleId} /></L>);
  },
});
const customersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/customers",
  component: () => guarded(<L><CustomersPage /></L>),
});
const zonesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/zones",
  component: () => guarded(<L><ZonesPage /></L>),
});
const ownerReturnsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/returns",
  component: () => guarded(<L><OwnerReturnsPage /></L>),
});
const ownerReturnDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/returns/$branchId/$returnId",
  component: () => {
    const params = useParams({ from: "/owner/returns/$branchId/$returnId" });
    return guarded(
      <L><OwnerReturnDetailPage branchId={params.branchId} returnId={params.returnId} /></L>,
    );
  },
});
const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/devices",
  component: () => guarded(<L><DevicesPage /></L>),
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/settings",
  component: () => guarded(<L><SettingsPage /></L>),
});
const productsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/products",
  component: () => guarded(<L><ProductsPage /></L>),
});
const productDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/products/$productId",
  component: () => {
    const params = useParams({ from: "/owner/products/$productId" });
    return guarded(<L><ProductDetailPage productId={params.productId} /></L>);
  },
});
const branchesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/branches",
  component: () => guarded(<L><BranchesPage /></L>),
});
const branchDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/branches/$branchId",
  component: () => {
    const params = useParams({ from: "/owner/branches/$branchId" });
    return guarded(<L><BranchDetailPage branchId={params.branchId} /></L>);
  },
});
const factoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/factories",
  component: () => guarded(<L><FactoriesPage /></L>),
});
const inventoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/inventory",
  component: () => guarded(<L><InventoryPage /></L>),
});
const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/users",
  component: () => guarded(<L><UsersPage /></L>),
});
const auditLogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/audit-log",
  component: () => guarded(<L><AuditLogPage /></L>),
});
const blogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/blog",
  component: () => guarded(<L><BlogPage /></L>),
});
const ownerClosesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/closes",
  component: () => guarded(<L><OwnerClosesPage /></L>),
});
const closeDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/closes/$branchId/$closeId",
  component: () => {
    const params = useParams({ from: "/closes/$branchId/$closeId" });
    return guarded(<L><CloseDetailPage branchId={params.branchId} closeId={params.closeId} /></L>);
  },
});

// ───── Factory routes ─────
const productionRunsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/factory/production-runs",
  component: () => guarded(<L><ProductionRunsPage /></L>),
});
const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/factory/production-runs/$runId",
  component: () => {
    const params = useParams({ from: "/factory/production-runs/$runId" });
    return guarded(<L><RunDetailPage runId={params.runId} /></L>);
  },
});

// ───── Cross-cutting ─────
const transfersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/transfers",
  component: () => guarded(<L><TransfersPage /></L>),
});
const ownerTransfersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/owner/transfers",
  component: () => guarded(<L><TransfersPage /></L>),
});
const factoryTransfersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/factory/transfers",
  component: () => guarded(<L><TransfersPage /></L>),
});
const transferDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/transfers/$transferId",
  component: () => {
    const params = useParams({ from: "/transfers/$transferId" });
    return guarded(<L><TransferDetailPage transferId={params.transferId} /></L>);
  },
});

// ───── Branch routes ─────
const branchSellRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/sell",
  component: () =>
    guarded(<L><WithBranchId render={(id) => <SellPage branchId={id} />} /></L>),
});
const branchSalesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/sales",
  component: () =>
    guarded(<L><WithBranchId render={(id) => <BranchSalesPage branchId={id} />} /></L>),
});
const branchSaleDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/sales/$saleId",
  component: () => {
    const params = useParams({ from: "/branch/sales/$saleId" });
    return guarded(
      <L><WithBranchId render={(id) => <SaleDetailPage branchId={id} saleId={params.saleId} />} /></L>,
    );
  },
});
const branchTransfersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/transfers",
  component: () =>
    guarded(<L><WithBranchId render={(id) => <BranchTransfersPage branchId={id} />} /></L>),
});
const branchStockRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/stock",
  component: () =>
    guarded(<L><WithBranchId render={(id) => <BranchStockPage branchId={id} />} /></L>),
});
const branchReturnsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/returns",
  component: () =>
    guarded(<L><WithBranchId render={(id) => <BranchReturnsPage branchId={id} />} /></L>),
});
const branchReturnDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/returns/$returnId",
  component: () => {
    const params = useParams({ from: "/branch/returns/$returnId" });
    return guarded(
      <L><WithBranchId render={(id) => <ReturnDetailPage branchId={id} returnId={params.returnId} />} /></L>,
    );
  },
});
const branchCloseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/close",
  component: () =>
    guarded(<L><WithBranchId render={(id) => <BranchClosePage branchId={id} />} /></L>),
});
const branchClosesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/closes",
  component: () =>
    guarded(<L><WithBranchId render={(id) => <BranchClosesPage branchId={id} />} /></L>),
});
const branchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch",
  component: () =>
    guarded(<L><WithBranchId render={(id) => <BranchHomePage branchId={id} />} /></L>),
});
const branchQueueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/queue",
  component: () =>
    guarded(<L><WithBranchId render={(id) => <BranchQueuePage branchId={id} />} /></L>),
});
const branchDeviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branch/device",
  component: () =>
    guarded(<L><WithBranchId render={(id) => <BranchDevicePage branchId={id} />} /></L>),
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

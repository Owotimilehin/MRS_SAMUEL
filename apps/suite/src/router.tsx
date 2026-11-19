/* eslint-disable react-hooks/rules-of-hooks */
// TanStack Router calls each route's `component` arrow as a render function, so
// hooks are used inside them on purpose (same as the admin app's router).
/**
 * The suite's pages. To add one: write the screen, add a route here, and add a
 * line to NAV in SuiteShell.tsx.
 *
 * The inbox addresses are the same as in the admin app (/inbox, /inbox/<id>,
 * /inbox/reports, /inbox/settings) because the inbox screens link to each other
 * by those addresses.
 */
import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from "react";
import { createRootRoute, createRoute, createRouter, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { NotFound } from "@admin/components/NotFound.js";
import { RouteErrorComponent } from "@admin/components/RouteErrorComponent.js";
import { PageLoader } from "@admin/components/Spinner.js";
import { RequireAuth, useAuthUser } from "@admin/lib/auth.js";
import { LoginPage, type LoginCopy } from "@admin/routes/login.js";
import { ADMIN_URL } from "./suite-host.js";

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

const InboxPage = lazyNamed<{ conversationId?: string }>(() => import("@admin/routes/inbox/index.js"), "InboxPage");
const InboxSettingsPage = lazyNamed(() => import("@admin/routes/inbox/settings.js"), "InboxSettingsPage");
const InboxReportsPage = lazyNamed(() => import("@admin/routes/inbox/reports.js"), "InboxReportsPage");

const SUITE_LOGIN_COPY: LoginCopy = {
  portal: "Business\u00a0Suite",
  line1: "Every customer,",
  line2: "one ",
  line2Em: "place.",
  lede: "Messages, calls and contacts for Mrs. Samuel Fruit Juice. Sign in with the same email and password you use for the shop.",
};

/** Staff without inbox access can sign in, but there is nothing here for them yet. */
function NeedsInbox({ children }: { children: ReactNode }): JSX.Element {
  const user = useAuthUser();
  if (user.capabilities.includes("inbox.view")) return <>{children}</>;
  return (
    <main className="suite-note card">
      <h1>You don&apos;t have access to the suite yet</h1>
      <p>Ask the owner to give your account inbox access. Your shop access is unchanged.</p>
      <a className="btn btn--primary" href={ADMIN_URL}>
        Go to the shop admin
      </a>
    </main>
  );
}

function page(node: ReactNode): JSX.Element {
  return (
    <RequireAuth>
      <NeedsInbox>
        <Suspense fallback={<PageLoader />}>{node}</Suspense>
      </NeedsInbox>
    </RequireAuth>
  );
}

function ToInbox(): JSX.Element {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: "/inbox", replace: true });
  }, [navigate]);
  return <PageLoader label="Opening the inbox…" />;
}

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: NotFound,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: () => <LoginPage defaultDest="/inbox" copy={SUITE_LOGIN_COPY} />,
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ToInbox,
});
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: () => page(<InboxPage />),
});
const inboxConversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox/$conversationId",
  component: () => {
    const params = useParams({ from: "/inbox/$conversationId" });
    return page(<InboxPage conversationId={params.conversationId} />);
  },
});
const inboxSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox/settings",
  component: () => page(<InboxSettingsPage />),
});
const inboxReportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox/reports",
  component: () => page(<InboxReportsPage />),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
  inboxRoute,
  inboxSettingsRoute,
  inboxReportsRoute,
  inboxConversationRoute,
]);

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFound,
  defaultErrorComponent: RouteErrorComponent,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

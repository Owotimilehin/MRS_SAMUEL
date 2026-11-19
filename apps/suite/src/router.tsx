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
import type { Capability } from "@ms/shared";
import { ADMIN_URL } from "./suite-host.js";
import { firstAllowedPage } from "./nav.js";

function lazyNamed<P = Record<string, never>>(
  // A screen file may also export plain helpers (the WhatsApp profile's wording functions), so any module will do.
  loader: () => Promise<object>,
  name: string,
): ComponentType<P> {
  return lazy(() =>
    loader().then((m) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      default: (m as Record<string, ComponentType<any>>)[name] as ComponentType<any>,
    })),
  ) as unknown as ComponentType<P>;
}

const InboxPage = lazyNamed<{ conversationId?: string }>(() => import("@admin/routes/inbox/index.js"), "InboxPage");
const InboxSettingsPage = lazyNamed(() => import("@admin/routes/inbox/settings.js"), "InboxSettingsPage");
const InboxReportsPage = lazyNamed(() => import("@admin/routes/inbox/reports.js"), "InboxReportsPage");
const ChannelsPage = lazyNamed(() => import("./features/channels/ChannelsPage.js"), "ChannelsPage");
const ChatSetupPage = lazyNamed<{ accountId: string }>(() => import("./features/chat-setup/ChatSetupPage.js"), "ChatSetupPage");
const PageDetailsPage = lazyNamed<{ accountId: string }>(() => import("./features/page-details/PageDetailsPage.js"), "PageDetailsPage");
const WhatsAppProfilePage = lazyNamed<{ accountId: string }>(
  () => import("./features/channels/WhatsAppProfilePage.js"),
  "WhatsAppProfilePage",
);

const InsightsPage = lazyNamed(() => import("./features/insights/InsightsPage.js"), "InsightsPage");

const SUITE_LOGIN_COPY: LoginCopy = {
  portal: "Business\u00a0Suite",
  line1: "Every customer,",
  line2: "one ",
  line2Em: "place.",
  lede: "Messages, calls and contacts for Mrs. Samuel Fruit Juice. Sign in with the same email and password you use for the shop.",
};

/** Shown to someone who is signed in but holds no suite permission at all. */
function NoSuiteAccess(): JSX.Element {
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

/**
 * The one page gate (foundation ruling 9.2.2): the page needs `cap`. Someone
 * with no suite permission at all sees the "no access" note; someone with
 * other suite permissions is taken to the first page they may see.
 */
function Needs({ cap, children }: { cap: Capability; children: ReactNode }): JSX.Element {
  const user = useAuthUser();
  if (user.capabilities.includes(cap)) return <>{children}</>;
  if (!firstAllowedPage(user.capabilities)) return <NoSuiteAccess />;
  return <ToFirstPage />;
}

function page(node: ReactNode, cap: Capability): JSX.Element {
  return (
    <RequireAuth>
      <Needs cap={cap}>
        <Suspense fallback={<PageLoader />}>{node}</Suspense>
      </Needs>
    </RequireAuth>
  );
}

/** Land on the first menu page this person may see. */
function ToFirstPage(): JSX.Element {
  const navigate = useNavigate();
  const user = useAuthUser();
  const to = firstAllowedPage(user.capabilities);
  useEffect(() => {
    if (to) void navigate({ to, replace: true });
  }, [navigate, to]);
  if (!to) return <NoSuiteAccess />;
  return <PageLoader label="Opening the suite…" />;
}

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: NotFound,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: () => <LoginPage defaultDest="/" copy={SUITE_LOGIN_COPY} />,
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <RequireAuth>
      <ToFirstPage />
    </RequireAuth>
  ),
});
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: () => page(<InboxPage />, "inbox.view"),
});
const inboxConversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox/$conversationId",
  component: () => {
    const params = useParams({ from: "/inbox/$conversationId" });
    return page(<InboxPage conversationId={params.conversationId} />, "inbox.view");
  },
});
const inboxSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox/settings",
  component: () => page(<InboxSettingsPage />, "inbox.settings"),
});
const inboxReportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox/reports",
  component: () => page(<InboxReportsPage />, "inbox.reports"),
});
const channelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/channels",
  component: () => page(<ChannelsPage />, "channels.manage"),
});

const chatSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/channels/$accountId/chat-setup",
  component: () => {
    const params = useParams({ from: "/channels/$accountId/chat-setup" });
    return page(<ChatSetupPage accountId={params.accountId} />, "channels.manage");
  },
});

const pageDetailsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/channels/$accountId/page",
  component: () => {
    const params = useParams({ from: "/channels/$accountId/page" });
    return page(<PageDetailsPage accountId={params.accountId} />, "channels.manage");
  },
});

// $accountId is the phone line's ID (the same ID Channels lists).
const whatsAppProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/channels/$accountId/whatsapp-profile",
  component: () => {
    const params = useParams({ from: "/channels/$accountId/whatsapp-profile" });
    return page(<WhatsAppProfilePage accountId={params.accountId} />, "channels.manage");
  },
});

const insightsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/insights",
  component: () => page(<InsightsPage />, "insights.view"),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
  inboxRoute,
  inboxSettingsRoute,
  inboxReportsRoute,
  inboxConversationRoute,
  channelsRoute,
  chatSetupRoute,
  pageDetailsRoute,
  whatsAppProfileRoute,
  insightsRoute,
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

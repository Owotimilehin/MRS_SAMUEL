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
import { createRootRoute, createRoute, createRouter, Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { NotFound } from "@admin/components/NotFound.js";
import { RouteErrorComponent } from "@admin/components/RouteErrorComponent.js";
import { PageLoader } from "@admin/components/Spinner.js";
import { RequireAuth, useAuthUser } from "@admin/lib/auth.js";
import { SuiteLoginPage } from "./SuiteLogin.js";
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

const OverviewPage = lazyNamed(() => import("./features/overview/OverviewPage.js"), "OverviewPage");
const CallsPage = lazyNamed(() => import("./features/calls/CallsPage.js"), "CallsPage");
const TasksPage = lazyNamed(() => import("./features/tasks/TasksPage.js"), "TasksPage");
const CommentsPage = lazyNamed<{ threadId?: string }>(() => import("./features/comments/CommentsPage.js"), "CommentsPage");

const TemplatesPage = lazyNamed<{ tab?: "messages" | "forms" }>(() => import("./features/templates/TemplatesPage.js"), "TemplatesPage");
const TemplateEditorPage = lazyNamed<{ templateId: string }>(() => import("./features/templates/TemplateEditorPage.js"), "TemplateEditorPage");
const CataloguePage = lazyNamed(() => import("./features/catalogue/CataloguePage.js"), "CataloguePage");
// Posts to Facebook and Instagram (suite spec 09). These pages need social.publish, not inbox.view.
const PostsPage = lazyNamed(() => import("./features/posts/PostsPage.js"), "PostsPage");
const PostComposer = lazyNamed<{ postId?: string; initialDay?: string }>(() => import("./features/posts/PostComposer.js"), "PostComposer");
const PostDetailPage = lazyNamed<{ postId: string }>(() => import("./features/posts/PostDetailPage.js"), "PostDetailPage");
const InsightsPage = lazyNamed(() => import("./features/insights/InsightsPage.js"), "InsightsPage");
const LeadsPage = lazyNamed<{ leadId?: string }>(() => import("./features/leads/LeadsPage.js"), "LeadsPage");
// Ads (suite spec 12).
const AdsPage = lazyNamed(() => import("./features/ads/AdsPage.js"), "AdsPage");
const AdvertPage = lazyNamed<{ adId: string }>(() => import("./features/ads/AdvertPage.js"), "AdvertPage");
const AdvertForm = lazyNamed<{ draftId?: string }>(() => import("./features/ads/AdvertForm.js"), "AdvertForm");

// Contacts (suite spec 14, Phase A).
const ContactsPage = lazyNamed(() => import("./features/contacts/ContactsPage.js"), "ContactsPage");
const ContactPage = lazyNamed<{ customerId: string }>(() => import("./features/contacts/ContactPage.js"), "ContactPage");
const ContactListsPage = lazyNamed(() => import("./features/contacts/ListsPage.js"), "ListsPage");
const ContactListPage = lazyNamed<{ listId: string }>(() => import("./features/contacts/ListPage.js"), "ListPage");
const ContactImportPage = lazyNamed(() => import("./features/contacts/ImportPage.js"), "ImportPage");

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
  component: () => <SuiteLoginPage defaultDest="/" />,
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

const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/templates",
  component: () => page(<TemplatesPage />, "templates.manage"),
});

// The Forms tab (WhatsApp Flows, suite spec 07). A fixed address, so it wins over /templates/$templateId.
const templateFormsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/templates/forms",
  component: () => page(<TemplatesPage tab="forms" />, "templates.manage"),
});

const templateEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/templates/$templateId",
  component: () => {
    const params = useParams({ from: "/templates/$templateId" });
    return page(<TemplateEditorPage templateId={params.templateId} />, "templates.manage");
  },
});

// Overview: the suite's home page (22 Nov 2026), laid out like the chosen design.
const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/overview",
  component: () => page(<OverviewPage />, "inbox.view"),
});

// Calls, separate from the Inbox (22 Nov 2026): call-backs, the call log and metrics.
const callsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/calls",
  component: () => page(<CallsPage />, "inbox.view"),
});

// Tasks (suite spec 15): reminders that are due or coming up, and snoozed chats.
const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  component: () => page(<TasksPage />, "inbox.view"),
});

// Comments on Facebook and Instagram posts (suite spec 03). Open to people with social.comments, with or without the Inbox.
const commentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/comments",
  component: () => page(<CommentsPage />, "social.comments"),
});

const commentThreadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/comments/$threadId",
  component: () => {
    const params = useParams({ from: "/comments/$threadId" });
    return page(<CommentsPage threadId={params.threadId} />, "social.comments");
  },
});

const catalogueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/catalogue",
  component: () => page(<CataloguePage />, "catalogue.manage"),
});

const postsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/posts",
  component: () => page(<PostsPage />, "social.publish"),
});
// ?day=2026-11-24 comes from the calendar: the day the new post is meant for.
const postNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/posts/new",
  validateSearch: (search: Record<string, unknown>): { day?: string } =>
    typeof search.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.day) ? { day: search.day } : {},
  component: () => {
    const { day } = useSearch({ from: "/posts/new" });
    return page(<PostComposer {...(day ? { initialDay: day } : {})} />, "social.publish");
  },
});
const postDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/posts/$postId",
  component: () => {
    const params = useParams({ from: "/posts/$postId" });
    return page(<PostDetailPage postId={params.postId} />, "social.publish");
  },
});
const postEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/posts/$postId/edit",
  component: () => {
    const params = useParams({ from: "/posts/$postId/edit" });
    return page(<PostComposer postId={params.postId} />, "social.publish");
  },
});

const insightsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/insights",
  component: () => page(<InsightsPage />, "insights.view"),
});

// Leads from Meta lead forms (suite spec 13). A lead opens as a drawer over the list.
const leadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/leads",
  component: () => page(<LeadsPage />, "leads.view"),
});
const leadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/leads/$leadId",
  component: () => {
    const params = useParams({ from: "/leads/$leadId" });
    return page(<LeadsPage leadId={params.leadId} />, "leads.view");
  },
});

// Ads (suite spec 12). Reading needs ads.view; the form also checks ads.manage and the owner's switch itself.
const adsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ads",
  component: () => page(<AdsPage />, "ads.view"),
});
const adsNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ads/new",
  component: () => page(<AdvertForm />, "ads.manage"),
});
const adsDraftRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ads/drafts/$draftId",
  component: () => {
    const params = useParams({ from: "/ads/drafts/$draftId" });
    return page(<AdvertForm draftId={params.draftId} />, "ads.manage");
  },
});
const adsAdvertRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ads/adverts/$adId",
  component: () => {
    const params = useParams({ from: "/ads/adverts/$adId" });
    return page(<AdvertPage adId={params.adId} />, "ads.view");
  },
});

// Contacts (suite spec 14, Phase A). The fixed addresses are declared before /contacts/$customerId.
const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts",
  component: () => page(<ContactsPage />, "contacts.view"),
});
const contactListsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts/lists",
  component: () => page(<ContactListsPage />, "contacts.view"),
});
const contactListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts/lists/$listId",
  component: () => {
    const params = useParams({ from: "/contacts/lists/$listId" });
    return page(<ContactListPage listId={params.listId} />, "contacts.view");
  },
});
const contactImportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts/import",
  component: () => page(<ContactImportPage />, "contacts.manage"),
});
const contactRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts/$customerId",
  component: () => {
    const params = useParams({ from: "/contacts/$customerId" });
    return page(<ContactPage customerId={params.customerId} />, "contacts.view");
  },
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
  templatesRoute,
  templateFormsRoute,
  templateEditorRoute,
  commentsRoute,
  commentThreadRoute,
  catalogueRoute,
  postsRoute,
  postNewRoute,
  postEditRoute,
  postDetailRoute,
  insightsRoute,
  overviewRoute,
  callsRoute,
  tasksRoute,
  leadsRoute,
  leadRoute,
  adsRoute,
  adsNewRoute,
  adsDraftRoute,
  adsAdvertRoute,
  contactsRoute,
  contactListsRoute,
  contactListRoute,
  contactImportRoute,
  contactRoute,
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

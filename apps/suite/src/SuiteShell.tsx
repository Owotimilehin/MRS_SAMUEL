/**
 * The suite's page frame: the menu on the left, a header, and the screen.
 *
 * Built from the same layout classes as the admin app (so it behaves the same
 * on phones, tablets and desktops), with the suite's own menu. To add a section
 * to the menu, add a line to NAV below and a route in router.tsx.
 */
import { lazy, Suspense, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  Bell,
  CalendarClock,
  ChevronsLeft,
  ChevronsUpDown,
  ChevronsRight,
  ClipboardList,
  LayoutDashboard,
  LayoutTemplate,
  LineChart,
  ListTodo,
  LogOut,
  Megaphone,
  Menu,
  MessageCircle,
  MessagesSquare,
  Phone,
  Plus,
  Share2,
  ShoppingBag,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Capability } from "@ms/shared";
import type { FrameProps } from "@admin/lib/app-frame.js";
import { useAuthUser } from "@admin/lib/auth.js";
import { inboxApi, inboxKeys } from "@admin/lib/inbox-api.js";
import { useRailOpen } from "@admin/lib/rail.js";
import { useInboxNotifier } from "@admin/hooks/useInboxNotifier.js";
import { ADMIN_URL } from "./suite-host.js";
import { activeNavTo } from "./nav.js";
import { callKeys, callsApi } from "./features/calls/calls-api.js";
import { commentKeys, commentsApi } from "./features/comments/comments-api.js";
import { useCommentNotifier } from "./features/comments/useCommentNotifier.js";
import { SuiteSearch } from "./features/search/SuiteSearch.js";
import { MetaHealthBanner } from "./features/channels/MetaHealthBanner.js";

/** Macs (and iPads) use ⌘ for shortcuts; Windows and others use Ctrl. */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

const CallBar = lazy(() => import("@admin/components/inbox/CallBar.js").then((m) => ({ default: m.CallBar })));

interface NavItem {
  to: "/overview" | "/inbox" | "/calls" | "/tasks" | "/comments" | "/contacts" | "/catalogue" | "/posts" | "/leads" | "/ads" | "/insights" | "/inbox/reports" | "/inbox/settings" | "/channels" | "/templates";
  label: string;
  Icon: LucideIcon;
  cap: Capability;
}

/** The suite's menu. One line per section, in the order shown. Keep SUITE_PAGES in nav.ts in the same order. */
const NAV: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Conversations",
    items: [
      { to: "/overview", label: "Overview", Icon: LayoutDashboard, cap: "inbox.view" },
      { to: "/inbox", label: "Inbox", Icon: MessagesSquare, cap: "inbox.view" },
      { to: "/calls", label: "Calls", Icon: Phone, cap: "inbox.view" },
      // Suite spec 15: reminders that are due, and snoozed chats.
      { to: "/tasks", label: "Tasks", Icon: ListTodo, cap: "inbox.view" },
      { to: "/comments", label: "Comments", Icon: MessageCircle, cap: "social.comments" },
      // Suite spec 14. Phase B adds "Broadcasts".
      { to: "/contacts", label: "Contacts", Icon: Users, cap: "contacts.view" },
    ],
  },
  {
    heading: "Selling",
    items: [{ to: "/catalogue", label: "Catalogue", Icon: ShoppingBag, cap: "catalogue.manage" }],
  },
  {
    heading: "Marketing",
    items: [
      { to: "/posts", label: "Posts", Icon: CalendarClock, cap: "social.publish" },
      { to: "/leads", label: "Leads", Icon: ClipboardList, cap: "leads.view" },
      { to: "/ads", label: "Ads", Icon: Megaphone, cap: "ads.view" },
    ],
  },
  {
    heading: "Insight",
    items: [
      { to: "/insights", label: "Insights", Icon: LineChart, cap: "insights.view" },
      { to: "/inbox/reports", label: "Reports", Icon: BarChart3, cap: "inbox.reports" },
    ],
  },
  {
    heading: "Set-up",
    items: [
      { to: "/channels", label: "Channels", Icon: Share2, cap: "channels.manage" },
      { to: "/templates", label: "Templates and forms", Icon: LayoutTemplate, cap: "templates.manage" },
      { to: "/inbox/settings", label: "Settings", Icon: SlidersHorizontal, cap: "inbox.settings" },
    ],
  },
];

export function SuiteShell({ children, title, crumb, actions, subtitle, pageName }: FrameProps): JSX.Element {
  const user = useAuthUser();
  const can = (cap: Capability): boolean => user.capabilities.includes(cap);
  const rail = useRailOpen();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The chocolate-orange version of the chosen design (dashboard-v2's dark palette), approved by
  // the owner for every suite page on 22 Nov 2026. Styles: the .suite-choc block in suite.css.
  const chocolate = true;
  const active = activeNavTo(
    pathname,
    NAV.flatMap((s) => s.items.map((i) => i.to)),
  );
  const handle = user.email?.split("@")[0] ?? "";
  const displayName = handle ? handle.charAt(0).toUpperCase() + handle.slice(1) : "Signed in";
  const initials = (handle.replace(/[^a-z]/gi, "").slice(0, 2) || "?").toUpperCase();

  // Unread chats for the Inbox badge; the notifier refreshes it the moment a message lands.
  const unread = useQuery({
    queryKey: inboxKeys.unread,
    enabled: can("inbox.view"),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => (await inboxApi.unread()).messages,
  });

  // Comment threads still waiting, for the Comments badge (suite spec 03).
  const commentsWaiting = useQuery({
    queryKey: commentKeys.unread,
    enabled: can("social.comments"),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: commentsApi.unread,
  });

  // Missed calls nobody has returned yet, for the Calls badge.
  const callbacksWaiting = useQuery({
    queryKey: callKeys.callbacks,
    enabled: can("inbox.view"),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    // Same key and same data as the Calls and Overview pages; only the count is used here.
    queryFn: callsApi.callbacks,
    select: (d) => d.count,
  });

  // My reminders that are due, for the Tasks badge (suite spec 15); the notifier refreshes it when one falls due.
  const remindersDue = useQuery({
    queryKey: inboxKeys.remindersDue,
    enabled: can("inbox.view"),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: inboxApi.remindersDue,
  });

  // Sound, pop-up and tab-title alerts when a customer writes, on every page.
  useInboxNotifier(can("inbox.view"));

  // ⌘K on a Mac, Ctrl+K elsewhere: jump to the search box from anywhere in the suite.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() === "k" && (IS_MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The same for a new comment. The live stream only opens for people with the Inbox (ruling 9.2.12).
  useCommentNotifier(can("social.comments") && can("inbox.view"));

  const waitingChats = unread.data ?? 0;
  const waitingComments = commentsWaiting.data ?? 0;

  async function signOut(): Promise<void> {
    await fetch("/v1/auth/logout", { method: "POST", credentials: "include" });
    window.location.href = "/login";
  }

  // Layout follows docs/mockups/dashboard-v2-mrs-samuel.html: brand, switcher, menu, a card,
  // you; then a top bar (crumbs, search, bell, main action) and a page heading in the content.
  return (
    <div className={`app-shell suite-shell${chocolate ? " suite-choc" : ""}${rail.open ? " nav-open" : ""}`}>
      <div className="app-scrim" aria-hidden="true" onClick={rail.close} />
      <aside className="app-side">
        <button
          type="button"
          className="app-rail-toggle"
          aria-label={rail.open ? "Collapse navigation" : "Expand navigation"}
          aria-expanded={rail.open}
          onClick={rail.toggle}
        >
          {rail.open ? <ChevronsLeft strokeWidth={2} /> : <ChevronsRight strokeWidth={2} />}
        </button>
        <div className="app-brand">
          <div className="app-brand__mark">
            <img src="/brand-logo.png" alt="Mrs. Samuel" />
          </div>
          <div>
            <div className="app-brand__name">Mrs. Samuel</div>
            <div className="app-brand__role">Fruit Juice · Business Suite</div>
          </div>
        </div>

        <a className="suite-switch" href={ADMIN_URL} target="_blank" rel="noreferrer" title="Open the shop's admin app in a new tab">
          <span className="suite-switch__dot" aria-hidden="true" />
          <span className="suite-switch__text">
            Business Suite
            <small>Switch to the shop admin</small>
          </span>
          <ChevronsUpDown size={16} aria-hidden="true" />
        </a>

        <nav className="app-nav">
          {NAV.map((section) => {
            const visible = section.items.filter((i) => can(i.cap));
            if (visible.length === 0) return null;
            return (
              <div key={section.heading} style={{ display: "contents" }}>
                <div className="app-nav__section">{section.heading}</div>
                {visible.map((item) => {
                  const count =
                    item.to === "/inbox"
                      ? unread.data
                      : item.to === "/comments"
                        ? commentsWaiting.data
                        : item.to === "/calls"
                          ? callbacksWaiting.data
                          : item.to === "/tasks"
                            ? remindersDue.data
                            : undefined;
                  const badge = (count ?? 0) > 0 ? count : null;
                  const badgeLabel =
                    item.to === "/comments"
                      ? `${badge} comments waiting`
                      : item.to === "/calls"
                        ? `${badge} missed calls to return`
                        : item.to === "/tasks"
                          ? `${badge} reminders due`
                          : `${badge} unread messages`;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      title={item.label}
                      onClick={rail.close}
                      className={`app-nav__link${active === item.to ? " is-active" : ""}`}
                    >
                      <span className="app-nav__icon">
                        <item.Icon strokeWidth={1.9} />
                      </span>
                      <span>{item.label}</span>
                      {badge != null && (
                        <span className="suite-nav__badge" aria-label={badgeLabel}>
                          {badge > 99 ? "99+" : badge}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {can("inbox.view") && (
          <Link to="/inbox" className="suite-goal" onClick={rail.close}>
            <b>Waiting for a reply</b>
            <p>
              <span className="tabular-nums">{waitingChats}</span> {waitingChats === 1 ? "chat" : "chats"}
              {can("social.comments") && (
                <>
                  {" · "}
                  <span className="tabular-nums">{waitingComments}</span> {waitingComments === 1 ? "comment" : "comments"}
                </>
              )}
            </p>
          </Link>
        )}

        <div className="suite-me">
          <span className="suite-me__avatar" aria-hidden="true">
            {initials}
          </span>
          <span className="suite-me__who">
            <b title={user.email}>{displayName}</b>
            <span>{user.role}</span>
          </span>
          <button type="button" className="suite-me__out" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      <main className="app-main">
        <header className="app-head suite-top">
          <button type="button" className="app-burger" aria-label="Open navigation" onClick={rail.show}>
            <Menu strokeWidth={2} />
          </button>
          <div className="suite-crumbs">
            Mrs. Samuel / {crumb ? <>{crumb} / </> : null}
            <b>{pageName ?? title}</b>
          </div>
          <SuiteSearch inputRef={searchRef} isMac={IS_MAC} />
          {can("inbox.view") && (
            <Link to="/inbox" className="suite-icon-btn" aria-label={waitingChats > 0 ? `${waitingChats} unread messages` : "Inbox"}>
              {waitingChats > 0 && <span className="suite-icon-btn__dot" />}
              <Bell size={17} />
            </Link>
          )}
          {can("social.publish") && !pathname.startsWith("/posts") && (
            <Link to="/posts/new" className="btn btn--primary suite-top__cta">
              <Plus size={16} strokeWidth={2.4} /> New post
            </Link>
          )}
        </header>
        {/* Watchdog (blueprint stage 1): red when the Meta connection is broken, amber when it needs attention. */}
        <MetaHealthBanner enabled={can("inbox.view") || can("channels.manage")} canOpenChannels={can("channels.manage")} />
        <div className="app-body">
          <div className="suite-head">
            <div>
              <h1 className="suite-head__title">{title}</h1>
              {subtitle ? <p className="suite-head__sub">{subtitle}</p> : null}
            </div>
            {actions ? <div className="suite-head__actions">{actions}</div> : null}
          </div>
          {children}
        </div>
      </main>
      {(can("calls.answer") || can("calls.outbound")) && (
        <Suspense fallback={null}>
          <CallBar />
        </Suspense>
      )}
    </div>
  );
}

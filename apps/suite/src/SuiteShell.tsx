/**
 * The suite's page frame: the menu on the left, a header, and the screen.
 *
 * Built from the same layout classes as the admin app (so it behaves the same
 * on phones, tablets and desktops), with the suite's own menu. To add a section
 * to the menu, add a line to NAV below and a route in router.tsx.
 */
import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ExternalLink,
  Megaphone,
  Menu,
  MessagesSquare,
  Share2,
  ShoppingBag,
  SlidersHorizontal,
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

const CallBar = lazy(() => import("@admin/components/inbox/CallBar.js").then((m) => ({ default: m.CallBar })));

interface NavItem {
  to: "/inbox" | "/inbox/reports" | "/inbox/settings" | "/channels" | "/catalogue" | "/ads";
  label: string;
  Icon: LucideIcon;
  cap: Capability;
}

/** The suite's menu. One line per section, in the order shown. Keep SUITE_PAGES in nav.ts in the same order. */
const NAV: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Conversations",
    items: [{ to: "/inbox", label: "Inbox", Icon: MessagesSquare, cap: "inbox.view" }],
  },
  {
    heading: "Selling",
    items: [{ to: "/catalogue", label: "Catalogue", Icon: ShoppingBag, cap: "catalogue.manage" }],
  },
  {
    heading: "Marketing",
    items: [{ to: "/ads", label: "Ads", Icon: Megaphone, cap: "ads.view" }],
  },
  {
    heading: "Insight",
    items: [{ to: "/inbox/reports", label: "Reports", Icon: BarChart3, cap: "inbox.reports" }],
  },
  {
    heading: "Set-up",
    items: [
      { to: "/channels", label: "Channels", Icon: Share2, cap: "channels.manage" },
      { to: "/inbox/settings", label: "Settings", Icon: SlidersHorizontal, cap: "inbox.settings" },
    ],
  },
];

export function SuiteShell({ children, title, crumb, actions }: FrameProps): JSX.Element {
  const user = useAuthUser();
  const can = (cap: Capability): boolean => user.capabilities.includes(cap);
  const rail = useRailOpen();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = activeNavTo(
    pathname,
    NAV.flatMap((s) => s.items.map((i) => i.to)),
  );
  const initial = (user.email?.[0] ?? "?").toUpperCase();

  // Unread chats for the Inbox badge; the notifier refreshes it the moment a message lands.
  const unread = useQuery({
    queryKey: inboxKeys.unread,
    enabled: can("inbox.view"),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => (await inboxApi.unread()).messages,
  });

  // Sound, pop-up and tab-title alerts when a customer writes, on every page.
  useInboxNotifier(can("inbox.view"));

  return (
    <div className={`app-shell suite-shell${rail.open ? " nav-open" : ""}`}>
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
            <div className="app-brand__role">Business Suite</div>
          </div>
        </div>

        <nav className="app-nav">
          {NAV.map((section) => {
            const visible = section.items.filter((i) => can(i.cap));
            if (visible.length === 0) return null;
            return (
              <div key={section.heading} style={{ display: "contents" }}>
                <div className="app-nav__section">{section.heading}</div>
                {visible.map((item) => {
                  const badge = item.to === "/inbox" && (unread.data ?? 0) > 0 ? unread.data : null;
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
                        <span className="suite-nav__badge" aria-label={`${badge} unread messages`}>
                          {badge > 99 ? "99+" : badge}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            );
          })}
          <div className="app-nav__section">Shop</div>
          <a className="app-nav__link" href={ADMIN_URL} target="_blank" rel="noreferrer" title="Open the shop's admin app in a new tab">
            <span className="app-nav__icon">
              <ExternalLink strokeWidth={1.9} />
            </span>
            <span>Shop admin</span>
          </a>
        </nav>

        <div className="app-foot">
          <div className="app-foot__email" title={user.email}>
            {user.email}
          </div>
          <button
            type="button"
            className="app-foot__signout"
            onClick={async () => {
              await fetch("/v1/auth/logout", { method: "POST", credentials: "include" });
              window.location.href = "/login";
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="app-main">
        <header className="app-head">
          <button type="button" className="app-burger" aria-label="Open navigation" onClick={rail.show}>
            <Menu strokeWidth={2} />
          </button>
          <div className="app-head__titles">
            {crumb ? (
              <div className="app-head__crumb">
                <span>{crumb}</span>
                <ChevronRight size={12} strokeWidth={2.4} />
                <span>{title}</span>
              </div>
            ) : null}
            <div className="app-head__title">{title}</div>
          </div>
          <div className="app-head__spacer" style={{ flex: 1 }} />
          {actions}
          <div className="app-head__user">
            <span className="app-head__avatar">{initial}</span>
            <span className="app-head__usermeta">
              <span className="app-head__username">{user.email?.split("@")[0]}</span>
              <span className="app-head__userrole">{user.role}</span>
            </span>
          </div>
        </header>
        <div className="app-body">{children}</div>
      </main>
      {(can("calls.answer") || can("calls.outbound")) && (
        <Suspense fallback={null}>
          <CallBar />
        </Suspense>
      )}
    </div>
  );
}

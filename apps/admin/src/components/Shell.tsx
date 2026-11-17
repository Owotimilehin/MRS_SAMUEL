import { type CSSProperties, type ReactNode, lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useOnlineOrderSignal } from "../hooks/useOnlineOrderSignal.js";
import {
  Menu,
  ChevronsLeft,
  ChevronsRight,
  LayoutDashboard,
  TrendingUp,
  Bell,
  ReceiptText,
  CupSoda,
  Store,
  Factory,
  Boxes,
  IdCard,
  Wallet,
  Tags,
  Milk,
  User,
  ClipboardList,
  TrendingDown,
  Undo2,
  Truck,
  Users,
  ScrollText,
  Smartphone,
  PenLine,
  Settings,
  ShoppingCart,
  Search,
  ChevronRight,
  Gift,
  Inbox,
  Hourglass,
  ShoppingBag,
  MessagesSquare,
  BarChart3,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from "lucide-react";
import { useAuthUser } from "../lib/auth.js";
import { useRailOpen } from "../lib/rail.js";
import { RefreshAppButton } from "./RefreshAppButton.js";
import { api } from "../lib/api.js";
import { inboxApi, inboxKeys } from "../lib/inbox-api.js";
import type { Capability } from "@ms/shared";

// The phone bar (and the Twilio SDK behind it) only loads for people who take
// or make calls.
const CallBar = lazy(() => import("./inbox/CallBar.js").then((m) => ({ default: m.CallBar })));

// One falling droplet's CSS vars, typed for the custom properties the
// .water-field__drop rule reads.
function dropStyle(left: string, s: string, d: string, delay: string): CSSProperties {
  return { left, ["--s" as string]: s, ["--d" as string]: d, ["--delay" as string]: delay };
}

interface NavLink {
  to: string;
  label: string;
  Icon: LucideIcon;
  cap: Capability;
}

// Navigation grouped by business function (6 sections). Each link keeps its
// own capability gate, so a role only ever sees the items it can reach — the
// grouping is purely organizational.
const NAV_OVERVIEW: NavLink[] = [
  { to: "/owner/dashboard", label: "Dashboard", Icon: LayoutDashboard, cap: "reports.view" },
  { to: "/owner/analytics", label: "Analytics", Icon: TrendingUp, cap: "reports.view" },
  { to: "/owner/review", label: "Needs review", Icon: Bell, cap: "orders.manage" },
];
const NAV_INBOX: NavLink[] = [
  { to: "/inbox", label: "Inbox", Icon: MessagesSquare, cap: "inbox.view" },
  { to: "/inbox/reports", label: "Inbox reports", Icon: BarChart3, cap: "inbox.reports" },
  { to: "/inbox/settings", label: "Inbox settings", Icon: SlidersHorizontal, cap: "inbox.settings" },
];
const NAV_SALES: NavLink[] = [
  { to: "/owner/orders", label: "Orders", Icon: ReceiptText, cap: "sales.view" },
  { to: "/owner/online-orders", label: "Online orders", Icon: ShoppingBag, cap: "sales.view" },
  { to: "/owner/preorders", label: "Preorders", Icon: Hourglass, cap: "orders.manage" },
  { to: "/owner/returns", label: "Returns", Icon: Undo2, cap: "returns.approve" },
  { to: "/owner/customers", label: "Customers", Icon: User, cap: "customers.view" },
];
const NAV_PRODUCTS: NavLink[] = [
  { to: "/owner/products", label: "Products", Icon: CupSoda, cap: "products.manage" },
  { to: "/owner/packaging", label: "Packaging", Icon: Milk, cap: "packaging.view" },
  { to: "/owner/bundles", label: "Bundles", Icon: Gift, cap: "marketing.manage" },
  { to: "/owner/inventory", label: "Inventory", Icon: Boxes, cap: "stock.read" },
  { to: "/owner/adjustments", label: "Adjustments", Icon: IdCard, cap: "stock.read" },
  { to: "/owner/transfers", label: "Transfers", Icon: Truck, cap: "transfers.create" },
  { to: "/factory/production-runs", label: "Production runs", Icon: Factory, cap: "production.manage" },
  { to: "/factory/inventory", label: "Factory inventory", Icon: Boxes, cap: "stock.read" },
];
const NAV_FINANCE: NavLink[] = [
  { to: "/owner/bookkeeping", label: "Bookkeeping", Icon: Wallet, cap: "expenses.view" },
  { to: "/owner/variance", label: "Variance & losses", Icon: TrendingDown, cap: "finance.view" },
  { to: "/owner/vendors", label: "Vendors", Icon: Tags, cap: "expenses.view" },
  { to: "/owner/closes", label: "Shift-end reports", Icon: ClipboardList, cap: "close.approve" },
];
const NAV_MARKETING: NavLink[] = [
  { to: "/owner/leads", label: "Leads", Icon: Inbox, cap: "marketing.manage" },
  { to: "/owner/blog", label: "Blog", Icon: PenLine, cap: "blog.manage" },
];
const NAV_ADMIN: NavLink[] = [
  { to: "/owner/branches", label: "Branches", Icon: Store, cap: "branches.manage" },
  { to: "/owner/factories", label: "Factories", Icon: Factory, cap: "branches.manage" },
  { to: "/owner/users", label: "Admin users", Icon: Users, cap: "users.manage" },
  { to: "/owner/devices", label: "Devices", Icon: Smartphone, cap: "devices.view" },
  { to: "/owner/audit-log", label: "Audit log", Icon: ScrollText, cap: "audit.view" },
  { to: "/owner/checkout-log", label: "Checkout log", Icon: ReceiptText, cap: "reports.view" },
  { to: "/owner/settings", label: "Settings", Icon: Settings, cap: "branches.manage" },
];

const ALL_NAV: NavLink[] = [
  ...NAV_OVERVIEW,
  ...NAV_INBOX,
  ...NAV_SALES,
  ...NAV_PRODUCTS,
  ...NAV_FINANCE,
  ...NAV_MARKETING,
  ...NAV_ADMIN,
];

/**
 * The single menu item to highlight for a path: the one whose route is the
 * longest prefix of it. So /inbox/reports lights "Inbox reports" only, while
 * /inbox/<conversation> still lights "Inbox".
 */
function activeNavTo(pathname: string): string | undefined {
  let best: string | undefined;
  for (const { to } of ALL_NAV) {
    if ((pathname === to || pathname.startsWith(to + "/")) && (!best || to.length > best.length)) {
      best = to;
    }
  }
  return best;
}

interface ShellProps {
  children: ReactNode;
  title: string;
  /** Optional breadcrumb area label shown above the title (e.g. "Owner"). */
  crumb?: string;
  actions?: ReactNode;
}

export function Shell({ children, title, crumb, actions }: ShellProps): JSX.Element {
  const user = useAuthUser();
  const can = (cap: Capability): boolean => user.capabilities.includes(cap);
  const initial = (user.email?.[0] ?? "?").toUpperCase();
  // Overlay drawer state. Drives the off-canvas drawer on small screens and the
  // "drawn-out" text rail on md; inert on desktop where the rail is always full.
  const rail = useRailOpen();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeTo = activeNavTo(pathname);

  // Needs-review badge: total items awaiting owner attention (transfer variances +
  // return approvals + payment attention). Fetched once per Shell mount; best-effort
  // (ignored on error so nav doesn't break if the endpoint is slow).
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  useEffect(() => {
    if (!can("orders.manage")) return;
    void (async () => {
      try {
        const res = await api<{
          data: {
            transfer_variances: unknown[];
            return_approvals: unknown[];
            payment_attention?: unknown[];
          };
        }>("/review");
        const count =
          res.data.transfer_variances.length +
          res.data.return_approvals.length +
          (res.data.payment_attention?.length ?? 0);
        setReviewCount(count);
      } catch {
        /* best-effort — don't break nav */
      }
    })();
    // Only run once per mount; `can` is derived from stable user object
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Unread WhatsApp chats for the Inbox badge. Cached across pages and polled
  // gently; the inbox page itself refreshes it live.
  const inboxUnread = useQuery({
    queryKey: inboxKeys.unread,
    enabled: can("inbox.view"),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => (await inboxApi.unread()).messages,
  });

  // Live online-order signal — drives nav badge + new-order banner.
  const signal = useOnlineOrderSignal({ enabled: can("sales.view") });

  const renderSection = (heading: string, items: NavLink[]): JSX.Element | null => {
    const visible = items.filter((i) => can(i.cap));
    if (visible.length === 0) return null;
    return (
      <>
        <div className="app-nav__section">{heading}</div>
        {visible.map((item) => {
          const isReview = item.to === "/owner/review";
          const isOnlineOrders = item.to === "/owner/online-orders";
          const isInbox = item.to === "/inbox";
          const badge = (isReview && reviewCount != null && reviewCount > 0)
            ? reviewCount
            : (isOnlineOrders && signal.count > 0)
              ? signal.count
              : (isInbox && (inboxUnread.data ?? 0) > 0)
                ? inboxUnread.data
                : null;
          return (
            <Link
              key={item.to}
              to={item.to}
              title={item.label}
              onClick={rail.close}
              className={`app-nav__link${activeTo === item.to ? " is-active" : ""}`}
            >
              <span className="app-nav__icon">
                <item.Icon strokeWidth={1.9} />
              </span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {badge != null && (
                <span
                  style={{
                    background: "var(--danger)",
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 700,
                    borderRadius: 999,
                    minWidth: 18,
                    height: 18,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "0 5px",
                    lineHeight: 1,
                  }}
                >
                  {badge}
                </span>
              )}
            </Link>
          );
        })}
      </>
    );
  };

  return (
    <div className={`app-shell${rail.open ? " nav-open" : ""}`}>
      <div className="app-scrim" aria-hidden="true" onClick={rail.close} />
      {/* Ambient water-drop field — sits behind all content (see index.css). */}
      <div className="water-field" aria-hidden="true">
        <div className="water-field__glow water-field__glow--1" />
        <div className="water-field__glow water-field__glow--2" />
        <div className="water-field__glow water-field__glow--3" />
        <span className="water-field__drop" style={dropStyle("12%", "12px", "8s", "0s")} />
        <span className="water-field__drop" style={dropStyle("28%", "18px", "11s", "2s")} />
        <span className="water-field__drop" style={dropStyle("46%", "10px", "7s", "1s")} />
        <span className="water-field__drop" style={dropStyle("63%", "16px", "10s", "3.5s")} />
        <span className="water-field__drop" style={dropStyle("78%", "13px", "9s", "0.6s")} />
        <span className="water-field__drop" style={dropStyle("90%", "20px", "12s", "2.4s")} />
      </div>
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
            <div className="app-brand__role">{user.role}</div>
          </div>
        </div>

        <nav className="app-nav">
          {renderSection("Overview", NAV_OVERVIEW)}
          {renderSection("Customer messages", NAV_INBOX)}
          {renderSection("Sales & customers", NAV_SALES)}
          {renderSection("Products & stock", NAV_PRODUCTS)}
          {renderSection("Finance", NAV_FINANCE)}
          {renderSection("Marketing", NAV_MARKETING)}
          {renderSection("Admin", NAV_ADMIN)}
          {can("pos.preorder") ? (
            <>
              <div className="app-nav__section">Branch tools</div>
              <Link
                to="/branch/sell"
                title="Branch POS"
                onClick={rail.close}
                className="app-nav__link"
                activeProps={{ className: "app-nav__link is-active" }}
              >
                <span className="app-nav__icon">
                  <ShoppingCart strokeWidth={1.9} />
                </span>
                <span>Branch POS</span>
              </Link>
            </>
          ) : null}
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
          <button
            type="button"
            className="app-burger"
            aria-label="Open navigation"
            onClick={rail.show}
          >
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
          <label className="app-head__search">
            <Search />
            <input className="input" type="search" placeholder="Search…" aria-label="Search" />
          </label>
          <RefreshAppButton />
          {actions}
          <div className="app-head__user">
            <span className="app-head__avatar">{initial}</span>
            <span className="app-head__usermeta">
              <span className="app-head__username">{user.email?.split("@")[0]}</span>
              <span className="app-head__userrole">{user.role}</span>
            </span>
          </div>
        </header>
        {signal.newCount > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "var(--primary, #1a5c3b)",
              color: "#fff",
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
            role="alert"
            onClick={() => {
              signal.acknowledge();
              void navigate({ to: "/owner/online-orders" });
            }}
          >
            <span style={{ flex: 1 }}>🔔 New online order — tap to view</span>
            <button
              type="button"
              aria-label="Dismiss"
              style={{
                background: "none",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                display: "flex",
                padding: 4,
              }}
              onClick={(e) => {
                e.stopPropagation();
                signal.acknowledge();
              }}
            >
              <X size={16} strokeWidth={2.5} />
            </button>
          </div>
        )}
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

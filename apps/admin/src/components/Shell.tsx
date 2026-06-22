import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
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
  CalendarClock,
  Gift,
  Inbox,
  Hourglass,
  type LucideIcon,
} from "lucide-react";
import { useAuthUser } from "../lib/auth.js";
import { useRailOpen } from "../lib/rail.js";
import { RefreshAppButton } from "./RefreshAppButton.js";
import { api } from "../lib/api.js";
import type { Capability } from "@ms/shared";

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
const NAV_SALES: NavLink[] = [
  { to: "/owner/orders", label: "Orders", Icon: ReceiptText, cap: "sales.view" },
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
  { to: "/owner/vendors", label: "Vendors", Icon: Tags, cap: "expenses.view" },
  { to: "/owner/closes", label: "Shift-end reports", Icon: ClipboardList, cap: "close.approve" },
];
const NAV_MARKETING: NavLink[] = [
  { to: "/owner/subscriptions", label: "Subscriptions", Icon: CalendarClock, cap: "marketing.manage" },
  { to: "/owner/leads", label: "Leads", Icon: Inbox, cap: "marketing.manage" },
  { to: "/owner/blog", label: "Blog", Icon: PenLine, cap: "blog.manage" },
];
const NAV_ADMIN: NavLink[] = [
  { to: "/owner/branches", label: "Branches", Icon: Store, cap: "branches.manage" },
  { to: "/owner/factories", label: "Factories", Icon: Factory, cap: "branches.manage" },
  { to: "/owner/users", label: "Admin users", Icon: Users, cap: "users.manage" },
  { to: "/owner/devices", label: "Devices", Icon: Smartphone, cap: "devices.view" },
  { to: "/owner/audit-log", label: "Audit log", Icon: ScrollText, cap: "audit.view" },
  { to: "/owner/settings", label: "Settings", Icon: Settings, cap: "branches.manage" },
];

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

  const renderSection = (heading: string, items: NavLink[]): JSX.Element | null => {
    const visible = items.filter((i) => can(i.cap));
    if (visible.length === 0) return null;
    return (
      <>
        <div className="app-nav__section">{heading}</div>
        {visible.map((item) => {
          const badge = item.to === "/owner/review" && reviewCount != null && reviewCount > 0
            ? reviewCount
            : null;
          return (
            <Link
              key={item.to}
              to={item.to}
              title={item.label}
              onClick={rail.close}
              className="app-nav__link"
              activeProps={{ className: "app-nav__link is-active" }}
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
          <div style={{ flex: 1 }} />
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
        <div className="app-body">{children}</div>
      </main>
    </div>
  );
}

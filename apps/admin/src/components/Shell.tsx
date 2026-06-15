import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  LayoutDashboard,
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
  Map as MapIcon,
  User,
  ClipboardList,
  Undo2,
  Truck,
  Users,
  ScrollText,
  Smartphone,
  Settings,
  PenLine,
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
import { RefreshAppButton } from "./RefreshAppButton.js";
import type { Capability } from "@ms/shared";

interface NavLink {
  to: string;
  label: string;
  Icon: LucideIcon;
  cap: Capability;
}

const NAV_OWNER: NavLink[] = [
  { to: "/owner/dashboard", label: "Dashboard", Icon: LayoutDashboard, cap: "reports.view" },
  { to: "/owner/review", label: "Needs review", Icon: Bell, cap: "orders.manage" },
  { to: "/owner/orders", label: "Orders", Icon: ReceiptText, cap: "orders.view" },
  { to: "/owner/preorders", label: "Preorders", Icon: Hourglass, cap: "orders.manage" },
  { to: "/owner/products", label: "Products", Icon: CupSoda, cap: "products.manage" },
  { to: "/owner/branches", label: "Branches", Icon: Store, cap: "branches.manage" },
  { to: "/owner/factories", label: "Factories", Icon: Factory, cap: "branches.manage" },
  { to: "/owner/inventory", label: "Inventory", Icon: Boxes, cap: "reports.view" },
  { to: "/owner/adjustments", label: "Adjustments", Icon: IdCard, cap: "stock.read" },
  { to: "/owner/bookkeeping", label: "Bookkeeping", Icon: Wallet, cap: "expenses.view" },
  { to: "/owner/vendors", label: "Vendors", Icon: Tags, cap: "expenses.view" },
  { to: "/owner/packaging", label: "Packaging", Icon: Milk, cap: "packaging.view" },
  { to: "/owner/zones", label: "Delivery zones", Icon: MapIcon, cap: "zones.manage" },
  { to: "/owner/customers", label: "Customers", Icon: User, cap: "customers.view" },
  { to: "/owner/closes", label: "Daily closes", Icon: ClipboardList, cap: "close.approve" },
  { to: "/owner/returns", label: "Returns", Icon: Undo2, cap: "returns.approve" },
];
const NAV_OPS: NavLink[] = [
  { to: "/factory/production-runs", label: "Production runs", Icon: Factory, cap: "production.manage" },
  { to: "/factory/inventory", label: "Factory inventory", Icon: Boxes, cap: "stock.read" },
  { to: "/owner/transfers", label: "Transfers", Icon: Truck, cap: "transfers.create" },
];
const NAV_ADMIN: NavLink[] = [
  { to: "/owner/users", label: "Admin users", Icon: Users, cap: "users.manage" },
  { to: "/owner/audit-log", label: "Audit log", Icon: ScrollText, cap: "audit.view" },
  { to: "/owner/devices", label: "Devices", Icon: Smartphone, cap: "devices.view" },
  { to: "/owner/settings", label: "Settings", Icon: Settings, cap: "settings.manage" },
  { to: "/owner/blog", label: "Blog", Icon: PenLine, cap: "blog.manage" },
  { to: "/owner/subscriptions", label: "Subscriptions", Icon: CalendarClock, cap: "marketing.manage" },
  { to: "/owner/bundles", label: "Bundles", Icon: Gift, cap: "marketing.manage" },
  { to: "/owner/leads", label: "Leads", Icon: Inbox, cap: "marketing.manage" },
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

  const renderSection = (heading: string, items: NavLink[]): JSX.Element | null => {
    const visible = items.filter((i) => can(i.cap));
    if (visible.length === 0) return null;
    return (
      <>
        <div className="app-nav__section">{heading}</div>
        {visible.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="app-nav__link"
            activeProps={{ className: "app-nav__link is-active" }}
          >
            <span className="app-nav__icon">
              <item.Icon strokeWidth={1.9} />
            </span>
            <span>{item.label}</span>
          </Link>
        ))}
      </>
    );
  };

  return (
    <div className="app-shell">
      <aside className="app-side">
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
          {renderSection("Owner", NAV_OWNER)}
          {renderSection("Operations", NAV_OPS)}
          {renderSection("Admin", NAV_ADMIN)}
          {can("pos.sell") ? (
            <>
              <div className="app-nav__section">Branch tools</div>
              <Link
                to="/branch/sell"
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

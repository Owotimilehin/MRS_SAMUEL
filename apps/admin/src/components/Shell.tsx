import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useAuthUser } from "../lib/auth.js";
import type { Capability } from "@ms/shared";

interface NavLink {
  to: string;
  label: string;
  icon: string;
  cap: Capability;
}

const NAV_OWNER: NavLink[] = [
  { to: "/owner/dashboard", label: "Dashboard", icon: "📊", cap: "reports.view" },
  { to: "/owner/review", label: "Needs review", icon: "🔔", cap: "orders.manage" },
  { to: "/owner/orders", label: "Orders", icon: "🧾", cap: "orders.view" },
  { to: "/owner/products", label: "Products", icon: "🥤", cap: "products.manage" },
  { to: "/owner/branches", label: "Branches", icon: "🏪", cap: "branches.manage" },
  { to: "/owner/factories", label: "Factories", icon: "🏭", cap: "branches.manage" },
  { to: "/owner/inventory", label: "Inventory", icon: "📦", cap: "reports.view" },
  { to: "/owner/adjustments", label: "Adjustments", icon: "🪪", cap: "stock.read" },
  { to: "/owner/bookkeeping", label: "Bookkeeping", icon: "💰", cap: "expenses.view" },
  { to: "/owner/vendors", label: "Vendors", icon: "🏷️", cap: "expenses.view" },
  { to: "/owner/zones", label: "Delivery zones", icon: "🗺️", cap: "zones.manage" },
  { to: "/owner/customers", label: "Customers", icon: "👤", cap: "customers.view" },
  { to: "/owner/closes", label: "Daily closes", icon: "📋", cap: "close.approve" },
  { to: "/owner/returns", label: "Returns", icon: "↩️", cap: "returns.approve" },
];
const NAV_OPS: NavLink[] = [
  { to: "/factory/production-runs", label: "Production runs", icon: "🏭", cap: "production.manage" },
  { to: "/factory/inventory", label: "Factory inventory", icon: "📦", cap: "stock.read" },
  { to: "/owner/transfers", label: "Transfers", icon: "🚚", cap: "transfers.create" },
];
const NAV_ADMIN: NavLink[] = [
  { to: "/owner/users", label: "Admin users", icon: "👥", cap: "users.manage" },
  { to: "/owner/audit-log", label: "Audit log", icon: "📜", cap: "audit.view" },
  { to: "/owner/devices", label: "Devices", icon: "📱", cap: "devices.view" },
  { to: "/owner/settings", label: "Settings", icon: "⚙️", cap: "settings.manage" },
  { to: "/owner/blog", label: "Blog", icon: "✍️", cap: "blog.manage" },
];

interface ShellProps {
  children: ReactNode;
  title: string;
  actions?: ReactNode;
}

export function Shell({ children, title, actions }: ShellProps): JSX.Element {
  const user = useAuthUser();
  const can = (cap: Capability): boolean => user.capabilities.includes(cap);
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
            <span className="app-nav__icon">{item.icon}</span>
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
                <span className="app-nav__icon">🛒</span>
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
          <h1 className="app-head__title">{title}</h1>
          <div style={{ flex: 1 }} />
          {actions}
        </header>
        <div className="app-body">{children}</div>
      </main>
    </div>
  );
}

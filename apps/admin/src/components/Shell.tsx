import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useAuthUser } from "../lib/auth.js";

interface NavLink {
  to: string;
  label: string;
  icon: string;
}

const NAV_OWNER: NavLink[] = [
  { to: "/owner/dashboard", label: "Dashboard", icon: "📊" },
  { to: "/owner/review", label: "Needs review", icon: "🔔" },
  { to: "/owner/orders", label: "Orders", icon: "🧾" },
  { to: "/owner/products", label: "Products", icon: "🥤" },
  { to: "/owner/branches", label: "Branches", icon: "🏪" },
  { to: "/owner/factories", label: "Factories", icon: "🏭" },
  { to: "/owner/inventory", label: "Inventory", icon: "📦" },
  { to: "/owner/zones", label: "Delivery zones", icon: "🗺️" },
  { to: "/owner/customers", label: "Customers", icon: "👤" },
  { to: "/owner/closes", label: "Daily closes", icon: "📋" },
  { to: "/owner/returns", label: "Returns", icon: "↩️" },
];
const NAV_OPS: NavLink[] = [
  { to: "/factory/production-runs", label: "Production runs", icon: "🏭" },
  { to: "/owner/transfers", label: "Transfers", icon: "🚚" },
];
const NAV_ADMIN: NavLink[] = [
  { to: "/owner/users", label: "Admin users", icon: "👥" },
  { to: "/owner/audit-log", label: "Audit log", icon: "📜" },
  { to: "/owner/devices", label: "Devices", icon: "📱" },
  { to: "/owner/settings", label: "Settings", icon: "⚙️" },
  { to: "/owner/blog", label: "Blog", icon: "✍️" },
];

interface ShellProps {
  children: ReactNode;
  title: string;
  actions?: ReactNode;
}

export function Shell({ children, title, actions }: ShellProps): JSX.Element {
  const user = useAuthUser();
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
          <div className="app-nav__section">Owner</div>
          {NAV_OWNER.map((item) => (
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
          <div className="app-nav__section">Operations</div>
          {NAV_OPS.map((item) => (
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
          <div className="app-nav__section">Admin</div>
          {NAV_ADMIN.map((item) => (
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
          <div className="app-nav__section">Branch tools</div>
          <Link
            to="/branch/sell"
            className="app-nav__link"
            activeProps={{ className: "app-nav__link is-active" }}
          >
            <span className="app-nav__icon">🛒</span>
            <span>Branch POS</span>
          </Link>
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

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

interface NavLink {
  to: string;
  label: string;
  icon: string;
}

const NAV: NavLink[] = [
  { to: "/owner/dashboard", label: "Dashboard", icon: "📊" },
  { to: "/owner/review", label: "Needs review", icon: "🔔" },
  { to: "/owner/products", label: "Products", icon: "🥤" },
  { to: "/owner/branches", label: "Branches", icon: "🏪" },
  { to: "/factory/production-runs", label: "Production", icon: "🏭" },
  { to: "/transfers", label: "Transfers", icon: "📦" },
  { to: "/owner/closes", label: "Daily closes", icon: "🧾" },
];

export function Shell({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="grid min-h-screen" style={{ gridTemplateColumns: "240px 1fr" }}>
      <aside
        className="p-5 flex flex-col gap-6"
        style={{ background: "var(--ms-surface-alt)", borderRight: "1px solid var(--ms-border)" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="grid place-items-center rounded-full font-display font-bold text-white"
            style={{ width: 36, height: 36, background: "var(--ms-green-500)" }}
          >
            S
          </div>
          <div className="font-display text-lg font-bold">SMUEL</div>
        </div>

        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium"
              style={{ color: "var(--ms-ink-2)" }}
              activeProps={{
                style: { background: "var(--ms-green-100)", color: "var(--ms-green-900)" },
              }}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="mt-auto">
          <a
            href="/v1/auth/logout"
            onClick={async (e) => {
              e.preventDefault();
              await fetch("/v1/auth/logout", { method: "POST", credentials: "include" });
              window.location.href = "/login";
            }}
            className="text-sm"
            style={{ color: "var(--ms-ink-3)" }}
          >
            Sign out
          </a>
        </div>
      </aside>

      <main className="flex flex-col min-w-0">
        <header
          className="flex items-center gap-4 px-6 py-4"
          style={{ background: "var(--ms-surface)", borderBottom: "1px solid var(--ms-border)" }}
        >
          <h1 className="font-display text-xl font-bold">{title}</h1>
        </header>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}

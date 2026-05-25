import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useSyncState } from "../sync/state.js";
import { startSyncLoop } from "../sync/engine.js";
import { useAuthUser } from "../lib/auth.js";

interface BranchShellProps {
  branchId: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}

const NAV = [
  { to: "/branch", label: "Today", icon: "🏠" },
  { to: "/branch/sell", label: "Sell", icon: "🥤" },
  { to: "/branch/sales", label: "Today's sales", icon: "🧾" },
  { to: "/branch/transfers", label: "Incoming", icon: "📦" },
  { to: "/branch/stock", label: "Stock", icon: "📊" },
  { to: "/branch/returns", label: "Returns", icon: "↩️" },
  { to: "/branch/close", label: "Daily close", icon: "📋" },
  { to: "/branch/closes", label: "Close history", icon: "📚" },
  { to: "/branch/queue", label: "Sync queue", icon: "🔄" },
  { to: "/branch/device", label: "Device", icon: "📱" },
];

export function BranchShell({
  branchId,
  title,
  actions,
  children,
}: BranchShellProps): JSX.Element {
  const sync = useSyncState();
  const user = useAuthUser();
  const [branchName, setBranchName] = useState<string | null>(null);

  useEffect(() => {
    return startSyncLoop(branchId);
  }, [branchId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/v1/branches", { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as {
          data: Array<{ id: string; name: string }>;
        };
        const match = body.data.find((b) => b.id === branchId);
        if (!cancelled && match) setBranchName(match.name);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  return (
    <div className="app-shell">
      <aside className="app-side">
        <div className="app-brand">
          <div className="app-brand__mark">
            <img src="/brand-logo.png" alt="Mrs. Samuel" />
          </div>
          <div>
            <div className="app-brand__name">{branchName ?? "Branch"}</div>
            <div className="app-brand__role">Point of sale</div>
          </div>
        </div>

        <nav className="app-nav">
          {NAV.map((item) => (
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
          <SyncBadge online={sync.online} queued={sync.queued} dead={sync.dead} />
          {actions}
        </header>
        <div className="app-body">{children}</div>
      </main>
    </div>
  );
}

function SyncBadge({
  online,
  queued,
  dead,
}: {
  online: boolean;
  queued: number;
  dead: number;
}): JSX.Element {
  if (dead > 0) {
    return (
      <span className="pill pill--danger" title="Some mutations failed — see /v1/health or contact support.">
        ● Sync errors ({dead})
      </span>
    );
  }
  if (!online) {
    return (
      <span className="pill pill--warning" title="No network — sales saved locally, will sync when online.">
        ● Offline · {queued} queued
      </span>
    );
  }
  if (queued > 0) {
    return (
      <span className="pill pill--warning" title={`${queued} mutations pending`}>
        ● Syncing… ({queued})
      </span>
    );
  }
  return (
    <span className="pill pill--success" title="All sales synced">
      ● Synced
    </span>
  );
}

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Menu, ArrowLeft, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useSyncState } from "../sync/state.js";
import { startSyncLoop } from "../sync/engine.js";
import { useAuthUser } from "../lib/auth.js";
import { useRailOpen } from "../lib/rail.js";
import { RefreshAppButton } from "./RefreshAppButton.js";
import type { Capability } from "@ms/shared";

function dropStyle(left: string, s: string, d: string, delay: string): CSSProperties {
  return { left, ["--s" as string]: s, ["--d" as string]: d, ["--delay" as string]: delay };
}

interface BranchShellProps {
  branchId: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}

// Each link's `cap` is the capability the page's API actually enforces, so the
// nav never shows a till operator a page their token would 403 on. Links with
// no `cap` hit auth-only endpoints (branch stock, close history) or are purely
// local (sync queue, device) and are always shown.
interface BranchNavLink {
  to: string;
  label: string;
  icon: string;
  cap?: Capability;
}

const NAV: BranchNavLink[] = [
  { to: "/branch", label: "Today", icon: "🏠", cap: "sales.view" },
  { to: "/branch/sell", label: "Sell", icon: "🥤", cap: "pos.sell" },
  { to: "/branch/sales", label: "Today's sales", icon: "🧾", cap: "sales.view" },
  { to: "/branch/transfers", label: "Incoming", icon: "📦", cap: "transfers.receive" },
  { to: "/branch/stock", label: "Stock", icon: "📊" },
  { to: "/branch/returns", label: "Returns", icon: "↩️", cap: "returns.create" },
  { to: "/branch/close", label: "Daily close", icon: "📋", cap: "daily_close.submit" },
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
  const rail = useRailOpen();

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
    <div className={`app-shell${rail.open ? " nav-open" : ""}`}>
      <div className="app-scrim" aria-hidden="true" onClick={rail.close} />
      <div className="water-field" aria-hidden="true">
        <div className="water-field__glow water-field__glow--1" />
        <div className="water-field__glow water-field__glow--2" />
        <div className="water-field__glow water-field__glow--3" />
        <span className="water-field__drop" style={dropStyle("14%", "12px", "8s", "0s")} />
        <span className="water-field__drop" style={dropStyle("34%", "18px", "11s", "2s")} />
        <span className="water-field__drop" style={dropStyle("58%", "10px", "7s", "1s")} />
        <span className="water-field__drop" style={dropStyle("80%", "16px", "10s", "3.5s")} />
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
            <div className="app-brand__name">{branchName ?? "Branch"}</div>
            <div className="app-brand__role">Point of sale</div>
          </div>
        </div>

        <nav className="app-nav">
          {/* Owners/admins drop into POS to run a till; give them a one-tap way
           * back to the admin app. Gated on dashboard access so we never link
           * a pure branch_staff member somewhere they can't go. */}
          {user.capabilities.includes("reports.view") ? (
            <Link
              to="/owner/dashboard"
              title="Back to admin"
              onClick={rail.close}
              className="app-nav__link app-nav__back"
            >
              <span className="app-nav__icon">
                <ArrowLeft strokeWidth={2} />
              </span>
              <span>Back to admin</span>
            </Link>
          ) : null}
          {NAV.filter((item) => !item.cap || user.capabilities.includes(item.cap)).map((item) => (
            <Link
              key={item.to}
              to={item.to}
              title={item.label}
              onClick={rail.close}
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
          <button
            type="button"
            className="app-burger"
            aria-label="Open navigation"
            onClick={rail.show}
          >
            <Menu strokeWidth={2} />
          </button>
          <h1 className="app-head__title">{title}</h1>
          <div style={{ flex: 1 }} />
          <SyncBadge online={sync.online} queued={sync.queued} dead={sync.dead} />
          <RefreshAppButton />
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

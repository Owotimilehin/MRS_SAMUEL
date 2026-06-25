import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Menu, ArrowLeft, ChevronsLeft, ChevronsRight, X } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useOnlineOrderSignal } from "../hooks/useOnlineOrderSignal.js";
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
  { to: "/branch/shift-start", label: "Shift start", icon: "🌅", cap: "shift_open.submit" },
  { to: "/branch", label: "Today", icon: "🏠", cap: "sales.view" },
  { to: "/branch/sell", label: "Sell", icon: "🥤", cap: "pos.preorder" },
  { to: "/branch/sales", label: "Today's sales", icon: "🧾", cap: "sales.view" },
  { to: "/branch/transfers", label: "Incoming", icon: "📦", cap: "transfers.receive" },
  { to: "/branch/stock", label: "Stock", icon: "📊" },
  { to: "/branch/online-orders", label: "Online orders", icon: "🛒", cap: "sales.view" },
  { to: "/branch/preorders", label: "Preorders", icon: "📅", cap: "pos.preorder" },
  { to: "/branch/returns", label: "Returns", icon: "↩️", cap: "returns.create" },
  { to: "/branch/close", label: "Shift end", icon: "📋", cap: "daily_close.submit" },
  { to: "/branch/closes", label: "Shift history", icon: "📚" },
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
  const [preorderCount, setPreorderCount] = useState(0);
  const rail = useRailOpen();
  const navigate = useNavigate();

  // Live online-order signal with chime (till-only feature).
  const signal = useOnlineOrderSignal({
    chime: true,
    enabled: !user.capabilities.length || user.capabilities.includes("sales.view"),
  });

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

  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      try {
        const res = await fetch(`/v1/branches/${branchId}/preorders`, { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as { data: unknown[] };
        if (!cancelled) setPreorderCount(Array.isArray(body.data) ? body.data.length : 0);
      } catch {
        /* offline or no access — leave the last known count */
      }
    }
    void refresh();
    const id = window.setInterval(() => void refresh(), 60_000);
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
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
          {NAV.filter((item) => !item.cap || user.capabilities.includes(item.cap)).map((item) => {
            const isOnlineOrders = item.to === "/branch/online-orders";
            const isPreorders = item.to === "/branch/preorders";
            const badge = isOnlineOrders && signal.count > 0
              ? signal.count
              : isPreorders && preorderCount > 0
                ? preorderCount
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
                <span className="app-nav__icon">{item.icon}</span>
                <span style={{ flex: 1 }}>{item.label}</span>
                {badge != null && (
                  <span
                    className="pill pill--danger"
                    style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, minWidth: 20, textAlign: "center" }}
                    aria-label={
                      isOnlineOrders
                        ? `${badge} online orders awaiting fulfilment`
                        : `${badge} preorders awaiting fulfilment`
                    }
                  >
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
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
          <SyncBadge
            online={sync.online}
            queued={sync.queued}
            dead={sync.dead}
            lastPullAt={sync.lastPullAt}
          />
          <RefreshAppButton />
          {actions}
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
              void navigate({ to: "/branch/online-orders" });
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
    </div>
  );
}

// Stock is considered "stale" if the last successful pull is older than this
// while we're online — the till is up but hasn't heard fresh numbers in a while.
const STALE_MS = 10 * 60_000;

/** Compact "updated 2m ago" relative label; "never" if we've not synced yet. */
function relTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "never";
  if (ms < 45_000) return "just now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function SyncBadge({
  online,
  queued,
  dead,
  lastPullAt,
}: {
  online: boolean;
  queued: number;
  dead: number;
  lastPullAt: string | null;
}): JSX.Element {
  const updated = relTime(lastPullAt);
  if (dead > 0) {
    return (
      <span className="pill pill--danger" title="Some mutations failed — see /v1/health or contact support.">
        ● Sync errors ({dead})
      </span>
    );
  }
  if (!online) {
    return (
      <span
        className="pill pill--warning"
        title="No network — showing last known stock; sales save locally and sync when online."
      >
        ● Offline · last update {updated}
        {queued > 0 ? ` · ${queued} queued` : ""}
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
  const stale = lastPullAt != null && Date.now() - new Date(lastPullAt).getTime() > STALE_MS;
  if (stale) {
    return (
      <span
        className="pill pill--warning"
        title="Haven't refreshed stock from the server recently. Tap Resync on the Device page if numbers look off."
      >
        ● Stock may be stale · {updated}
      </span>
    );
  }
  return (
    <span className="pill pill--success" title="Stock and sales in sync with the server">
      ● Synced · {updated}
    </span>
  );
}

import type { ReactNode } from "react";
import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { useSyncState } from "../sync/state.js";
import { startSyncLoop } from "../sync/engine.js";

interface BranchShellProps {
  branchId: string;
  title: string;
  children: ReactNode;
}

const NAV = [
  { to: "/branch/sell", label: "Sell", icon: "🥤" },
  { to: "/branch/sales", label: "Today's sales", icon: "🧾" },
  { to: "/branch/transfers", label: "Incoming", icon: "📦" },
  { to: "/branch/stock", label: "Stock", icon: "📊" },
  { to: "/branch/returns", label: "Returns", icon: "↩️" },
  { to: "/branch/close", label: "Daily close", icon: "🧾" },
];

export function BranchShell({ branchId, title, children }: BranchShellProps): JSX.Element {
  const sync = useSyncState();

  useEffect(() => {
    return startSyncLoop(branchId);
  }, [branchId]);

  return (
    <div className="grid min-h-screen" style={{ gridTemplateColumns: "200px 1fr" }}>
      <aside
        className="p-5 flex flex-col gap-6"
        style={{
          background: "var(--ms-surface-alt)",
          borderRight: "1px solid var(--ms-border)",
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="grid place-items-center rounded-full font-display font-bold text-white"
            style={{ width: 36, height: 36, background: "var(--ms-green-500)" }}
          >
            S
          </div>
          <div>
            <div className="font-display text-lg font-bold">SMUEL</div>
            <div className="text-xs" style={{ color: "var(--ms-ink-3)" }}>
              Ajao Estate
            </div>
          </div>
        </div>

        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium"
              style={{ color: "var(--ms-ink-2)" }}
              activeProps={{
                style: {
                  background: "var(--ms-green-100)",
                  color: "var(--ms-green-900)",
                },
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
          style={{
            background: "var(--ms-surface)",
            borderBottom: "1px solid var(--ms-border)",
          }}
        >
          <h1 className="font-display text-xl font-bold">{title}</h1>
          <div className="flex-1" />
          <SyncBadge online={sync.online} queued={sync.queued} dead={sync.dead} />
        </header>
        <div className="p-6">{children}</div>
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
  let label = "🟢 Synced";
  let title = "All sales synced";
  let bg = "var(--ms-green-100)";
  let fg = "var(--ms-green-900)";

  if (dead > 0) {
    label = `🔴 Sync errors (${dead})`;
    title = "Some mutations failed — see /v1/health or contact support.";
    bg = "rgba(198,58,46,0.15)";
    fg = "var(--ms-danger)";
  } else if (!online) {
    label = `🟠 Offline (${queued} queued)`;
    title = "No network — sales saved locally, will sync when online.";
    bg = "rgba(240,138,26,0.18)";
    fg = "#8b5a0f";
  } else if (queued > 0) {
    label = `🟡 Syncing… (${queued})`;
    title = `${queued} mutations pending`;
    bg = "rgba(255,196,52,0.22)";
    fg = "#7a5a0a";
  }

  if (queued >= 10) label = `⚠️ ${label}`;

  return (
    <span
      title={title}
      className="text-xs font-semibold px-3 py-1.5 rounded-full"
      style={{ background: bg, color: fg }}
    >
      {label}
    </span>
  );
}

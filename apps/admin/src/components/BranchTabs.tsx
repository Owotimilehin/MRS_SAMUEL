import { Link, useRouterState } from "@tanstack/react-router";
import { useAuthUser } from "../lib/auth.js";
import { visibleTabs, type BranchTab } from "./branch-tabs.js";

/** Sub-page tab strip rendered under a grouped page's header. */
export function BranchTabs({ items }: { items: BranchTab[] }): JSX.Element | null {
  const user = useAuthUser();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const tabs = visibleTabs(items, user.capabilities);
  if (tabs.length <= 1) return null;
  return (
    <nav className="branch-tabs" style={{ display: "flex", gap: 6, margin: "0 0 14px", flexWrap: "wrap" }}>
      {tabs.map((t) => {
        const active = path === t.to || path.startsWith(t.to + "/");
        return (
          <Link
            key={t.to}
            to={t.to}
            className={`btn btn--sm ${active ? "btn--primary" : "btn--subtle"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

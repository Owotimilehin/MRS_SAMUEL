import type { Capability } from "@ms/shared";

export interface BranchNavItem {
  to: string;           // where the parent links (the group's primary route)
  label: string;
  icon: string;
  cap?: Capability;     // single required cap
  caps?: Capability[];  // OR: any-of these caps
  group?: string[];     // route prefixes that mark this parent active
}

/** Visible if the user has the single cap, ANY of `caps`, no cap at all, or is the empty-caps owner. */
export function parentVisible(item: BranchNavItem, capabilities: Capability[]): boolean {
  if (capabilities.length === 0) return true;
  if (item.cap) return capabilities.includes(item.cap);
  if (item.caps) return item.caps.some((c) => capabilities.includes(c));
  return true;
}

/** Active when the current path is the parent's `to` or any route in its group (prefix match). */
export function isParentActive(item: BranchNavItem, pathname: string): boolean {
  const prefixes = item.group ?? [item.to];
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * The single parent to highlight for a path: the one with the longest matching group prefix.
 * Tie-breaker ensures /branch/sell → Sell (not Today, whose /branch prefix also matches).
 */
export function activeParent(
  items: BranchNavItem[],
  pathname: string,
): BranchNavItem | undefined {
  let best: BranchNavItem | undefined;
  let bestLen = -1;
  for (const item of items) {
    for (const p of item.group ?? [item.to]) {
      if ((pathname === p || pathname.startsWith(p + "/")) && p.length > bestLen) {
        best = item;
        bestLen = p.length;
      }
    }
  }
  return best;
}

export const BRANCH_NAV: BranchNavItem[] = [
  {
    to: "/branch/sell",
    label: "Sell",
    icon: "🥤",
    cap: "pos.preorder",
    group: ["/branch/sell"],
  },
  {
    to: "/branch",
    label: "Today",
    icon: "🏠",
    cap: "sales.view",
    group: ["/branch", "/branch/sales"],
  },
  {
    to: "/branch/online-orders",
    label: "Orders",
    icon: "🛒",
    caps: ["sales.view", "pos.preorder"],
    group: ["/branch/online-orders", "/branch/preorders"],
  },
  {
    to: "/branch/stock",
    label: "Stock",
    icon: "📊",
    group: ["/branch/stock", "/branch/transfers"],
  },
  {
    to: "/branch/returns",
    label: "Returns",
    icon: "↩️",
    cap: "returns.create",
    group: ["/branch/returns"],
  },
  {
    to: "/branch/shift-start",
    label: "Shift",
    icon: "🗂️",
    caps: ["shift_open.submit", "daily_close.submit"],
    group: ["/branch/shift-start", "/branch/close", "/branch/closes"],
  },
  {
    to: "/branch/device",
    label: "Device",
    icon: "📱",
    group: ["/branch/device", "/branch/queue"],
  },
];

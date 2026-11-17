import type { Capability } from "@ms/shared";

export interface BranchTab {
  to: string;
  label: string;
  cap?: Capability;
}

/** Tabs the user can reach: no cap = always; empty caps = owner sentinel = all. */
/**
 * The single tab to highlight for a path: the one whose route is the longest
 * prefix of it. So /branch/sales lights "Today's sales" only, not also the
 * "Overview" tab at /branch.
 */
export function activeTab(tabs: BranchTab[], pathname: string): BranchTab | undefined {
  let best: BranchTab | undefined;
  for (const t of tabs) {
    if ((pathname === t.to || pathname.startsWith(t.to + "/")) && (!best || t.to.length > best.to.length)) {
      best = t;
    }
  }
  return best;
}

export function visibleTabs(tabs: BranchTab[], capabilities: Capability[]): BranchTab[] {
  if (capabilities.length === 0) return tabs;
  return tabs.filter((t) => !t.cap || capabilities.includes(t.cap));
}

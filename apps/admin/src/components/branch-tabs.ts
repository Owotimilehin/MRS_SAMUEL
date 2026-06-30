import type { Capability } from "@ms/shared";

export interface BranchTab {
  to: string;
  label: string;
  cap?: Capability;
}

/** Tabs the user can reach: no cap = always; empty caps = owner sentinel = all. */
export function visibleTabs(tabs: BranchTab[], capabilities: Capability[]): BranchTab[] {
  if (capabilities.length === 0) return tabs;
  return tabs.filter((t) => !t.cap || capabilities.includes(t.cap));
}

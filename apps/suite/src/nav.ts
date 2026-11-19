/**
 * Which menu line is lit for an address: the one that equals it, or the longest
 * one it sits under. So /inbox/reports lights "Reports" only, while
 * /inbox/<a conversation> lights "Inbox".
 */
export function activeNavTo<T extends string>(pathname: string, links: readonly T[]): T | null {
  let best: T | null = null;
  for (const to of links) {
    if (pathname === to || pathname.startsWith(`${to}/`)) {
      if (!best || to.length > best.length) best = to;
    }
  }
  return best;
}

/**
 * The suite's pages in menu order, with the permission each needs. Keep in
 * step with NAV in SuiteShell.tsx (which adds the labels and icons).
 */
export const SUITE_PAGES = [
  { to: "/inbox", cap: "inbox.view" },
  { to: "/contacts", cap: "contacts.view" },
  { to: "/inbox/reports", cap: "inbox.reports" },
  { to: "/channels", cap: "channels.manage" },
  { to: "/templates", cap: "templates.manage" },
  { to: "/inbox/settings", cap: "inbox.settings" },
] as const;

export type SuitePath = (typeof SUITE_PAGES)[number]["to"];

/**
 * Where a person lands after signing in: the first menu page they may see, or
 * null when they hold no suite permission at all (foundation ruling 9.2.2).
 */
export function firstAllowedPage(capabilities: readonly string[]): SuitePath | null {
  return SUITE_PAGES.find((p) => capabilities.includes(p.cap))?.to ?? null;
}

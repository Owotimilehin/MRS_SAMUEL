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
 *
 * One exception: Call reports and Call settings sit in the menu's Calls
 * section, but here they come straight after Message reports and Message
 * settings, so someone who may only see reports or settings still lands on
 * the message page first, as before.
 */
export const SUITE_PAGES = [
  { to: "/inbox", cap: "inbox.view" },
  { to: "/comments", cap: "social.comments" },
  { to: "/contacts", cap: "contacts.view" },
  { to: "/calls", cap: "inbox.view" },
  { to: "/calls/switchboard", cap: "calls.switchboard" },
  { to: "/catalogue", cap: "catalogue.manage" },
  { to: "/posts", cap: "social.publish" },
  { to: "/leads", cap: "leads.view" },
  { to: "/ads", cap: "ads.view" },
  { to: "/insights", cap: "insights.view" },
  { to: "/inbox/reports", cap: "inbox.reports" },
  { to: "/calls/reports", cap: "inbox.reports" },
  { to: "/channels", cap: "channels.manage" },
  { to: "/templates", cap: "templates.manage" },
  { to: "/inbox/settings", cap: "inbox.settings" },
  { to: "/calls/settings", cap: "inbox.settings" },
] as const;

export type SuitePath = (typeof SUITE_PAGES)[number]["to"];

/**
 * Where a person lands after signing in: the first menu page they may see, or
 * null when they hold no suite permission at all (foundation ruling 9.2.2).
 */
export function firstAllowedPage(capabilities: readonly string[]): SuitePath | null {
  return SUITE_PAGES.find((p) => capabilities.includes(p.cap))?.to ?? null;
}

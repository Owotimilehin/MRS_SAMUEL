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

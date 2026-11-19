/**
 * Chat set-up postback payloads (suite spec 04, section 5.6; foundation ruling 9.2.9).
 *
 * Spec 02 needs describeChatSetupPayload to name a tap in the Inbox, so it is
 * built here first with spec 04's exact signature and pattern. Spec 04 adds
 * the rest of this file (config types, limits, validate, normalise).
 */

/** The payload strings chat set-up publishes. Positions are 1-based at publish time. */
export const CHAT_SETUP_PAYLOAD = {
  start: "ms:v1:start",
  ice: (n: number) => `ms:v1:ice:${n}`,
  menu: (n: number) => `ms:v1:menu:${n}`,
} as const;

const PAYLOAD_RE = /^ms:v1:(start|ice:([1-4])|menu:([1-9]|1[0-9]|20))$/;

/** What a postback payload means, or null when it is not one of ours. */
export function describeChatSetupPayload(
  payload: string | null | undefined,
): { source: "get_started" | "ice_breaker" | "menu"; index: number | null; caption: string; fallbackTitle: string } | null {
  if (typeof payload !== "string") return null;
  const m = PAYLOAD_RE.exec(payload);
  if (!m) return null;
  if (m[1] === "start") return { source: "get_started", index: null, caption: "Tapped Get started", fallbackTitle: "Get started" };
  if (m[2]) {
    const n = Number(m[2]);
    return { source: "ice_breaker", index: n, caption: "Tapped a starter question", fallbackTitle: `Starter question ${n}` };
  }
  const n = Number(m[3]);
  return { source: "menu", index: n, caption: "Tapped a menu button", fallbackTitle: `Menu button ${n}` };
}

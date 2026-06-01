/**
 * An order is "outside Lagos" when a delivery state is set and is not Lagos.
 * Normalized (trimmed, case-insensitive) so "lagos", " Lagos " etc. are all
 * treated as in-area. NULL/undefined/empty ⇒ in Lagos (the default).
 * This MUST be the single source of truth shared by the API, the payment
 * webhook, and the worker so they never diverge.
 */
export function isOutsideLagos(state: string | null | undefined): boolean {
  if (state == null) return false;
  const norm = state.trim().toLowerCase();
  if (norm === "") return false;
  return norm !== "lagos";
}

/**
 * "Quick picks" for the till: the flavour + size combos THIS device sold most
 * recently. Computed from the local outbox — every till sale writes a Confirm
 * row (POST /v1/branches/{id}/sales) whose payload lists the variants and
 * quantities, and those rows are kept after they sync. No server call needed,
 * so it works offline.
 */

export const QUICK_PICK_DAYS = 7;
export const QUICK_PICK_LIMIT = 8;

export interface QuickPickSourceRow {
  endpoint: string;
  method: string;
  payload: unknown;
  created_at_local: number;
}

interface SalePayload {
  items?: Array<{ variant_id?: unknown; quantity?: unknown }>;
}

/**
 * Variant ids ranked by units sold on this branch since `sinceMs`, best first.
 * Ties go to the variant sold most recently. Returns every ranked variant; the
 * caller drops any no longer on the menu and then takes the top few.
 */
export function rankQuickPicks(
  rows: QuickPickSourceRow[],
  opts: { branchId: string; sinceMs: number },
): string[] {
  const endpoint = `/v1/branches/${opts.branchId}/sales`;
  const units = new Map<string, number>();
  const lastSold = new Map<string, number>();
  for (const r of rows) {
    if (r.method !== "POST" || r.endpoint !== endpoint || r.created_at_local < opts.sinceMs) continue;
    const items = (r.payload as SalePayload | null)?.items;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (typeof it.variant_id !== "string") continue;
      const q = typeof it.quantity === "number" && it.quantity > 0 ? it.quantity : 0;
      if (q === 0) continue;
      units.set(it.variant_id, (units.get(it.variant_id) ?? 0) + q);
      lastSold.set(it.variant_id, Math.max(lastSold.get(it.variant_id) ?? 0, r.created_at_local));
    }
  }
  return [...units.keys()].sort(
    (a, b) => units.get(b)! - units.get(a)! || lastSold.get(b)! - lastSold.get(a)! || a.localeCompare(b),
  );
}

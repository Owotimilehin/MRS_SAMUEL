/**
 * Pure helpers that prefill the fulfiller's packaging picker for an online order.
 * All values are only defaults — the fulfiller edits them freely before saving.
 */
export type BagSize = "Small" | "Medium" | "Large";

/** One straw per bottle: sum of quantities across sized (bottle) line items. */
export function defaultStrawCount(items: Array<{ sizeMl: number | null; quantity: number }>): number {
  return items.reduce((sum, it) => sum + (it.sizeMl != null ? it.quantity : 0), 0);
}

/** Bag size from bottle count: <=2 Small, 3-5 Medium, 6+ Large. */
export function defaultBagSize(bottleCount: number): BagSize {
  if (bottleCount <= 2) return "Small";
  if (bottleCount <= 5) return "Medium";
  return "Large";
}

/** Match a bag material to a size by name, falling back to the first bag. */
export function pickBagMaterial<T extends { name: string }>(bags: T[], size: BagSize): T | null {
  const byName = bags.find((b) => b.name.toLowerCase().includes(size.toLowerCase()));
  return byName ?? bags[0] ?? null;
}

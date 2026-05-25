/**
 * Normalize a Nigerian phone number to canonical international form: +234XXXXXXXXXX.
 *
 * Accepts any of:
 *   +234 706 722 0914  → +2347067220914
 *   234 706 722 0914   → +2347067220914
 *   0706 722 0914      → +2347067220914
 *   706 722 0914       → +2347067220914  (10 digits, assume local mobile)
 *   7067220914         → +2347067220914
 *
 * Strips spaces, dashes, parens, dots. Returns null if input doesn't look like
 * a Nigerian phone (wrong length after cleanup).
 */
export function normalizeNigerianPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/[^\d+]/g, "");
  let core = digits;
  if (core.startsWith("+234")) core = core.slice(4);
  else if (core.startsWith("234")) core = core.slice(3);
  else if (core.startsWith("0")) core = core.slice(1);
  // Now core should be 10 digits (the subscriber number).
  if (!/^\d{10}$/.test(core)) return null;
  return `+234${core}`;
}

/**
 * Two phones match if their normalized forms are equal. Useful for tracking
 * lookups where the customer may have entered the number differently than at
 * checkout. Returns false if either side fails to normalize.
 */
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeNigerianPhone(a);
  const nb = normalizeNigerianPhone(b);
  if (!na || !nb) return false;
  return na === nb;
}

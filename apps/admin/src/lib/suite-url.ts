/**
 * Address of the Business Suite, for links out of the admin app. VITE_SUITE_URL
 * when the build sets it; else this address with "admin." swapped for "suite.";
 * else suite.mrssamuel.com.
 */
export function suiteUrl(): string {
  const set = import.meta.env.VITE_SUITE_URL as string | undefined;
  if (set) return set.replace(/\/+$/, "");
  if (typeof window !== "undefined" && /^admin\./.test(window.location.hostname)) {
    return `${window.location.protocol}//${window.location.hostname.replace(/^admin\./, "suite.")}`;
  }
  return "https://suite.mrssamuel.com";
}

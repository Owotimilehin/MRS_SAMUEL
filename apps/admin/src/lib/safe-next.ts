/**
 * Only a same-site path may be used as the post-login `?next=` target.
 * Anything else (javascript:, https://evil, //evil, /\evil) is ignored so a
 * crafted login link can't run code in the app or bounce the user off-site.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // Control characters and backslashes can be normalised by browsers into "//".
  if (/[\u0000-\u001f\\]/.test(raw)) return null;
  try {
    const base = "https://same-site.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

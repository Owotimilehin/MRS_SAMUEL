/**
 * True when a product name is really a bare identifier rather than a human
 * flavour name. Catches the junk rows (8-char hex like "0a5c7c72") and any
 * full/truncated uuid that leaked in from a script run against the DB.
 */
export function looksLikeBareId(name: string): boolean {
  const trimmed = name.trim();
  // 8-char hex chunk (uuid().slice(0,8) fingerprint)
  if (/^[0-9a-f]{8}$/i.test(trimmed)) return true;
  // full uuid or a hyphenated uuid prefix
  if (/^[0-9a-f]{8}-[0-9a-f-]+$/i.test(trimmed)) return true;
  return false;
}

/**
 * Near-duplicate check for page copy (used by the area-page tests).
 *
 * Text is split into lowercase words and then into overlapping 5-word
 * "shingles". Two pages that share a shingle share a 5-word phrase.
 */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:['’][a-z]+)?/g) ?? [];
}

export function shingles(text: string, n = 5): Set<string> {
  const w = wordsOf(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

/**
 * Containment overlap: the share of one page's shingles that also appear on
 * the other, from whichever side it is larger. Stricter than Jaccard (which
 * divides by the union), so "< 0.30" here also means Jaccard < 0.30.
 */
export function overlap(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return Math.max(shared / sa.size, shared / sb.size);
}

/** Jaccard similarity of the two shingle sets (shared / union). */
export function jaccard(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  const union = sa.size + sb.size - shared;
  return union ? shared / union : 0;
}

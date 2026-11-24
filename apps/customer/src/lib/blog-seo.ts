/**
 * SEO helpers for blog posts (roadmap tasks Q1, Q2, Q7).
 *
 * - extractFaqs: turns a post's "## Frequently asked questions" section into
 *   Q&A pairs for FAQPage schema, so the schema always matches what is shown.
 * - pickRelatedProducts: chooses the juices a post links to, by matching the
 *   post's text against each juice's name and ingredients.
 */

export interface Faq {
  q: string;
  a: string;
}

/** Strip the inline markdown our renderer supports, for plain-text schema. */
function plain(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Q&As from the section headed "## Frequently asked questions" (or "## FAQ"):
 * each "### question" followed by its answer paragraphs, up to the next
 * "## " heading or the end of the post. Returns [] when there is no section.
 */
export function extractFaqs(bodyMd: string): Faq[] {
  const lines = bodyMd.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) =>
    /^##\s+(frequently asked questions|faqs?)\s*$/i.test(l.trim()),
  );
  if (start < 0) return [];
  const faqs: Faq[] = [];
  let q: string | null = null;
  let answer: string[] = [];
  const flush = () => {
    const a = plain(answer.join("\n"));
    if (q && a) faqs.push({ q: plain(q), a });
  };
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const heading = /^###\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      q = heading[1]!;
      answer = [];
    } else if (q) {
      answer.push(line);
    }
  }
  flush();
  return faqs;
}

export interface LinkableProduct {
  id: string;
  name: string;
  ingredients: string[];
}

const STOP = new Set([
  "juice",
  "the",
  "and",
  "with",
  "fresh",
  "mrs",
  "samuel",
  "blend",
  "splash",
  "sip",
]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * The `count` products most relevant to a post. A product scores for every
 * distinct word of its name or ingredients that appears in the post, with
 * name words counting double. Ties keep the incoming order (callers pass
 * products sorted by stock), and products with no match fill the remainder.
 */
export function pickRelatedProducts<P extends LinkableProduct>(
  postText: string,
  products: P[],
  count = 3,
): P[] {
  const text = new Set(words(postText));
  const scored = products.map((p, i) => {
    const nameHits = new Set(words(p.name).filter((w) => text.has(w))).size;
    const ingHits = new Set(p.ingredients.flatMap(words).filter((w) => text.has(w))).size;
    return { p, i, score: nameHits * 2 + ingHits };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, count).map((s) => s.p);
}

// apps/customer/src/lib/markdown.tsx
import type { ReactNode } from "react";

/**
 * Render a markdown string limited to the blocks our content uses: ## headings,
 * > blockquotes, and paragraphs (separated by blank lines). Faithful to the
 * previous structured-body styling; intentionally NOT a full markdown parser.
 */
export function renderMarkdown(md: string): ReactNode[] {
  const blocks = md.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block, i) => {
    if (block.startsWith("## ")) {
      return (
        <h2 key={i} className="font-display text-2xl sm:text-3xl text-[color:var(--brand)] mt-10">
          {block.slice(3).trim()}
        </h2>
      );
    }
    if (block.startsWith("> ")) {
      return (
        <blockquote
          key={i}
          className="my-8 border-l-4 border-[color:var(--brand-orange)] pl-5 font-display text-xl sm:text-2xl text-[color:var(--brand)] italic"
        >
          "{block.slice(2).trim()}"
        </blockquote>
      );
    }
    return <p key={i}>{block}</p>;
  });
}

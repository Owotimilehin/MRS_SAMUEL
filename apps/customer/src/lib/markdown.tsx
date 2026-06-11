// apps/customer/src/lib/markdown.tsx
import type { ReactNode } from "react";

/**
 * Render a markdown string covering the blocks our blog content uses:
 * headings (#, ##, ###), > blockquotes, unordered (- ) and ordered (1. ) lists,
 * and paragraphs (separated by blank lines). Inline: **bold** and [text](url).
 * Intentionally lightweight — not a full CommonMark parser, no new dependency.
 */
export function renderMarkdown(md: string): ReactNode[] {
  const blocks = md.split(/\n{2,}/).map((b) => b.replace(/\s+$/, "")).filter((b) => b.trim());
  return blocks.map((block, i) => renderBlock(block, i));
}

function renderBlock(block: string, key: number): ReactNode {
  const trimmed = block.trim();

  // Headings — all rendered with the same section-heading styling.
  const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
  if (heading) {
    return (
      <h2 key={key} className="font-display text-2xl sm:text-3xl text-[color:var(--brand)] mt-10">
        {renderInline(heading[2]!)}
      </h2>
    );
  }

  // Blockquote — one or more lines each starting with "> ".
  if (trimmed.startsWith("> ")) {
    const text = trimmed
      .split("\n")
      .map((l) => l.replace(/^>\s?/, ""))
      .join(" ");
    return (
      <blockquote
        key={key}
        className="my-8 border-l-4 border-[color:var(--brand-orange)] pl-5 font-display text-xl sm:text-2xl text-[color:var(--brand)] italic"
      >
        "{renderInline(text)}"
      </blockquote>
    );
  }

  // Lists — every line starts with "- " (unordered) or "N. " (ordered).
  const lines = trimmed.split("\n");
  const isUnordered = lines.every((l) => /^[-*]\s+/.test(l));
  const isOrdered = lines.every((l) => /^\d+\.\s+/.test(l));
  if (isUnordered || isOrdered) {
    const items = lines.map((l, j) => (
      <li key={j} className="leading-[1.6]">
        {renderInline(l.replace(/^([-*]|\d+\.)\s+/, ""))}
      </li>
    ));
    return isOrdered ? (
      <ol key={key} className="list-decimal pl-6 space-y-2">
        {items}
      </ol>
    ) : (
      <ul key={key} className="list-disc pl-6 space-y-2">
        {items}
      </ul>
    );
  }

  return <p key={key}>{renderInline(trimmed)}</p>;
}

/** Parse a single line for **bold** and [text](url); returns React nodes. */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Matches **bold** or [label](href). Process left-to-right.
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      nodes.push(
        <strong key={k++} className="font-semibold text-[color:var(--brand)]">
          {m[1]}
        </strong>,
      );
    } else if (m[2] !== undefined && m[3] !== undefined) {
      const href = m[3];
      const external = /^https?:\/\//.test(href);
      nodes.push(
        <a
          key={k++}
          href={href}
          {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
          className="font-semibold text-[color:var(--brand-orange)] underline underline-offset-2"
        >
          {m[2]}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

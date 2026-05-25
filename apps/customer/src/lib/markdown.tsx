import { Fragment, type ReactNode } from "react";

/**
 * Minimal, safe-by-default markdown renderer. Handles headings (#, ##, ###),
 * paragraphs, **bold**, *italic*, `inline code`, > blockquote, ordered/unordered
 * lists, and explicit blank-line paragraph breaks. No raw HTML pass-through.
 *
 * Why not react-markdown: zero deps + we control the output styling. This is
 * enough for a marketing blog. Upgrade later if posts get fancier.
 */
export function Markdown({ source }: { source: string }): JSX.Element {
  const blocks = parseBlocks(source);
  return (
    <>
      {blocks.map((block, i) => (
        <Fragment key={i}>{renderBlock(block)}</Fragment>
      ))}
    </>
  );
}

type Block =
  | { kind: "h"; level: 1 | 2 | 3; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "hr" };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let buf: string[] = [];
  let listBuf: string[] = [];
  let listKind: "ul" | "ol" | null = null;

  function flushPara(): void {
    if (buf.length === 0) return;
    const text = buf.join(" ").trim();
    if (text) out.push({ kind: "p", text });
    buf = [];
  }
  function flushList(): void {
    if (listKind && listBuf.length > 0) {
      out.push({ kind: listKind, items: listBuf });
    }
    listKind = null;
    listBuf = [];
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    if (/^---+$/.test(line)) {
      flushPara();
      flushList();
      out.push({ kind: "hr" });
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      flushPara();
      flushList();
      out.push({ kind: "h", level: h[1]!.length as 1 | 2 | 3, text: h[2]! });
      continue;
    }
    if (line.startsWith("> ")) {
      flushPara();
      flushList();
      out.push({ kind: "quote", text: line.slice(2) });
      continue;
    }
    const ul = line.match(/^[-*]\s+(.+)$/);
    if (ul) {
      flushPara();
      if (listKind !== "ul") flushList();
      listKind = "ul";
      listBuf.push(ul[1]!);
      continue;
    }
    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      flushPara();
      if (listKind !== "ol") flushList();
      listKind = "ol";
      listBuf.push(ol[1]!);
      continue;
    }
    if (listKind) flushList();
    buf.push(line);
  }
  flushPara();
  flushList();
  return out;
}

function renderBlock(b: Block): ReactNode {
  switch (b.kind) {
    case "h":
      if (b.level === 1) return <h1 className="ms-md__h1">{inline(b.text)}</h1>;
      if (b.level === 2) return <h2 className="ms-md__h2">{inline(b.text)}</h2>;
      return <h3 className="ms-md__h3">{inline(b.text)}</h3>;
    case "p":
      return <p className="ms-md__p">{inline(b.text)}</p>;
    case "ul":
      return (
        <ul className="ms-md__ul">
          {b.items.map((it, i) => (
            <li key={i}>{inline(it)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="ms-md__ol">
          {b.items.map((it, i) => (
            <li key={i}>{inline(it)}</li>
          ))}
        </ol>
      );
    case "quote":
      return <blockquote className="ms-md__quote">{inline(b.text)}</blockquote>;
    case "hr":
      return <hr className="ms-md__hr" />;
  }
}

/**
 * Inline transforms: **bold**, *italic*, `code`, [text](url). Anything else
 * passes through as plain text. URLs are forced to noopener for safety.
 */
function inline(text: string): ReactNode {
  // Order matters: links first (so [text](url) isn't parsed as italic via *url*).
  const parts: ReactNode[] = [];
  const re = /(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) {
      parts.push(
        <a key={key++} href={m[3]!} target="_blank" rel="noopener noreferrer">
          {m[2]}
        </a>,
      );
    } else if (m[4]) {
      parts.push(<strong key={key++}>{m[5]}</strong>);
    } else if (m[6]) {
      parts.push(<em key={key++}>{m[7]}</em>);
    } else if (m[8]) {
      parts.push(<code key={key++}>{m[9]}</code>);
    }
    last = m.index + m[0]!.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

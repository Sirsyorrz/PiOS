import { Fragment, type ReactNode } from "react";
import { TranscriptImage } from "./image-view.tsx";

/**
 * A deliberately small CommonMark subset: the shapes an agent actually emits
 * in chat. No HTML pass-through, so nothing rendered here can escape React's
 * escaping. Unterminated fences render as code, because text arrives midway
 * through a stream and half a block must still look like the block it is.
 */
export function Markdown({ text }: { text: string }) {
  return <>{renderBlocks(text)}</>;
}

type Block =
  | { kind: "code"; lang: string; code: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "para"; text: string };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBER = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "para", text: paragraph.join("\n") });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1]!;
      const code: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        const end = FENCE.exec(lines[i]!);
        if (end && end[1]![0] === marker[0] && end[1]!.length >= marker.length) break;
        code.push(lines[i]!);
      }
      blocks.push({ kind: "code", lang: fence[2] ?? "", code: code.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBER.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = !bullet;
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const item = ordered ? NUMBER.exec(lines[i]!) : BULLET.exec(lines[i]!);
        if (item) {
          items.push(item[1]!);
          continue;
        }
        // A bare indented line continues the item above it.
        if (items.length && /^\s+\S/.test(lines[i]!)) {
          items[items.length - 1] += "\n" + lines[i]!.trim();
          continue;
        }
        break;
      }
      i--;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const quoted: string[] = [quote[1]!];
      for (i++; i < lines.length; i++) {
        const next = QUOTE.exec(lines[i]!);
        if (!next) break;
        quoted.push(next[1]!);
      }
      i--;
      blocks.push({ kind: "quote", text: quoted.join("\n") });
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

function renderBlocks(text: string): ReactNode[] {
  return parseBlocks(text).map((block, index) => {
    switch (block.kind) {
      case "code":
        return (
          <pre key={index} className="md-code" data-lang={block.lang || undefined}>
            <code>{block.code}</code>
          </pre>
        );
      case "heading": {
        const Tag = `h${Math.min(block.level + 2, 6)}` as "h3";
        return <Tag key={index} className="md-heading">{renderInline(block.text)}</Tag>;
      }
      case "rule":
        return <hr key={index} className="md-rule" />;
      case "list":
        return block.ordered
          ? (
            <ol key={index} className="md-list">
              {block.items.map((item, n) => <li key={n}>{renderInline(item)}</li>)}
            </ol>
          )
          : (
            <ul key={index} className="md-list">
              {block.items.map((item, n) => <li key={n}>{renderInline(item)}</li>)}
            </ul>
          );
      case "quote":
        return <blockquote key={index} className="md-quote">{renderInline(block.text)}</blockquote>;
      case "para":
        return <p key={index}>{renderInline(block.text)}</p>;
    }
  });
}

// Ordered by precedence: code spans win, so backticks protect their contents.
const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![*\w])\*([^*\n]+?)\*(?!\*)|(?<![_\w])_([^_\n]+?)_(?!\w)|~~([\s\S]+?)~~|!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|\[([^\]]*)\]\(([^)\s]+)[^)]*\)|(https?:\/\/[^\s<>()]+)/g;

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index!;
    if (at > last) out.push(text.slice(last, at));
    last = at + m[0].length;
    const key = out.length;
    if (m[2] !== undefined) out.push(<code key={key} className="md-inline-code">{m[2].trim()}</code>);
    else if (m[3] ?? m[4]) out.push(<strong key={key}>{renderInline((m[3] ?? m[4])!)}</strong>);
    else if (m[5] ?? m[6]) out.push(<em key={key}>{renderInline((m[5] ?? m[6])!)}</em>);
    else if (m[7]) out.push(<del key={key}>{renderInline(m[7])}</del>);
    // An agent writes `![alt](src/logo.png)` with a path on its own machine,
    // so the src is resolved by the daemon rather than by the browser.
    else if (m[9]) out.push(<TranscriptImage key={key} src={m[9]} alt={m[8] ?? ""} />);
    else if (m[11]) out.push(<Link key={key} href={m[11]}>{renderInline(m[10] ?? "")}</Link>);
    else if (m[12]) out.push(<Link key={key} href={m[12]}>{m[12]}</Link>);
  }
  if (last < text.length) out.push(text.slice(last));
  return out.map((node, i) => typeof node === "string" ? <Fragment key={i}>{node}</Fragment> : node);
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  // Only navigable schemes; javascript: and data: links never reach the DOM.
  const safe = /^https?:\/\//i.test(href);
  if (!safe) return <>{children}</>;
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}

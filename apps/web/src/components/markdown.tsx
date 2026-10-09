import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { copyText } from "../clipboard.ts";
import { TranscriptImage } from "./image-view.tsx";
import { CheckIcon, CopyIcon } from "./icons.tsx";

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
  | { kind: "table"; align: Align[]; header: string[]; rows: string[][] }
  | { kind: "para"; text: string };

type Align = "left" | "center" | "right" | null;

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBER = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s{0,3}\|.*$|^\s{0,3}[^|\n]*\|/;
const TABLE_DELIM = /^\s{0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

// Pipes inside code spans belong to the cell, not to the table grid, and a
// backslash escapes a literal pipe.
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let fence = 0;
  const trimmed = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|\s*$/, "");
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "\\" && trimmed[i + 1] === "|") {
      cell += "|";
      i++;
      continue;
    }
    if (ch === "`") {
      let run = 0;
      while (trimmed[i + run] === "`") run++;
      if (!fence) fence = run;
      else if (fence === run) fence = 0;
      cell += "`".repeat(run);
      i += run - 1;
      continue;
    }
    if (ch === "|" && !fence) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function parseAlign(line: string): Align[] {
  return splitRow(line).map((spec) => {
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

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

    // A table is only a table once its delimiter row has arrived; mid-stream
    // the header alone stays a paragraph rather than flickering into a grid.
    const delim = lines[i + 1] ?? "";
    if (
      line.includes("|") && TABLE_ROW.test(line) &&
      delim.includes("|") && TABLE_DELIM.test(delim)
    ) {
      const header = splitRow(line);
      const align = parseAlign(delim);
      if (align.length === header.length) {
        flush();
        const rows: string[][] = [];
        for (i += 2; i < lines.length; i++) {
          const next = lines[i]!;
          if (!next.trim() || !next.includes("|")) break;
          const cells = splitRow(next);
          cells.length = header.length;
          rows.push(Array.from(cells, (c) => c ?? ""));
        }
        i--;
        blocks.push({ kind: "table", align, header, rows });
        continue;
      }
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
        return <CodeBlock key={index} lang={block.lang} code={block.code} />;
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
      case "table":
        return (
          <div key={index} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {block.header.map((cell, n) => (
                    <th key={n} style={{ textAlign: block.align[n] ?? undefined }}>
                      {renderInline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, n) => (
                      <td key={n} style={{ textAlign: block.align[n] ?? undefined }}>
                        {renderInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    if (!(await copyText(code))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="md-code-wrap">
      <pre className="md-code" data-lang={lang || undefined}>
        <code>{code}</code>
      </pre>
      <button
        type="button"
        className="icon sm ghost md-code-copy"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon width="15" height="15" /> : <CopyIcon width="15" height="15" />}
      </button>
    </div>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  // Only navigable schemes; javascript: and data: links never reach the DOM.
  const safe = /^https?:\/\//i.test(href);
  if (!safe) return <>{children}</>;
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}

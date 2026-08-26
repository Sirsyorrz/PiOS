import type { ToolExecution } from "@pios/protocol";
import { useState } from "react";
import { diffLines, editBlocks } from "../diff.ts";
import { ChevronRightIcon, ToolIcon } from "./icons.tsx";

/**
 * One tool call, correlated on `toolCallId`.
 *
 * Args and result arrive from different events (and sometimes from the
 * persisted transcript instead), so the row renders whatever is known and
 * leaves the rest blank rather than waiting for a complete pair.
 */
export function ToolCard({ tool, cwd }: { tool: ToolExecution; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const edits = editBlocks(tool.args);
  const rest = leftoverArgs(tool.args);
  const headline = summarise(tool);

  return (
    <div className={`tool ${tool.status} ${tool.isError ? "error" : ""}`}>
      <button
        type="button"
        className="tool-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ToolIcon name={tool.toolName} className="tool-glyph" width={16} height={16} />
        <span className="tool-name">{tool.toolName}</span>
        <span className="muted line">{shortenPreview(headline, cwd)}</span>
        {tool.isError ? <span className="tool-status">failed</span> : null}
        {tool.status === "running" ? <span className="spinner" /> : null}
        <ChevronRightIcon className={`caret ${open ? "open" : ""}`} width={16} height={16} />
      </button>

      {open ? (
        <div className="tool-body">
          {/* Repeated in full: the row above clips it to one line. */}
          {headline ? <pre className="code">{headline}</pre> : null}
          {edits.map((edit, index) =>
            edit.oldText === null ? (
              <pre key={index} className="code">
                {edit.newText}
              </pre>
            ) : (
              <Diff key={index} before={edit.oldText} after={edit.newText} />
            ),
          )}
          {rest ? <pre className="args">{rest}</pre> : null}
          <pre className="result">{resultText(tool) || "(no output yet)"}</pre>
        </div>
      ) : null}
    </div>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="diff">
      {diffLines(before, after).map((line, index) => (
        <div key={index} className={`diff-${line.kind}`}>
          {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
          {line.text}
        </div>
      ))}
    </pre>
  );
}

/** Shown on the row itself, so it is never repeated in the expanded body. */
const HEADLINE_KEYS = ["command", "path", "file_path", "pattern", "query", "url"] as const;

/**
 * Absolute paths eat the whole preview line with a prefix the user already
 * knows. Both the `cd` prefix of a command and a bare path argument (read,
 * write, edit) are shortened against the session cwd; the expanded body of
 * the card still shows the argument verbatim.
 */
function shortenPreview(headline: string, cwd?: string): string {
  const match = /^cd\s+('[^']*'|"[^"]*"|\S+)\s+&&\s+/.exec(headline);
  if (match) {
    const rest = headline.slice(match[0].length);
    const shown = shortenPath(unquote(match[1] ?? ""), cwd);
    return shown === "." ? rest : `cd ${shown} && ${rest}`;
  }
  if (/^[~/]/.test(headline) && !/\s/.test(headline)) return shortenPath(headline, cwd);
  return headline;
}

/** `.` for the cwd itself, cwd-relative when inside it, else `~`-collapsed. */
function shortenPath(path: string, cwd?: string): string {
  const target = absolutePath(path, cwd);
  const base = cwd ? trimSlash(cwd) : "";
  if (base && target === base) return ".";
  if (base && target.startsWith(`${base}/`)) return target.slice(base.length + 1);
  return collapseHome(target);
}

function unquote(value: string): string {
  const quoted = /^'(.*)'$/.exec(value) ?? /^"(.*)"$/.exec(value);
  return quoted?.[1] ?? value;
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Enough of a resolver for display: no symlinks, no filesystem. */
function absolutePath(path: string, cwd?: string): string {
  const base = path.startsWith("/") || path.startsWith("~") || !cwd
    ? path
    : `${trimSlash(cwd)}/${path.replace(/^\.\//, "")}`;
  const parts: string[] = [];
  for (const part of trimSlash(base).split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const joined = parts.join("/");
  return base.startsWith("/") ? `/${joined}` : joined;
}

/** The home prefix is inferred from the path itself; the client has no $HOME. */
function collapseHome(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+/, "~");
}

/** Rendered as a diff or a code block, so it is not JSON to print again. */
const BLOCK_KEYS = ["edits", "oldText", "old_text", "old", "newText", "new_text", "new", "content"];

function summarise(tool: ToolExecution): string {
  const args = tool.args as Record<string, unknown> | undefined;
  if (!args) return "";
  for (const key of HEADLINE_KEYS) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * The arguments no other part of the card shows, as `key: value` lines rather
 * than a JSON object: the braces and quotes carry nothing on a phone screen.
 */
function leftoverArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const skip = new Set<string>([...HEADLINE_KEYS, ...BLOCK_KEYS]);
  return Object.entries(args as Record<string, unknown>)
    .filter(([key, value]) => value !== undefined && !skip.has(key))
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : stringify(value)}`)
    .join("\n");
}


function resultText(tool: ToolExecution): string {
  const payload = (tool.result ?? tool.partialResult) as
    | { content?: { type: string; text?: string }[] }
    | undefined;
  if (!payload?.content) return "";
  return payload.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
    .join("\n");
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

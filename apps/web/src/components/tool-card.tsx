import type { ImageContent, ToolExecution } from "@pios/protocol";
import { useLayoutEffect, useRef, useState } from "react";
import { diffLines, editBlocks } from "../diff.ts";
import { ChevronRightIcon, ToolIcon } from "./icons.tsx";
import { TranscriptImage } from "./image-view.tsx";

/**
 * One tool call, correlated on `toolCallId`.
 *
 * Args and result arrive from different events (and sometimes from the
 * persisted transcript instead), so the row renders whatever is known and
 * leaves the rest blank rather than waiting for a complete pair.
 */
export function ToolCard({ tool, cwd }: { tool: ToolExecution; cwd?: string }) {
  // A running tool is the live edge of the turn, so its output is shown while
  // it is produced and filed away again the moment it stops being news.
  const [open, setOpen] = useState(tool.status === "running");
  const card = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(tool.status === "running");
  // Set at the tap, read after the body lands: once expanded the card is no
  // longer at the bottom, so the test has to be made before the layout moves.
  const wasLast = useRef(false);

  const toggle = () => {
    wasLast.current = !open && isLastInView(card.current);
    setOpen(!open);
  };

  // Expanding the last card would otherwise reveal its body below the fold,
  // leaving the reader looking at the same collapsed row that they just tapped.
  useLayoutEffect(() => {
    if (open && wasLast.current) revealInView(card.current);
  }, [open]);

  // Keyed on the transition, not on the status: a manual toggle mid-run is the
  // reader's decision and is not undone on the next render.
  const running = tool.status === "running";
  useLayoutEffect(() => {
    if (running !== wasRunning.current) {
      wasRunning.current = running;
      setOpen(running);
    }
  }, [running]);
  const edits = editBlocks(tool.args);
  const rest = leftoverArgs(tool.args);
  const headline = summarise(tool);
  const images = resultImages(tool);

  return (
    <div ref={card} className={`tool ${tool.status} ${tool.isError ? "error" : ""}`}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={toggle}>
        <ToolIcon name={tool.toolName} className="tool-glyph" width={16} height={16} />
        <span className="tool-name">{tool.toolName}</span>
        <span className="muted line">{shortenPreview(headline, cwd)}</span>
        {tool.isError ? <span className="tool-status">failed</span> : null}
        {tool.status === "abandoned" ? <span className="tool-status stale">no result</span> : null}
        {tool.status === "running" ? <span className="spinner" /> : null}
        <ChevronRightIcon className={`caret ${open ? "open" : ""}`} width={16} height={16} />
      </button>

      {/* Outside the disclosure: when a tool returns an image, the image is
          the result, not a detail of it. Reading one is how the agent sees a
          screenshot, and the card is collapsed by default. */}
      {images.length > 0 ? (
        <div className="tool-images">
          {images.map((image, index) => (
            <TranscriptImage
              key={index}
              alt={tool.toolName}
              src={`data:${image.mimeType};base64,${image.data}`}
            />
          ))}
        </div>
      ) : null}

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
          <pre className="result">{resultText(tool) || placeholder(tool)}</pre>
        </div>
      ) : null}
    </div>
  );
}

/** Within this much of the transcript's end still counts as the last card. */
const TAIL_SLACK = 64;

function scroller(el: HTMLElement | null): HTMLElement | null {
  return el?.closest(".scroll-y") ?? null;
}

/** True when nothing but the dock's reserved padding follows this card. */
function isLastInView(el: HTMLElement | null): boolean {
  const pane = scroller(el);
  if (!el || !pane) return false;
  // Rects, not offsetTop: the card's offsetParent is the pane, not the
  // scroller, so the two coordinate systems differ by a constant.
  const below = el.getBoundingClientRect().bottom - pane.getBoundingClientRect().top;
  const reserved = parseFloat(getComputedStyle(pane).paddingBottom) || 0;
  return pane.scrollHeight - reserved - (pane.scrollTop + below) <= TAIL_SLACK;
}

/**
 * Bring the freshly expanded body into view: to the end when it fits, else to
 * the card's own head, since the top of a long result is what is read first.
 */
function revealInView(el: HTMLElement | null) {
  const pane = scroller(el);
  if (!el || !pane) return;
  const top = pane.scrollTop + el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  if (el.offsetHeight >= pane.clientHeight) pane.scrollTop = top;
  else pane.scrollTop = pane.scrollHeight;
}

/** An abandoned call is not waiting on anything, so it must not say so. */
function placeholder(tool: ToolExecution): string {
  return tool.status === "abandoned" ? "(no result: the run ended first)" : "(no output yet)";
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


type ResultPart = { type: string; text?: string; data?: string; mimeType?: string };

function resultParts(tool: ToolExecution): ResultPart[] {
  const payload = (tool.result ?? tool.partialResult) as { content?: ResultPart[] } | undefined;
  return payload?.content ?? [];
}

function resultText(tool: ToolExecution): string {
  return resultParts(tool)
    // Image parts are drawn, so naming their type here would label the picture.
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/** Images the tool returned, already inline: nothing is fetched to show them. */
function resultImages(tool: ToolExecution): ImageContent[] {
  return resultParts(tool).filter(
    (part): part is ImageContent =>
      part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string",
  );
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

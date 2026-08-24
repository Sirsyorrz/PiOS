import type { ToolExecution } from "@pios/protocol";
import { useState } from "react";
import { diffLines, editArgs } from "../diff.ts";

/**
 * One tool call, correlated on `toolCallId`.
 *
 * Args and result arrive from different events (and sometimes from the
 * persisted transcript instead), so the card renders whatever is known and
 * leaves the rest blank rather than waiting for a complete pair.
 */
export function ToolCard({ tool }: { tool: ToolExecution }) {
  const [open, setOpen] = useState(false);
  const edit = editArgs(tool.args);

  return (
    <div className={`tool ${tool.status} ${tool.isError ? "error" : ""}`}>
      <button type="button" className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-name">{tool.toolName}</span>
        <span className="muted">{summarise(tool)}</span>
        <span className="tool-status">{tool.isError ? "failed" : tool.status}</span>
      </button>

      {edit ? <Diff before={edit.oldText} after={edit.newText} /> : null}

      {open ? (
        <div className="tool-body">
          {edit ? null : <pre className="args">{stringify(tool.args)}</pre>}
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

function summarise(tool: ToolExecution): string {
  const args = tool.args as Record<string, unknown> | undefined;
  const hint = args?.path ?? args?.command ?? args?.pattern ?? args?.query;
  return typeof hint === "string" ? hint : "";
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

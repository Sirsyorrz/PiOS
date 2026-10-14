import {
  messageText,
  parsePartialJson,
  turnFailure,
  type AgentMessage,
  type ImageContent,
  type PartialMessage,
  type ToolExecution,
} from "@pios/protocol";
import { memo, useState } from "react";
import { useLongPress } from "../long-press.ts";
import { useSettings } from "../settings.ts";
import { PartImage } from "./image-view.tsx";
import { Markdown } from "./markdown.tsx";
import { ToolCard } from "./tool-card.tsx";

type MessageBubbleProps = {
  message: AgentMessage;
  /** Earlier attempts at this turn that pi retried. */
  failedAttempts?: number;
  tools: Map<string, ToolExecution>;
  cwd?: string;
  /** A dialog is waiting on the user, so running timers must not advance. */
  blocked?: boolean;
  /** Persisted turns only: there is nothing to rewind to before that. */
  entryId?: string;
  /** Press and hold this turn to drop it and everything after it. */
  onRewind?: (entryId: string) => void;
};

/**
 * A finished turn never changes, so it re-renders only when one of its own
 * tool calls does. The view hands out a fresh tool map on every delta, and
 * without this every bubble above the stream would redraw with it.
 */
export const MessageBubble = memo(MessageBubbleImpl, (before, after) =>
  before.message === after.message &&
  before.failedAttempts === after.failedAttempts &&
  before.cwd === after.cwd &&
  before.blocked === after.blocked &&
  before.entryId === after.entryId &&
  before.onRewind === after.onRewind &&
  sameTools(after.message, before.tools, after.tools),
);

function sameTools(
  message: AgentMessage,
  before: Map<string, ToolExecution>,
  after: Map<string, ToolExecution>,
): boolean {
  if (message.role !== "assistant") return true;
  return message.content.every(
    (part) => part.type !== "toolCall" || sameTool(before.get(part.id), after.get(part.id)),
  );
}

// Rebuilt from scratch on every view, so compared by what the card shows.
function sameTool(a: ToolExecution | undefined, b: ToolExecution | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.status === b.status &&
    a.isError === b.isError &&
    a.args === b.args &&
    a.partialResult === b.partialResult &&
    a.startedAt === b.startedAt &&
    a.durationMs === b.durationMs &&
    resultContent(a.result) === resultContent(b.result)
  );
}

// A result rebuilt from history is a fresh wrapper around the same content.
function resultContent(result: unknown): unknown {
  return result && typeof result === "object" && "content" in result ? result.content : result;
}

function MessageBubbleImpl({ message, failedAttempts, tools, cwd, blocked, entryId, onRewind }: MessageBubbleProps) {
  const rewind = onRewind && entryId ? () => onRewind(entryId) : undefined;
  // Hooks run for every role, so the gesture is bound before the role branch.
  const press = useLongPress(message.role === "user" ? rewind : undefined);
  if (message.role === "user") {
    const text = messageText(message);
    return (
      <div className={`bubble user${rewind ? " pressable" : ""}`} {...press}>
        {userImages(message).map((image, index) => (
          <PartImage key={index} alt="attachment" image={image} />
        ))}
        {text}
      </div>
    );
  }
  if (message.role === "bashExecution") {
    return (
      <BashCard
        command={message.command}
        output={message.output}
        exitCode={message.exitCode ?? undefined}
        cancelled={message.cancelled}
        excludeFromContext={message.excludeFromContext}
      />
    );
  }
  if (message.role === "toolResult" || message.role === "system") {
    // Tool results are folded into their tool card, the system prompt is not
    // conversation: the view model drops both before they reach here.
    return null;
  }

  return (
    <div className="bubble assistant">
      {message.content.map((part, index) => {
        if (part.type === "text") return <Markdown key={index} text={part.text} />;
        if (part.type === "thinking") return <Thinking key={index} text={part.thinking} />;
        if (part.type === "image") {
          return <PartImage key={index} alt="" image={part} />;
        }
        const tool = tools.get(part.id) ?? {
          toolCallId: part.id,
          toolName: part.name,
          args: part.arguments,
          isError: false,
          status: "running" as const,
        };
        return <ToolCard key={part.id} tool={tool} cwd={cwd} blocked={blocked} />;
      })}
      <StopNote message={message} failedAttempts={failedAttempts ?? 0} />
    </div>
  );
}

/**
 * How a turn ended, when that is not the normal way.
 *
 * A failed turn often has no content at all, so without this it renders as
 * nothing and the transcript just stops, with no hint that it will not go on.
 */
function StopNote({ message, failedAttempts }: {
  message: Extract<AgentMessage, { role: "assistant" }>;
  failedAttempts: number;
}) {
  const failure = turnFailure(message);
  if (failure) {
    const attempts = failedAttempts > 0 ? ` (after ${failedAttempts + 1} attempts)` : "";
    return <p className="error">{`Failed${attempts}: ${failure}`}</p>;
  }
  if (message.stopReason === "aborted") return <p className="muted">Stopped.</p>;
  if (message.stopReason === "length") {
    return <p className="muted">Cut off: the model reached its output limit.</p>;
  }
  return null;
}

/**
 * One `!` command: what ran, what it printed, how it ended.
 *
 * Shared by the live run and the entry pi persists for it, so the card does
 * not change shape underneath the reader when the command finishes.
 */
export function BashCard({
  command,
  output,
  exitCode,
  cancelled,
  excludeFromContext,
  running,
  onAbort,
}: {
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  /** Ran with `!!`: shown here, never sent to the model. */
  excludeFromContext?: boolean;
  running?: boolean;
  onAbort?: () => void;
}) {
  return (
    <div className={`bubble bash${excludeFromContext ? " excluded" : ""}`}>
      <div className="row">
        <span className="muted line">$ {command}</span>
        <span className="spacer" />
        {running && onAbort ? (
          <button type="button" className="ghost" onClick={onAbort}>
            stop
          </button>
        ) : null}
      </div>
      {output ? <pre>{output}</pre> : null}
      <div className="muted">{bashFooter({ running, cancelled, exitCode, excludeFromContext })}</div>
    </div>
  );
}

function bashFooter(state: {
  running?: boolean;
  cancelled?: boolean;
  exitCode?: number;
  excludeFromContext?: boolean;
}): string {
  const parts: string[] = [];
  if (state.running) parts.push("running");
  else if (state.cancelled) parts.push("cancelled");
  else if (state.exitCode !== undefined && state.exitCode !== 0) {
    parts.push(`exit ${state.exitCode}`);
  }
  if (state.excludeFromContext) parts.push("not in context");
  return parts.join(" \u00b7 ");
}

/** The in-flight assistant message: same shapes, none of them final. */
export function StreamingBubble({ partial, tools, cwd, blocked }: {
  partial: PartialMessage;
  tools: Map<string, ToolExecution>;
  cwd?: string;
  blocked?: boolean;
}) {
  return (
    <div className="bubble assistant streaming">
      {partial.content.map((part, index) => {
        if (part.type === "text") return <Markdown key={index} text={part.text} />;
        if (part.type === "thinking") return <Thinking key={index} text={part.thinking} />;
        // The card is drawn from the first delta: arguments are re-parsed on
        // every one, so a path or a command fills in as it is typed instead of
        // appearing whole once the closing brace lands.
        const tool: ToolExecution = (part.id ? tools.get(part.id) : undefined) ?? {
          toolCallId: part.id ?? `pending-${index}`,
          toolName: part.name ?? "tool",
          args: part.arguments ?? parsePartialJson(part.argsText),
          isError: false,
          status: "running",
        };
        return <ToolCard key={index} tool={tool} cwd={cwd} blocked={blocked} />;
      })}
      <span className="cursor" />
    </div>
  );
}

function userImages(message: AgentMessage): ImageContent[] {
  const content = "content" in message ? message.content : undefined;
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is ImageContent => part.type === "image");
}


/**
 * Reasoning reads as prose, so it is shown, not filed away behind a control.
 * The label is the only control: no icon competes with the text it heads.
 */
function Thinking({ text }: { text: string }) {
  const [shown, setShown] = useState(useSettings().showThinking);
  // A reasoning part can arrive before any of its text does; heading an empty
  // block would announce thinking that is not on screen yet.
  if (text.trim() === "") return null;
  return (
    <div className={`thinking ${shown ? "" : "hidden"}`}>
      <button
        type="button"
        className="thinking-head"
        aria-expanded={shown}
        onClick={() => setShown(!shown)}
      >
        {shown ? "Thinking:" : "Thinking\u2026"}
      </button>
      {/* Collapsing from the body is a convenience, not the accessible path:
          the header button owns that. Prose stays selectable, so a tap that
          ends a selection must not also fold the block away. */}
      {shown ? (
        <div
          className="thinking-text"
          onClick={() => {
            if (window.getSelection()?.isCollapsed !== false) setShown(false);
          }}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

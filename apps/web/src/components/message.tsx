import { messageText, type AgentMessage, type PartialMessage, type ToolExecution } from "@pios/protocol";
import { useState } from "react";
import { Markdown } from "./markdown.tsx";
import { ToolCard } from "./tool-card.tsx";

export function MessageBubble({ message, tools, cwd }: {
  message: AgentMessage;
  tools: Map<string, ToolExecution>;
  cwd?: string;
}) {
  if (message.role === "user") {
    return <div className="bubble user">{messageText(message)}</div>;
  }
  if (message.role === "bashExecution") {
    return (
      <div className="bubble bash">
        <div className="muted">$ {message.command}</div>
        <pre>{message.output}</pre>
      </div>
    );
  }
  if (message.role === "toolResult") {
    // Folded into its tool card by the view model; nothing to draw here.
    return null;
  }

  return (
    <div className="bubble assistant">
      {message.content.map((part, index) => {
        if (part.type === "text") return <Markdown key={index} text={part.text} />;
        if (part.type === "thinking") return <Thinking key={index} text={part.thinking} />;
        if (part.type === "image") {
          return <img key={index} alt="" src={`data:${part.mimeType};base64,${part.data}`} />;
        }
        const tool = tools.get(part.id) ?? {
          toolCallId: part.id,
          toolName: part.name,
          args: part.arguments,
          isError: false,
          status: "running" as const,
        };
        return <ToolCard key={part.id} tool={tool} cwd={cwd} />;
      })}
    </div>
  );
}

/** The in-flight assistant message: same shapes, none of them final. */
export function StreamingBubble({ partial, tools, cwd }: {
  partial: PartialMessage;
  tools: Map<string, ToolExecution>;
  cwd?: string;
}) {
  return (
    <div className="bubble assistant streaming">
      {partial.content.map((part, index) => {
        if (part.type === "text") return <Markdown key={index} text={part.text} />;
        if (part.type === "thinking") return <Thinking key={index} text={part.thinking} />;
        const tool = part.id ? tools.get(part.id) : undefined;
        if (tool) return <ToolCard key={part.id} tool={tool} cwd={cwd} />;
        return (
          <div key={index} className="tool running">
            <span className="tool-name">{part.name ?? "tool"}</span>
            {/* Arguments stream as raw text and are not valid JSON yet. */}
            <pre className="args">{part.argsText}</pre>
          </div>
        );
      })}
      <span className="cursor" />
    </div>
  );
}

/**
 * Reasoning reads as prose, so it is shown, not filed away behind a control.
 * The label is the only control: no icon competes with the text it heads.
 */
function Thinking({ text }: { text: string }) {
  const [shown, setShown] = useState(true);
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

import {
  messageText,
  type AgentMessage,
  type ImageContent,
  type PartialMessage,
  type ToolExecution,
} from "@pios/protocol";
import { useState } from "react";
import { useSettings } from "../settings.ts";
import { TranscriptImage } from "./image-view.tsx";
import { Markdown } from "./markdown.tsx";
import { ToolCard } from "./tool-card.tsx";

export function MessageBubble({ message, tools, cwd, blocked }: {
  message: AgentMessage;
  tools: Map<string, ToolExecution>;
  cwd?: string;
  /** A dialog is waiting on the user, so running timers must not advance. */
  blocked?: boolean;
}) {
  if (message.role === "user") {
    const text = messageText(message);
    return (
      <div className="bubble user">
        {userImages(message).map((image, index) => (
          <TranscriptImage key={index} alt="attachment" src={dataUrl(image)} />
        ))}
        {text}
      </div>
    );
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
          return <TranscriptImage key={index} alt="" src={dataUrl(part)} />;
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
    </div>
  );
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
        const tool = part.id ? tools.get(part.id) : undefined;
        if (tool) return <ToolCard key={part.id} tool={tool} cwd={cwd} blocked={blocked} />;
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

function userImages(message: AgentMessage): ImageContent[] {
  const content = "content" in message ? message.content : undefined;
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is ImageContent => part.type === "image");
}

function dataUrl(image: { mimeType: string; data: string }): string {
  return `data:${image.mimeType};base64,${image.data}`;
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

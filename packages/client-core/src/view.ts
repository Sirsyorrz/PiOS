import {
  messageText,
  type AgentMessage,
  type PartialMessage,
  type ToolExecution,
  type TranscriptStatus,
} from "@pios/protocol";
import type { OutboxEntry } from "./outbox.ts";
import type { SessionStore } from "./session-store.ts";

export type ViewItem =
  | { kind: "message"; key: string; message: AgentMessage }
  | { kind: "streaming"; key: string; partial: PartialMessage }
  | { kind: "pending"; key: string; entry: OutboxEntry };

export interface SessionView {
  items: ViewItem[];
  /** Tool state by `toolCallId`, live or reconstructed from history. */
  tools: Map<string, ToolExecution>;
  queue: { steering: string[]; followUp: string[] };
  running: boolean;
  /** Stop was sent and the agent has not stopped yet. */
  interrupting: boolean;
  status: TranscriptStatus;
}

/**
 * One render-ready transcript from three sources that overlap.
 *
 * Cached entries are the durable history, the live assembler holds whatever
 * arrived since the last subscribe, and the outbox holds what the user wrote
 * but the daemon has not acknowledged. The overlap between the first two is
 * real: a resync can return an entry for a message that also arrived as an
 * event, so identical messages are collapsed.
 */
export function sessionView(
  store: SessionStore,
  outbox: OutboxEntry[],
  sessionId: string,
): SessionView {
  const transcript = store.transcript(sessionId);
  const cached = store.get(sessionId).entries;

  const items: ViewItem[] = [];
  const seen = new Set<string>();
  const tools = new Map<string, ToolExecution>();

  const push = (message: AgentMessage, renderKey: string) => {
    // Deduped on content, keyed for rendering on whichever source arrived
    // first, so a persisted entry and its live event collapse into one item.
    const key = messageKey(message);
    if (seen.has(key)) return;
    seen.add(key);
    // Tool results belong on their tool card, not as a bubble of their own.
    if (message.role === "toolResult") {
      const existing = tools.get(message.toolCallId);
      tools.set(message.toolCallId, {
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        args: existing?.args,
        result: { content: message.content },
        isError: message.isError ?? false,
        status: "done",
      });
      return;
    }
    items.push({ kind: "message", key: renderKey, message });
  };

  for (const entry of cached) {
    if (!entry.message) continue;
    push(entry.message, `e:${entry.id}`);
  }
  for (const message of transcript.messages) push(message, messageKey(message));
  // Live state wins over anything reconstructed from history: it has args and
  // partial output that a persisted tool result does not.
  for (const tool of transcript.toolExecutions) {
    const historic = tools.get(tool.toolCallId);
    tools.set(tool.toolCallId, {
      ...tool,
      result: tool.result ?? historic?.result,
      isError: tool.isError || (historic?.isError ?? false),
    });
  }

  if (transcript.streaming) {
    items.push({ kind: "streaming", key: "streaming", partial: transcript.streaming });
  }
  for (const entry of outbox) {
    if (entry.sessionId !== sessionId) continue;
    items.push({ kind: "pending", key: `p:${entry.messageId}`, entry });
  }

  // The daemon is authoritative about the agent being busy. An aborted turn
  // can end without `agent_settled`, and then the event stream alone would
  // leave the transcript running for the rest of the session's life.
  const daemonStatus = store.status(sessionId);
  const running = transcript.running && daemonStatus !== "idle";

  return {
    items,
    tools,
    queue: transcript.queue,
    running,
    interrupting: running && store.isInterrupting(sessionId),
    status: transcript.status,
  };
}

/**
 * Identity for a message that has no id of its own.
 *
 * Events carry no entry id, so the only thing shared with the persisted copy
 * is the content. Role, timestamp and text are enough to spot the duplicate;
 * a false match would need the same role to say the same thing in the same
 * millisecond.
 */
function messageKey(message: AgentMessage): string {
  const timestamp = "timestamp" in message ? (message.timestamp ?? "") : "";
  const suffix = message.role === "toolResult" ? message.toolCallId : messageText(message);
  return `m:${message.role}:${timestamp}:${suffix}`;
}

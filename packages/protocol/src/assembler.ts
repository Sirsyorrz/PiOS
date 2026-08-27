import type { AgentEvent, AssistantMessageEvent } from "./events.ts";
import type { AgentMessage, AssistantMessage } from "./messages.ts";

/**
 * A content block while it is still streaming. `message_update` carries deltas
 * with no cumulative snapshot, so the client has to hold this itself.
 */
export type PartialContent =
  | { type: "text"; text: string; done: boolean }
  | { type: "thinking"; thinking: string; done: boolean }
  | {
      type: "toolCall";
      /** null until `toolcall_end`: deltas carry no id, only `contentIndex`. */
      id: string | null;
      name: string | null;
      /** Raw argument text as it streams. Not necessarily valid JSON yet. */
      argsText: string;
      arguments?: unknown;
      done: boolean;
    };

export interface PartialMessage {
  role: "assistant";
  content: PartialContent[];
  /** Set once `message_end` arrives; that message is authoritative. */
  final: AssistantMessage | null;
}

/**
 * Assembles one in-flight assistant message from `message_start` plus
 * `contentIndex`-keyed deltas.
 *
 * Blocks are keyed by `contentIndex` rather than by arrival order because a
 * provider may interleave indices. Tool call argument buffers are keyed the
 * same way: `toolcall_delta` has no `toolCallId`, the id only appears on
 * `toolcall_end`.
 */
export class MessageAssembler {
  private blocks = new Map<number, PartialContent>();
  private finalMessage: AssistantMessage | null = null;

  reset(): void {
    this.blocks.clear();
    this.finalMessage = null;
  }

  applyDelta(event: AssistantMessageEvent): void {
    switch (event.type) {
      case "text_start":
        this.blocks.set(event.contentIndex, { type: "text", text: "", done: false });
        break;
      case "text_delta": {
        const block = this.textBlock(event.contentIndex);
        block.text += event.delta;
        break;
      }
      case "text_end": {
        const block = this.textBlock(event.contentIndex);
        // `content` is the provider's authoritative value for the block.
        block.text = event.content;
        block.done = true;
        break;
      }
      case "thinking_start":
        this.blocks.set(event.contentIndex, { type: "thinking", thinking: "", done: false });
        break;
      case "thinking_delta": {
        const block = this.thinkingBlock(event.contentIndex);
        block.thinking += event.delta;
        break;
      }
      case "thinking_end": {
        const block = this.thinkingBlock(event.contentIndex);
        block.thinking = event.content;
        block.done = true;
        break;
      }
      case "toolcall_start":
        this.blocks.set(event.contentIndex, {
          type: "toolCall",
          id: null,
          name: null,
          argsText: "",
          done: false,
        });
        break;
      case "toolcall_delta": {
        const block = this.toolCallBlock(event.contentIndex);
        block.argsText += event.delta;
        break;
      }
      case "toolcall_end": {
        const block = this.toolCallBlock(event.contentIndex);
        block.id = event.toolCall.id;
        block.name = event.toolCall.name;
        block.arguments = event.toolCall.arguments;
        block.done = true;
        break;
      }
      default:
        break;
    }
  }

  complete(message: AssistantMessage): void {
    this.finalMessage = message;
  }

  get isEmpty(): boolean {
    return this.blocks.size === 0 && this.finalMessage === null;
  }

  snapshot(): PartialMessage {
    const content = [...this.blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, block]) => block);
    return { role: "assistant", content, final: this.finalMessage };
  }

  /** Concatenated visible text, excluding thinking and tool calls. */
  text(): string {
    return this.snapshot()
      .content.filter((c): c is Extract<PartialContent, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("");
  }

  private textBlock(index: number) {
    const block = this.blocks.get(index);
    if (block?.type === "text") return block;
    // A delta without a preceding start still has to land somewhere.
    const created: PartialContent = { type: "text", text: "", done: false };
    this.blocks.set(index, created);
    return created as Extract<PartialContent, { type: "text" }>;
  }

  private thinkingBlock(index: number) {
    const block = this.blocks.get(index);
    if (block?.type === "thinking") return block;
    const created: PartialContent = { type: "thinking", thinking: "", done: false };
    this.blocks.set(index, created);
    return created as Extract<PartialContent, { type: "thinking" }>;
  }

  private toolCallBlock(index: number) {
    const block = this.blocks.get(index);
    if (block?.type === "toolCall") return block;
    const created: PartialContent = {
      type: "toolCall",
      id: null,
      name: null,
      argsText: "",
      done: false,
    };
    this.blocks.set(index, created);
    return created as Extract<PartialContent, { type: "toolCall" }>;
  }
}

/**
 * `abandoned` is a call whose result never arrived and whose turn is over:
 * the agent was killed, or the client left before answering it. It is not
 * `done`, because there is no result, and not `running`, because nothing is.
 */
export type ToolExecutionStatus = "running" | "done" | "abandoned";

export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** Cumulative, not a delta: each update replaces the previous value. */
  partialResult?: unknown;
  result?: unknown;
  isError: boolean;
  status: ToolExecutionStatus;
  /** Epoch ms, already corrected into the local clock by the caller. */
  startedAt?: number;
  /** Execution time as measured by the daemon, excluding confirmation waits. */
  durationMs?: number;
}

/** Long-running conditions the user has to be told about, not just logged. */
export interface TranscriptStatus {
  compaction: { reason: string } | null;
  retry: { attempt: number; maxAttempts?: number; delayMs?: number; error?: string } | null;
  /** Never cleared automatically: a broken extension stays visible. */
  extensionErrors: { extensionPath?: string; event?: string; error: string }[];
}

export interface Transcript {
  messages: AgentMessage[];
  streaming: PartialMessage | null;
  toolExecutions: ToolExecution[];
  queue: { steering: string[]; followUp: string[] };
  /** True between `agent_start` and `agent_settled`. `agent_end` does not clear it. */
  running: boolean;
  status: TranscriptStatus;
}

/**
 * Applies a stream of agent events to a running transcript.
 *
 * Deliberately tolerant: a client that reconnects mid-turn sees deltas for a
 * message whose `message_start` it missed, and must render them anyway.
 */
export class TranscriptAssembler {
  private readonly messages: AgentMessage[] = [];
  private readonly tools = new Map<string, ToolExecution>();
  private assembler = new MessageAssembler();
  private streamingActive = false;
  private queue = { steering: [] as string[], followUp: [] as string[] };
  private running = false;
  private status: TranscriptStatus = { compaction: null, retry: null, extensionErrors: [] };

  apply(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.running = true;
        break;
      case "agent_settled":
        this.running = false;
        // A settled run cannot still be retrying; a missed `auto_retry_end`
        // would otherwise leave the banner up forever.
        this.status.retry = null;
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          // Resets per message, not per session: indices restart each message.
          this.assembler = new MessageAssembler();
          this.streamingActive = true;
        }
        // Non-assistant messages arrive complete and are recorded on
        // message_end, which follows immediately. Recording them here too
        // would double them.
        break;
      case "message_update":
        if (!this.streamingActive) {
          this.assembler = new MessageAssembler();
          this.streamingActive = true;
        }
        this.assembler.applyDelta(event.assistantMessageEvent);
        break;
      case "message_end":
        this.messages.push(event.message);
        if (event.message.role === "assistant") {
          this.assembler = new MessageAssembler();
          this.streamingActive = false;
        }
        break;
      case "tool_execution_start":
        this.tools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          isError: false,
          status: "running",
          startedAt: event.startedAt,
        });
        break;
      case "tool_execution_update": {
        const tool = this.tool(event.toolCallId, event.toolName);
        tool.partialResult = event.partialResult;
        break;
      }
      case "tool_execution_end": {
        const tool = this.tool(event.toolCallId, event.toolName);
        tool.result = event.result;
        tool.isError = event.isError ?? false;
        tool.status = "done";
        tool.durationMs = event.durationMs;
        break;
      }
      case "queue_update":
        this.queue = { steering: event.steering, followUp: event.followUp };
        break;
      case "compaction_start":
        this.status.compaction = { reason: event.reason };
        break;
      case "compaction_end":
        this.status.compaction = null;
        if (event.errorMessage) {
          this.status.extensionErrors.push({ event: "compaction", error: event.errorMessage });
        }
        break;
      case "auto_retry_start":
        this.status.retry = {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.errorMessage,
        };
        break;
      case "auto_retry_end":
        this.status.retry = null;
        break;
      case "extension_error":
        this.status.extensionErrors.push({
          extensionPath: event.extensionPath,
          event: event.event,
          error: event.error,
        });
        break;
      default:
        break;
    }
  }

  snapshot(): Transcript {
    return {
      messages: [...this.messages],
      streaming: this.streamingActive && !this.assembler.isEmpty ? this.assembler.snapshot() : null,
      toolExecutions: [...this.tools.values()],
      queue: { steering: [...this.queue.steering], followUp: [...this.queue.followUp] },
      running: this.running,
      status: {
        compaction: this.status.compaction,
        retry: this.status.retry,
        extensionErrors: [...this.status.extensionErrors],
      },
    };
  }

  /**
   * Discounts a span during which nothing could run, by moving the start of
   * every in-flight call forward past it.
   *
   * The daemon does the same to the duration it reports, so without this the
   * live counter would climb past the final number while a confirmation sat
   * unanswered and then jump backwards when it landed.
   */
  excludeSince(since: number, until = Date.now()): void {
    for (const tool of this.tools.values()) {
      if (tool.status !== "running" || tool.startedAt === undefined) continue;
      // A call that began mid-block only loses the part of the block it saw.
      const from = Math.max(since, tool.startedAt);
      if (until > from) tool.startedAt += until - from;
    }
  }

  private tool(toolCallId: string, toolName: string): ToolExecution {
    let tool = this.tools.get(toolCallId);
    if (!tool) {
      tool = { toolCallId, toolName, args: undefined, isError: false, status: "running" };
      this.tools.set(toolCallId, tool);
    }
    return tool;
  }
}

/**
 * In-process twin of `fake-pi.ts`.
 *
 * Both stubs must behave identically, otherwise the contract suite would only
 * be proving that each host matches its own stub.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { SessionEntry } from "@pios/protocol";
import type { AgentSessionLike } from "../src/in-process.ts";
import type { CreateSessionOptions } from "../src/types.ts";

export class FakeAgentSession implements AgentSessionLike {
  isStreaming = false;
  readonly sessionId: string;
  readonly sessionFile: string;
  private entries: SessionEntry[] = [];
  private counter = 0;
  private listeners = new Set<(event: unknown) => void>();
  private aborted = false;
  disposed = false;

  readonly sessionManager = {
    getEntries: () => this.entries,
    getLeafId: () => this.entries.at(-1)?.id ?? null,
  };

  constructor(sessionId: string, sessionDir: string) {
    this.sessionId = sessionId;
    mkdirSync(sessionDir, { recursive: true });
    this.sessionFile = `${sessionDir}/${sessionId}.json`;
    try {
      this.entries = JSON.parse(readFileSync(this.sessionFile, "utf8"));
      this.counter = this.entries.length;
    } catch {
      this.entries = [];
    }
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: unknown) {
    for (const listener of [...this.listeners]) listener(event);
  }

  private addEntry(message: unknown): void {
    this.entries.push({
      id: `${this.sessionId.slice(0, 4)}-${++this.counter}`,
      parentId: this.entries.at(-1)?.id ?? null,
      type: "message",
      message: message as SessionEntry["message"],
    });
    writeFileSync(this.sessionFile, JSON.stringify(this.entries));
  }

  async prompt(
    text: string,
    options?: { preflightResult?: (success: boolean) => void },
  ): Promise<void> {
    if (this.isStreaming) {
      options?.preflightResult?.(false);
      throw new Error("Agent is already processing.");
    }
    this.isStreaming = true;
    options?.preflightResult?.(true);
    this.aborted = false;
    const user = { role: "user" as const, content: text, timestamp: Date.now() };
    this.addEntry(user);
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });
    this.emit({ type: "message_start", message: user });
    this.emit({ type: "message_end", message: user });

    const reply = `echo: ${text}`;
    this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    this.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    for (const chunk of reply.match(/.{1,4}/gs) ?? []) {
      if (this.aborted) break;
      await new Promise((r) => setTimeout(r, 2));
      this.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk },
      });
    }
    this.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: reply },
    });

    const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: reply }] };
    this.emit({ type: "message_end", message: assistant });
    this.addEntry(assistant);
    this.emit({ type: "turn_end", message: assistant, toolResults: [] });
    this.emit({ type: "agent_end", messages: [], willRetry: false });
    this.isStreaming = false;
    this.emit({ type: "agent_settled" });
  }

  async steer(text: string): Promise<void> {
    this.emit({ type: "queue_update", steering: [text], followUp: [] });
  }

  async followUp(text: string): Promise<void> {
    this.emit({ type: "queue_update", steering: [], followUp: [text] });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.isStreaming = false;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  /** Emits something no build understands, to prove it is dropped not forwarded. */
  emitUnknownEvent(): void {
    this.emit({ type: "telepathy_start", intensity: 11 });
  }
}

export function fakeAgentFactory(sessionDir: string) {
  const created: FakeAgentSession[] = [];
  const factory = async (options: CreateSessionOptions) => {
    const session = new FakeAgentSession(options.id ?? "fake", sessionDir);
    created.push(session);
    return session;
  };
  return { factory, created };
}

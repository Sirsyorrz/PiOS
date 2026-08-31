/**
 * In-process twin of `fake-pi.ts`.
 *
 * Both stubs must behave identically, otherwise the contract suite would only
 * be proving that each host matches its own stub.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { SessionEntry } from "@pios/protocol";
import type { AgentModelLike, AgentSessionLike } from "../src/in-process.ts";
import type { CreateSessionOptions } from "../src/types.ts";

const CATALOGUE: AgentModelLike[] = [
  { id: "fast-1", name: "Fast 1", provider: "acme" },
  { id: "deep-1", name: "Deep 1", provider: "acme" },
  { id: "other-1", name: "Other 1", provider: "other" },
];

export class FakeAgentSession implements AgentSessionLike {
  isStreaming = false;
  model: AgentModelLike | undefined = CATALOGUE[0];
  readonly scopedModels = [{ model: CATALOGUE[0]! }, { model: CATALOGUE[1]! }];
  readonly modelRuntime = {
    getAvailable: async () => CATALOGUE,
    getModel: (provider: string, id: string) =>
      CATALOGUE.find((model) => model.provider === provider && model.id === id),
  };
  readonly extensionRunner = {
    getRegisteredCommands: () => [
      {
        invocationName: "review:1",
        description: "Review the diff",
        sourceInfo: { path: "/ext/review.ts", scope: "user" },
      },
    ],
  };
  readonly promptTemplates = [
    { name: "fix-tests", sourceInfo: { path: "/proj/fix-tests.md", scope: "project" } },
  ];
  readonly resourceLoader = {
    getSkills: () => ({ skills: [{ name: "search" }] }),
  };
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

  constructor(sessionId: string, sessionDir: string, resumeFrom?: string) {
    this.sessionId = sessionId;
    mkdirSync(sessionDir, { recursive: true });
    this.sessionFile = resumeFrom ?? `${sessionDir}/${sessionId}.json`;
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

  async setModel(model: AgentModelLike): Promise<void> {
    this.model = model;
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
    const session = new FakeAgentSession(options.id ?? "fake", sessionDir, options.resumeFrom);
    created.push(session);
    return session;
  };
  return { factory, created };
}

import type { AgentEvent, ExtensionUiRequest, ModelOption } from "@pios/protocol";
import { EventRingBuffer } from "./ring-buffer.ts";
import type {
  BufferedEvent,
  HostEvent,
  SessionInfo,
  SessionStatus,
} from "./types.ts";

/**
 * Fan-out, buffering, and status bookkeeping shared by both session hosts.
 *
 * Every published event goes through the buffer first, so a live subscriber
 * and a replaying one see the same seq numbers for the same events.
 */
export abstract class BaseSession {
  readonly id: string;
  readonly cwd: string;
  readonly name: string | undefined;

  private trustedState: boolean;

  protected status: SessionStatus = "starting";
  protected leafId: string | null = null;
  protected sessionFile: string | undefined;
  protected model: ModelOption | undefined;
  protected updatedAt = Date.now();

  private readonly buffer: EventRingBuffer;
  private readonly listeners = new Set<(event: BufferedEvent) => void>();
  /**
   * Open dialogs belong to the session, not to whoever was connected when they
   * were asked: a client that reconnects, or a second device, has to be able
   * to answer one that is already outstanding.
   */
  private readonly dialogs = new Map<string, ExtensionUiRequest>();

  constructor(args: {
    id: string;
    cwd: string;
    name?: string;
    trusted: boolean;
    bufferCapacity?: number;
  }) {
    this.id = args.id;
    this.cwd = args.cwd;
    this.name = args.name;
    this.trustedState = args.trusted;
    this.buffer = new EventRingBuffer(args.bufferCapacity);
  }

  /** Mutable: trusting a directory relaunches pi in place, it does not fork. */
  get trusted(): boolean {
    return this.trustedState;
  }

  protected setTrusted(trusted: boolean): void {
    this.trustedState = trusted;
  }

  get info(): SessionInfo {
    return {
      id: this.id,
      cwd: this.cwd,
      name: this.name,
      trusted: this.trusted,
      status: this.status,
      sessionFile: this.sessionFile,
      leafId: this.leafId,
      lastSeq: this.buffer.lastSeq,
      updatedAt: this.updatedAt,
      model: this.model,
    };
  }

  get pendingDialogs(): ExtensionUiRequest[] {
    return [...this.dialogs.values()];
  }

  protected trackDialog(request: ExtensionUiRequest): void {
    this.dialogs.set(request.id, request);
  }

  /** Announced so every attached client dismisses, not just the answerer. */
  protected closeDialog(id: string): boolean {
    if (!this.dialogs.delete(id)) return false;
    this.publish({ type: "extension_ui_closed", id });
    return true;
  }

  /** A dead agent forgets its dialogs; nothing is left to answer them. */
  protected clearDialogs(): void {
    for (const id of [...this.dialogs.keys()]) this.closeDialog(id);
  }

  subscribe(listener: (event: BufferedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replay(sinceSeq?: number) {
    return this.buffer.replay(sinceSeq);
  }

  protected publish(event: HostEvent): BufferedEvent {
    const buffered = this.buffer.push(event);
    this.updatedAt = buffered.at;
    for (const listener of [...this.listeners]) {
      // One bad subscriber must not stop delivery to the others or kill the
      // agent that is emitting.
      try {
        listener(buffered);
      } catch {
        /* ignore */
      }
    }
    return buffered;
  }

  /**
   * Records the active model and tells subscribers.
   *
   * Published as a status event because that is what clients turn into a fresh
   * summary; a model switch from one device has to reach the others.
   */
  protected setModelInfo(model: ModelOption | undefined): void {
    if (model?.provider === this.model?.provider && model?.modelId === this.model?.modelId) return;
    this.model = model;
    this.publish({ type: "status", status: this.status });
  }

  protected setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.publish({ type: "status", status });
  }

  /** Tracks run state and the durable cursor as events go by. */
  protected observeAgentEvent(event: AgentEvent): void {
    if (event.type === "agent_start") this.setStatus("running");
    // Only agent_settled is terminal; agent_end may be followed by a retry,
    // a compaction, or a queued continuation.
    if (event.type === "agent_settled") this.setStatus("idle");
  }

  protected setLeafId(leafId: string | null): void {
    this.leafId = leafId;
  }

  protected clearListeners(): void {
    this.listeners.clear();
  }
}

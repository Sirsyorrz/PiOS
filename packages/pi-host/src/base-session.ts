import {
  applyPresentation,
  emptyPresentation,
  messageText,
  type AgentEvent,
  type SessionEntry,
  type ExtensionUiRequest,
  type ModelOption,
  type SessionPresentation,
} from "@pios/protocol";
import { EventRingBuffer } from "./ring-buffer.ts";
import { ToolTimer } from "./tool-timing.ts";
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
  protected thinkingLevel: string | undefined;
  protected thinkingLevels: string[] = [];
  protected updatedAt = Date.now();
  /** First user message: what a list row shows when the session has no name. */
  protected preview: string | undefined;

  private readonly buffer: EventRingBuffer;
  private readonly listeners = new Set<(event: BufferedEvent) => void>();
  /**
   * Open dialogs belong to the session, not to whoever was connected when they
   * were asked: a client that reconnects, or a second device, has to be able
   * to answer one that is already outstanding.
   */
  private readonly dialogs = new Map<string, ExtensionUiRequest>();
  /** Last-value-wins state from the non-blocking half of the extension UI. */
  private presentationState: SessionPresentation = emptyPresentation();
  /** The one owner of tool timings: only here are agent events and dialog
   *  lifecycle visible together. */
  private readonly toolTimer = new ToolTimer();

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
      awaitingInput: this.dialogs.size > 0,
      sessionFile: this.sessionFile,
      leafId: this.leafId,
      lastSeq: this.buffer.lastSeq,
      updatedAt: this.updatedAt,
      preview: this.preview,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      thinkingLevels: this.thinkingLevels,
    };
  }

  get presentation(): SessionPresentation {
    return this.presentationState;
  }

  /** True when the request changed something worth telling clients about. */
  protected recordPresentation(request: ExtensionUiRequest): boolean {
    const next = applyPresentation(this.presentationState, request);
    if (next === this.presentationState) return false;
    this.presentationState = next;
    return true;
  }

  get pendingDialogs(): ExtensionUiRequest[] {
    return [...this.dialogs.values()];
  }

  /** Published as a status event: a blocked agent has to show in list rows. */
  protected trackDialog(request: ExtensionUiRequest): void {
    if (this.dialogs.has(request.id)) return;
    this.dialogs.set(request.id, request);
    this.toolTimer.block();
    this.publish({ type: "status", status: this.status });
  }

  /** Announced so every attached client dismisses, not just the answerer. */
  protected closeDialog(id: string): boolean {
    if (!this.dialogs.delete(id)) return false;
    this.toolTimer.unblock();
    this.publish({ type: "extension_ui_closed", id });
    this.publish({ type: "status", status: this.status });
    return true;
  }

  /** A dead agent forgets its dialogs; nothing is left to answer them. */
  protected clearDialogs(): void {
    for (const id of [...this.dialogs.keys()]) this.closeDialog(id);
    this.resetToolTimings();
  }

  subscribe(listener: (event: BufferedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replay(sinceSeq?: number) {
    return this.buffer.replay(sinceSeq);
  }

  protected publish(event: HostEvent): BufferedEvent {
    if (event.type === "agent_event") this.timeTool(event.event);
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
  protected recordModel(model: ModelOption | undefined): void {
    if (model?.provider === this.model?.provider && model?.modelId === this.model?.modelId) return;
    this.model = model;
    this.publish({ type: "status", status: this.status });
  }

  /**
   * Records the thinking level and the levels the model offers.
   *
   * Published like the model switch: pi clamps the level when the model
   * changes, so a client that never asked still has to hear about it.
   */
  protected recordThinking(level: string | undefined, levels?: string[]): void {
    const nextLevels = levels ?? this.thinkingLevels;
    const same =
      level === this.thinkingLevel &&
      nextLevels.length === this.thinkingLevels.length &&
      nextLevels.every((entry, index) => entry === this.thinkingLevels[index]);
    if (same) return;
    this.thinkingLevel = level;
    this.thinkingLevels = nextLevels;
    this.publish({ type: "status", status: this.status });
  }

  protected setStatus(status: SessionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.publish({ type: "status", status });
  }

  /** Tracks run state and the durable cursor as events go by. */
  protected observeAgentEvent(event: AgentEvent): void {
    if (event.type === "message_start" && event.message.role === "user") {
      this.notePreview(messageText(event.message));
    }
    if (event.type === "agent_start") this.setStatus("running");
    // Only agent_settled is terminal; agent_end may be followed by a retry,
    // a compaction, or a queued continuation.
    if (event.type === "agent_settled") this.setStatus("idle");
  }

  /**
   * A resumed session has its opening message on disk, not in the event
   * stream, so the first full entry page is the only place to find it.
   */
  protected observeEntries(entries: SessionEntry[]): void {
    if (this.preview) return;
    const first = entries.find((entry) => entry.message?.role === "user");
    if (first?.message) this.notePreview(messageText(first.message));
  }

  /** Published as a status event: list rows on other devices show it too. */
  private notePreview(text: string): void {
    const trimmed = text.trim().slice(0, 200);
    if (!trimmed || this.preview) return;
    this.preview = trimmed;
    this.publish({ type: "status", status: this.status });
  }

  protected setLeafId(leafId: string | null): void {
    this.leafId = leafId;
  }

  /**
   * Stamps timings on the way through, before buffering, so a replaying
   * client sees the same numbers as a live one.
   */
  private timeTool(event: AgentEvent): void {
    if (event.type === "tool_execution_start") {
      event.startedAt = this.toolTimer.begin(event.toolCallId);
    } else if (event.type === "tool_execution_end") {
      const durationMs = this.toolTimer.end(event.toolCallId);
      if (durationMs !== undefined) event.durationMs = durationMs;
    }
  }

  /** A replaced agent forgets its in-flight calls; so must their timers. */
  protected resetToolTimings(): void {
    this.toolTimer.reset();
  }

  protected clearListeners(): void {
    this.listeners.clear();
  }
}

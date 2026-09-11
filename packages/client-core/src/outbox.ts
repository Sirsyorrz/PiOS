import {
  WIRE_VERSION,
  type ClientFrame,
  type ImageContent,
  type StreamingBehavior,
} from "@pios/protocol";
import { Backoff, type BackoffOptions } from "./backoff.ts";
import { systemScheduler, type Scheduler, type TimerHandle } from "./scheduler.ts";
import { readVersioned, writeVersioned, type StorageAdapter } from "./storage.ts";

export const OUTBOX_SCHEMA_VERSION = 1;
const STORAGE_KEY = "pios.outbox";

export type OutboxEntryStatus = "queued" | "sending" | "failed";

export interface OutboxEntry {
  /** Stable identity of the composed message, for rendering and dedupe. */
  messageId: string;
  /** Idempotency key for delivery. The daemon dedupes on this. */
  commandId: string;
  sessionId: string;
  text: string;
  /** Inlined, not a file reference: the file may be gone by the time we send. */
  images: ImageContent[];
  streamingBehavior?: StreamingBehavior;
  /**
   * Starts the session this prompt is addressed to.
   *
   * Carried in the queue rather than sent ahead of it: a session with no
   * first prompt is an empty composer, so composing offline and sending later
   * must create the session at delivery, not at composition.
   */
  create?: { cwd: string; name?: string; trustProject?: boolean; model?: string };
  createdAt: number;
  attempts: number;
  status: OutboxEntryStatus;
  lastError?: string;
}

export interface OutboxOptions {
  storage: StorageAdapter;
  scheduler?: Scheduler;
  backoff?: BackoffOptions;
  /** Returns false when the frame could not be handed to a live socket. */
  send: (entry: OutboxEntry) => boolean;
}

/**
 * Durable queue of composed prompts.
 *
 * A prompt is written to storage before it is sent, and removed only when the
 * daemon acknowledges it. That is what makes composing on a train work: the
 * message survives the app being killed, and drains when signal returns.
 *
 * Entries carry both ids for different reasons. `messageId` identifies what
 * the user wrote, so the UI can show it pending. `commandId` identifies the
 * delivery attempt, so a redelivery after a lost ack is recognised as the same
 * command rather than run twice.
 */
export class ThreadOutbox {
  private entries: OutboxEntry[];
  private readonly storage: StorageAdapter;
  private readonly scheduler: Scheduler;
  private readonly backoff: Backoff;
  private readonly sendFn: (entry: OutboxEntry) => boolean;
  private readonly listeners = new Set<(entries: OutboxEntry[]) => void>();
  private retryTimer: TimerHandle | null = null;
  private draining = false;

  constructor(options: OutboxOptions) {
    this.storage = options.storage;
    this.scheduler = options.scheduler ?? systemScheduler;
    this.backoff = new Backoff(options.backoff);
    this.sendFn = options.send;
    this.entries = readVersioned<OutboxEntry[]>(
      this.storage,
      STORAGE_KEY,
      OUTBOX_SCHEMA_VERSION,
      [],
    );
    // Anything left mid-flight from a previous run is queued again: the
    // daemon's ledger makes a redundant redelivery harmless, a lost prompt is
    // not.
    for (const entry of this.entries) {
      if (entry.status === "sending") entry.status = "queued";
    }
  }

  list(sessionId?: string): OutboxEntry[] {
    return this.entries.filter((e) => !sessionId || e.sessionId === sessionId);
  }

  subscribe(listener: (entries: OutboxEntry[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => this.listeners.delete(listener);
  }

  enqueue(entry: Omit<OutboxEntry, "attempts" | "status" | "createdAt"> & { createdAt?: number }): OutboxEntry {
    const existing = this.entries.find((e) => e.commandId === entry.commandId);
    if (existing) return existing;

    const queued: OutboxEntry = {
      ...entry,
      createdAt: entry.createdAt ?? this.scheduler.now(),
      attempts: 0,
      status: "queued",
    };
    this.entries.push(queued);
    this.persist();
    this.drain();
    return queued;
  }

  /** The daemon accepted the command; it will never need sending again. */
  acknowledge(commandId: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.commandId !== commandId);
    if (this.entries.length === before) return;
    this.backoff.reset();
    this.persist();
    this.drain();
  }

  /**
   * The daemon refused the command outright.
   *
   * Kept and marked failed rather than dropped: the user wrote it, and the
   * usual cause is a fixable one like a missing `streamingBehavior`.
   */
  /** True when the failure belonged to a queued prompt, which now shows it. */
  reject(commandId: string, error: string): boolean {
    const entry = this.entries.find((e) => e.commandId === commandId);
    if (!entry) return false;
    entry.status = "failed";
    entry.lastError = error;
    this.persist();
    return true;
  }

  discard(commandId: string): void {
    this.entries = this.entries.filter((e) => e.commandId !== commandId);
    this.persist();
  }

  /** Retries a failed entry after the user fixed whatever caused it. */
  requeue(commandId: string, patch: Partial<Pick<OutboxEntry, "text" | "streamingBehavior">> = {}): void {
    const entry = this.entries.find((e) => e.commandId === commandId);
    if (!entry) return;
    Object.assign(entry, patch, { status: "queued" as const, lastError: undefined });
    this.persist();
    this.drain();
  }

  /** Called on reconnect. Draining is always safe; delivery is idempotent. */
  drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const entry of this.entries) {
        if (entry.status !== "queued") continue;
        entry.status = "sending";
        entry.attempts++;
        const accepted = this.sendFn(entry);
        if (accepted) continue;

        // No live socket. Stop the pass entirely rather than marking every
        // entry as attempted against a socket that is not there.
        entry.status = "queued";
        entry.attempts--;
        this.scheduleRetry();
        break;
      }
    } finally {
      this.draining = false;
      this.persist();
    }
  }

  get pendingCount(): number {
    return this.entries.filter((e) => e.status !== "failed").length;
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    const delay = this.backoff.next();
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = null;
      this.drain();
    }, delay);
  }

  private persist(): void {
    writeVersioned(this.storage, STORAGE_KEY, OUTBOX_SCHEMA_VERSION, this.entries);
    for (const listener of [...this.listeners]) listener(this.list());
  }
}

/** Builds the wire frame for a queued entry. */
export function outboxFrame(entry: OutboxEntry): ClientFrame {
  return {
    v: WIRE_VERSION,
    type: "prompt" as const,
    commandId: entry.commandId,
    sessionId: entry.sessionId,
    messageId: entry.messageId,
    text: entry.text,
    images: entry.images,
    streamingBehavior: entry.streamingBehavior,
    create: entry.create
      ? { ...entry.create, trustProject: entry.create.trustProject ?? false }
      : undefined,
  };
}

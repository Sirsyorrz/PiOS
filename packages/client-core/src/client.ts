import { WIRE_VERSION, type ImageContent, type StreamingBehavior } from "@pios/protocol";
import { AppStatePolicy } from "./app-state.ts";
import type { BackoffOptions } from "./backoff.ts";
import { ThreadOutbox, outboxFrame, type OutboxEntry } from "./outbox.ts";
import { SessionStore } from "./session-store.ts";
import { systemScheduler, type Scheduler } from "./scheduler.ts";
import { MemoryStorage, type StorageAdapter } from "./storage.ts";
import {
  ConnectionSupervisor,
  type Credentials,
  type SupervisorOptions,
  type SupervisorState,
} from "./supervisor.ts";

export interface PiosClientOptions extends Omit<SupervisorOptions, "scheduler"> {
  storage?: StorageAdapter;
  scheduler?: Scheduler;
  generateId?: () => string;
  /**
   * The outbox retries on its own ladder, separate from the supervisor's: a
   * send can fail on a healthy socket, and a reconnect is not the only thing
   * that should make it try again.
   */
  outboxBackoff?: BackoffOptions;
}

/**
 * Everything above the socket, wired together.
 *
 * The UI talks to this and nothing else. It cannot open a transport, cannot
 * write to one, and cannot schedule a retry: prompts go into the outbox and
 * the supervisor decides when anything reaches the wire.
 */
export class PiosClient {
  readonly supervisor: ConnectionSupervisor;
  readonly sessions: SessionStore;
  readonly outbox: ThreadOutbox;
  readonly appState: AppStatePolicy;

  private readonly scheduler: Scheduler;
  private readonly generateId: () => string;
  /** Sessions the UI wants live, re-subscribed on every reconnect. */
  private readonly subscribed = new Set<string>();
  private lastTransport: SupervisorState["transport"] = "idle";

  constructor(options: PiosClientOptions) {
    this.scheduler = options.scheduler ?? systemScheduler;
    this.generateId = options.generateId ?? defaultId;
    const storage = options.storage ?? new MemoryStorage();

    this.supervisor = new ConnectionSupervisor({ ...options, scheduler: this.scheduler });
    this.sessions = new SessionStore(storage);
    this.outbox = new ThreadOutbox({
      storage,
      scheduler: this.scheduler,
      backoff: options.outboxBackoff ?? options.backoff,
      send: (entry) => this.supervisor.send(outboxFrame(entry)),
    });
    this.appState = new AppStatePolicy(this.supervisor, { scheduler: this.scheduler });

    this.supervisor.subscribe((state) => this.onSupervisorState(state));
    this.supervisor.onFrame((frame) => this.onFrame(frame));
  }

  start(credentials: Credentials): void {
    this.supervisor.setCredentials(credentials);
    this.supervisor.start();
  }

  stop(): void {
    this.supervisor.stop();
  }

  /**
   * Queues a prompt. Never touches the socket directly.
   *
   * Returns the queued entry, so the UI can render it as pending immediately
   * whether or not there is a connection.
   */
  prompt(args: {
    sessionId: string;
    text: string;
    images?: ImageContent[];
    streamingBehavior?: StreamingBehavior;
  }): OutboxEntry {
    return this.outbox.enqueue({
      messageId: this.generateId(),
      commandId: this.generateId(),
      sessionId: args.sessionId,
      text: args.text,
      images: args.images ?? [],
      streamingBehavior: args.streamingBehavior,
    });
  }

  /**
   * Asks the daemon to start a session.
   *
   * The daemon answers with `session_state`, which the supervisor merges into
   * its session list, so the UI learns about the new session the same way it
   * learns about one another device created.
   *
   * Returns false when there was no live socket. Unlike a prompt, this is not
   * queued: replaying a stale "start a session here" minutes later is not
   * obviously what the user still wants, so the caller is told instead.
   */
  createSession(args: {
    cwd: string;
    name?: string;
    trustProject?: boolean;
    model?: string;
  }): boolean {
    return this.supervisor.send({
      v: WIRE_VERSION,
      type: "create_session",
      commandId: this.generateId(),
      cwd: args.cwd,
      name: args.name,
      trustProject: args.trustProject ?? false,
      model: args.model,
    });
  }

  disposeSession(sessionId: string): boolean {
    this.subscribed.delete(sessionId);
    this.sessions.clear(sessionId);
    this.supervisor.forgetSession(sessionId);
    return this.supervisor.send({
      v: WIRE_VERSION,
      type: "dispose_session",
      commandId: this.generateId(),
      sessionId,
    });
  }

  refreshSessions(): boolean {
    return this.supervisor.send({
      v: WIRE_VERSION,
      type: "list_sessions",
      commandId: this.generateId(),
    });
  }

  interrupt(sessionId: string): boolean {
    return this.supervisor.send({
      v: WIRE_VERSION,
      type: "interrupt",
      commandId: this.generateId(),
      sessionId,
    });
  }

  /** Marks a session live: subscribed now and after every reconnect. */
  watch(sessionId: string): void {
    this.subscribed.add(sessionId);
    if (this.supervisor.getState().transport === "connected") this.resync(sessionId);
  }

  unwatch(sessionId: string): void {
    this.subscribed.delete(sessionId);
    this.supervisor.send({
      v: WIRE_VERSION,
      type: "unsubscribe",
      commandId: this.generateId(),
      sessionId,
    });
  }

  private onSupervisorState(state: SupervisorState): void {
    const previous = this.lastTransport;
    this.lastTransport = state.transport;
    // Only the transition into `connected` matters. Reacting to every state
    // emission would resync on the sync-status change that resyncing itself
    // produces, which is an infinite loop.
    if (state.transport !== "connected" || previous === "connected") return;

    for (const sessionId of this.subscribed) this.resync(sessionId);
    this.outbox.drain();
  }

  /**
   * Brings one session back in step.
   *
   * The daemon's `leafId` decides, not the cache: if the branch moved, the
   * whole transcript is refetched rather than patched.
   */
  private resync(sessionId: string): void {
    const summary = this.supervisor
      .getState()
      .sessions.find((s) => s.sessionId === sessionId);
    const diverged = summary ? this.sessions.needsFullRefetch(sessionId, summary.leafId) : false;
    const cursor = diverged ? null : this.sessions.cursor(sessionId);
    if (diverged) this.sessions.clear(sessionId);

    this.supervisor.setSyncStatus("syncing");
    this.supervisor.send({
      v: WIRE_VERSION,
      type: "get_entries",
      commandId: this.generateId(),
      sessionId,
      since: cursor ?? undefined,
    });
    this.supervisor.send({
      v: WIRE_VERSION,
      type: "subscribe",
      commandId: this.generateId(),
      sessionId,
      sinceSeq: this.sessions.lastSeq(sessionId),
    });
  }

  private onFrame(frame: Parameters<Parameters<ConnectionSupervisor["onFrame"]>[0]>[0]): void {
    switch (frame.type) {
      case "ack":
        this.outbox.acknowledge(frame.commandId);
        break;
      case "error":
        if (frame.commandId) this.outbox.reject(frame.commandId, frame.message);
        // A failed subscription on a healthy socket is a sync problem, not a
        // transport one, and must not trigger a reconnect.
        if (frame.code !== "unauthorized") this.supervisor.setSyncStatus("error");
        break;
      case "entries":
        this.sessions.applyEntries(frame.sessionId, frame.entries, frame.leafId, frame.reset);
        this.supervisor.setSyncStatus("synced");
        break;
      case "subscribed":
        // Buffered events were evicted, so the live transcript is missing a
        // middle. Rebuild it from entries instead of pretending it is whole.
        if (frame.gap) this.sessions.resetLiveTranscript(frame.sessionId);
        break;
      case "agent_event":
        this.sessions.applyEvent(frame.sessionId, frame.seq, frame.event);
        break;
      case "session_recovered":
        if (this.sessions.needsFullRefetch(frame.sessionId, frame.leafId)) {
          this.sessions.clear(frame.sessionId);
          this.resync(frame.sessionId);
        }
        break;
      default:
        break;
    }
  }
}

function defaultId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

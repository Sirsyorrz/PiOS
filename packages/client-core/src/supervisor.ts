import {
  WIRE_VERSION,
  type ClientFrame,
  type ServerFrame,
  type SessionSummary,
} from "@pios/protocol";
import { Backoff, type BackoffOptions } from "./backoff.ts";
import { systemScheduler, type Scheduler, type TimerHandle } from "./scheduler.ts";
import { isAuthFailure, type Transport, type TransportFactory } from "./transport.ts";

/**
 * How the socket itself is doing. Never inferred from cached data: a client
 * with a full transcript on screen and a dead socket is `offline`, not
 * `connected`.
 */
export type TransportHealth =
  | "idle"
  | "offline"
  | "connecting"
  | "connected"
  | "waiting"
  | "blocked";

/**
 * Whether the data is current. Deliberately separate from transport health: a
 * healthy socket whose subscription failed is "connected, sync error", and
 * reporting that as a disconnect would send the UI into a fake reconnect loop.
 */
export type SyncStatus = "idle" | "syncing" | "synced" | "error";

export interface SupervisorState {
  transport: TransportHealth;
  sync: SyncStatus;
  /** Set when blocked, so the UI can say why instead of spinning. */
  blockedReason?: string;
  sessions: SessionSummary[];
  /** Sessions the daemon has in total, for knowing whether more can be asked for. */
  sessionsTotal: number;
  hasMoreSessions: boolean;
  attempts: number;
}

export interface SupervisorOptions {
  createTransport: TransportFactory;
  scheduler?: Scheduler;
  backoff?: BackoffOptions;
  /** Connected this long resets the ladder. */
  stableAfterMs?: number;
  clientVersion?: string;
  generateCommandId?: () => string;
}

export const STABLE_AFTER_MS = 30_000;

export interface Credentials {
  url: string;
  deviceToken: string;
}

/**
 * The single retry owner.
 *
 * Nothing else in the client opens a socket, schedules a reconnect, or decides
 * that a connection is healthy. UI code observes state and sends frames; if it
 * could also create transports there would be two ladders racing, which is how
 * reconnect storms happen.
 */
export class ConnectionSupervisor {
  private readonly options: Required<Omit<SupervisorOptions, "backoff">> & {
    backoff?: BackoffOptions;
  };
  private readonly scheduler: Scheduler;
  private readonly backoff: Backoff;
  private readonly listeners = new Set<(state: SupervisorState) => void>();
  private readonly frameListeners = new Set<(frame: ServerFrame) => void>();

  private credentials: Credentials | null = null;
  private transport: Transport | null = null;
  private retryTimer: TimerHandle | null = null;
  private stableTimer: TimerHandle | null = null;
  private online = true;
  private started = false;
  /** Guards against an in-flight attempt being duplicated by a wakeup. */
  private connecting = false;
  private generation = 0;

  private state: SupervisorState = {
    transport: "idle",
    sync: "idle",
    sessions: [],
    sessionsTotal: 0,
    hasMoreSessions: false,
    attempts: 0,
  };

  constructor(options: SupervisorOptions) {
    this.scheduler = options.scheduler ?? systemScheduler;
    this.options = {
      createTransport: options.createTransport,
      scheduler: this.scheduler,
      stableAfterMs: options.stableAfterMs ?? STABLE_AFTER_MS,
      clientVersion: options.clientVersion ?? "0.0.0",
      generateCommandId: options.generateCommandId ?? defaultCommandId,
      backoff: options.backoff,
    };
    this.backoff = new Backoff(options.backoff);
  }

  getState(): SupervisorState {
    return { ...this.state };
  }

  subscribe(listener: (state: SupervisorState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  onFrame(listener: (frame: ServerFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  setCredentials(credentials: Credentials | null): void {
    const changed =
      credentials?.url !== this.credentials?.url ||
      credentials?.deviceToken !== this.credentials?.deviceToken;
    this.credentials = credentials;
    // New inputs are the only thing that can clear a block: retrying the same
    // rejected token forever is a busy loop with extra steps.
    if (changed && this.state.transport === "blocked") {
      this.patch({ transport: "idle", blockedReason: undefined });
      this.backoff.reset();
      if (this.started) this.connect();
    } else if (changed && this.started) {
      this.reconnect("credentials changed");
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.started = false;
    this.clearTimers();
    this.dropTransport();
    this.patch({ transport: "idle", sync: "idle" });
  }

  /**
   * Network reachability, as reported by the platform.
   *
   * Offline releases the connection and arms nothing. Burning retries against
   * a radio that is known to be off wastes the ladder, so that when the
   * network does return the client is already at a 16s delay.
   */
  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (!online) {
      this.clearTimers();
      this.dropTransport();
      this.patch({ transport: "offline", sync: "idle", attempts: this.backoff.attempts });
      return;
    }
    this.backoff.reset();
    if (this.started) this.connect();
  }

  /**
   * Foreground after a long background. The OS may have killed the socket
   * underneath an attempt that still looks in-flight, so this interrupts
   * whatever is happening and starts clean.
   */
  wake(reason: string): void {
    if (!this.started || !this.online) return;
    if (this.state.transport === "blocked") return;
    this.backoff.reset();
    this.reconnect(reason);
  }

  /** A cheap liveness check after a short background. */
  probe(): void {
    if (this.state.transport === "connected") return;
    if (!this.started || !this.online) return;
    if (this.state.transport === "connecting") return;
    this.wake("probe");
  }

  send(frame: ClientFrame): boolean {
    if (!this.transport || this.state.transport !== "connected") return false;
    this.transport.send(frame);
    return true;
  }

  setSyncStatus(sync: SyncStatus): void {
    this.patch({ sync });
  }

  private connect(): void {
    if (!this.started || this.connecting) return;
    if (!this.online) return this.patch({ transport: "offline" });
    if (this.state.transport === "blocked") return;
    if (!this.credentials) {
      // A missing token is a configuration failure, not a network one, so it
      // blocks rather than retrying.
      return this.block("no credentials");
    }

    this.connecting = true;
    this.clearRetryTimer();
    this.patch({ transport: "connecting", attempts: this.backoff.attempts });

    const generation = ++this.generation;
    const { url, deviceToken } = this.credentials;

    void this.options
      .createTransport(url)
      .then((transport) => {
        if (generation !== this.generation) return transport.close();
        this.transport = transport;
        transport.onMessage((frame) => this.onFrame_(generation, frame));
        transport.onClose(({ code, reason }) => this.onClose(generation, code, reason));
        transport.onError(() => this.onClose(generation, 1006, "transport error"));
        // Open is not connected. The hello round trip has to succeed first.
        transport.send({
          v: WIRE_VERSION,
          type: "hello",
          commandId: this.options.generateCommandId(),
          deviceToken,
          clientVersion: this.options.clientVersion,
        });
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.connecting = false;
        this.scheduleRetry(String(error));
      });
  }

  private onFrame_(generation: number, frame: ServerFrame): void {
    if (generation !== this.generation) return;

    if (frame.type === "welcome") {
      this.connecting = false;
      this.patch({
        transport: "connected",
        sessions: frame.sessions,
        attempts: this.backoff.attempts,
        blockedReason: undefined,
      });
      // The ladder resets only after the connection proves it can hold, not
      // the instant it opens: a socket that dies after two seconds every time
      // must not reset the ladder on every attempt.
      this.stableTimer = this.scheduler.setTimeout(() => {
        this.backoff.reset();
        this.patch({ attempts: 0 });
      }, this.options.stableAfterMs);
    }

    if (frame.type === "sessions") this.mergePage(frame);
    if (frame.type === "session_state") this.mergeSummary(frame.summary);
    if (frame.type === "error" && frame.code === "unauthorized") {
      return this.block("unauthorized");
    }

    for (const listener of [...this.frameListeners]) listener(frame);
  }

  /**
   * Shows a list from a previous run before the socket is up.
   *
   * Rendering only: the first page from the daemon replaces it wholesale, and
   * nothing decides freshness from these rows.
   */
  seedSessions(sessions: SessionSummary[]): void {
    if (this.state.sessions.length || !sessions.length) return;
    this.patch({ sessions });
  }

  /**
   * One page of the session list.
   *
   * The first page replaces what was there, so a search or a filter cannot
   * leave stale rows behind; later pages append.
   */
  private mergePage(frame: Extract<ServerFrame, { type: "sessions" }>): void {
    const kept = frame.offset === 0 ? [] : this.state.sessions;
    const byId = new Map(kept.map((session) => [session.sessionId, session]));
    for (const session of frame.sessions) byId.set(session.sessionId, session);
    this.patch({
      sessions: [...byId.values()],
      sessionsTotal: frame.total,
      hasMoreSessions: frame.hasMore,
    });
  }

  private mergeSummary(summary: SessionSummary): void {
    const sessions = this.state.sessions.filter((s) => s.sessionId !== summary.sessionId);
    this.patch({ sessions: [...sessions, summary] });
  }

  private onClose(generation: number, code: number, reason: string): void {
    if (generation !== this.generation) return;
    this.connecting = false;
    this.transport = null;
    this.clearStableTimer();

    if (isAuthFailure(code)) return this.block(reason || "unauthorized");
    if (!this.online) return this.patch({ transport: "offline", sync: "idle" });
    this.patch({ sync: "idle" });
    this.scheduleRetry(reason || `closed ${code}`);
  }

  private scheduleRetry(reason: string): void {
    if (!this.started || !this.online) return;
    const delay = this.backoff.next();
    this.patch({ transport: "waiting", attempts: this.backoff.attempts, blockedReason: reason });
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private block(reason: string): void {
    this.clearTimers();
    this.dropTransport();
    this.patch({ transport: "blocked", sync: "idle", blockedReason: reason });
  }

  private reconnect(reason: string): void {
    this.clearTimers();
    this.dropTransport();
    this.patch({ blockedReason: reason });
    this.connect();
  }

  private dropTransport(): void {
    this.generation++;
    this.connecting = false;
    this.transport?.close();
    this.transport = null;
  }

  private clearTimers(): void {
    this.clearRetryTimer();
    this.clearStableTimer();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearStableTimer(): void {
    if (this.stableTimer === null) return;
    this.scheduler.clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private patch(update: Partial<SupervisorState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of [...this.listeners]) listener(this.getState());
  }
}

function defaultCommandId(): string {
  return `c-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

import type {
  BranchSessionFile,
  CreateSessionOptions,
  PiSession,
  SessionInfo,
} from "./types.ts";
import { InProcessSession, type AgentSessionFactory } from "./in-process.ts";
import { SubprocessSession, type SubprocessOptions } from "./subprocess.ts";

export interface RestartableSession extends PiSession {
  restart(reason: string): Promise<void>;
}

/**
 * A session whose process can be stopped and started again underneath it.
 *
 * Sleeping is invisible from outside: the id, the transcript, and the
 * subscribers all survive, because none of them ever lived in the process.
 */
export interface SleepableSession {
  readonly awake: boolean;
  readonly lastActivityAt: number;
  sleep(): Promise<void>;
}

export interface SessionHost {
  create(options: CreateSessionOptions): Promise<RestartableSession>;
}

export interface RegistryOptions {
  /** Attempts before a session is left `crashed` for the user to deal with. */
  maxRestarts?: number;
  /** Backoff before each restart, capped like every other retry ladder here. */
  restartDelayMs?: number;
  /** Idle time before a session's process is stopped. 0 disables the sweep. */
  idleMs?: number;
  /** How often idle sessions are looked for. */
  sweepIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Observer for every session this registry owns, live and restarted. */
  onCreate?: (session: RestartableSession) => void;
  onDispose?: (id: string) => void;
}

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_RESTART_DELAY_MS = 500;
/** Long enough to step away from a conversation and come back to it warm. */
const DEFAULT_IDLE_MS = 30 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/** A session that ran this long before dying is treated as healthy again. */
const HEALTHY_UPTIME_MS = 60_000;

export function inProcessHost(
  factory: AgentSessionFactory,
  branchSessionFile?: BranchSessionFile,
): SessionHost {
  return { create: (options) => InProcessSession.start(options, factory, branchSessionFile) };
}

export function subprocessHost(options: SubprocessOptions = {}): SessionHost {
  return {
    create: async (createOptions) => SubprocessSession.start(createOptions, options),
  };
}

/**
 * Owns the live sessions and the crash policy.
 *
 * Recovery restarts on the same session id, so pi reloads what it persisted.
 * An in-flight assistant turn is not in that file, so the client sees the
 * conversation rewind to the last durable entry; `session_recovered` carries
 * the resulting `leafId` precisely so it can notice.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, RestartableSession>();
  /**
   * Starts still waiting on their process. A cold session can take seconds to
   * load its transcript, and every command that arrives meanwhile would
   * otherwise start its own pi on the same file, each forking the transcript.
   */
  private readonly starting = new Map<string, Promise<RestartableSession>>();
  private readonly restarts = new Map<string, number>();
  private readonly startedAt = new Map<string, number>();
  private readonly options: Required<Omit<RegistryOptions, "onCreate" | "onDispose">> &
    Pick<RegistryOptions, "onCreate" | "onDispose">;
  private readonly host: SessionHost;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(host: SessionHost, options: RegistryOptions = {}) {
    this.host = host;
    this.options = {
      maxRestarts: options.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      restartDelayMs: options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
      idleMs: options.idleMs ?? DEFAULT_IDLE_MS,
      sweepIntervalMs: options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      onCreate: options.onCreate,
      onDispose: options.onDispose,
    };
    if (this.options.idleMs > 0) {
      this.sweepTimer = setInterval(() => void this.sweep(), this.options.sweepIntervalMs);
      // The sweep is housekeeping; it must never hold the daemon open.
      this.sweepTimer.unref?.();
    }
  }

  /**
   * Stops the process of every session idle for too long.
   *
   * Browsing a list of conversations should not leave a `pi` process resident
   * for each one. What is never reaped: a session that is working, and one
   * blocked on a dialog, because killing that discards a question the user was
   * about to answer and there is no way to ask it again.
   */
  async sweep(): Promise<void> {
    const deadline = this.options.now() - this.options.idleMs;
    const asleep = [...this.sessions.values()]
      .filter(isSleepable)
      .filter((session) => session.awake && session.lastActivityAt <= deadline)
      .filter((session) => session.info.status === "idle" && session.pendingDialogs.length === 0)
      .map((session) => session.sleep());
    await Promise.all(asleep);
  }

  /**
   * Starts a session, or joins the one already live or starting under the
   * same id. A joining caller's options are ignored: the first start wins.
   */
  async create(options: CreateSessionOptions): Promise<RestartableSession> {
    const id = options.id;
    if (id === undefined) return this.start(options);

    const existing = this.sessions.get(id) ?? this.starting.get(id);
    if (existing) return existing;

    const start = this.start(options);
    this.starting.set(id, start);
    try {
      return await start;
    } finally {
      this.starting.delete(id);
    }
  }

  private async start(options: CreateSessionOptions): Promise<RestartableSession> {
    const session = await this.host.create(options);
    this.sessions.set(session.id, session);
    this.startedAt.set(session.id, this.options.now());
    this.restarts.set(session.id, 0);

    if (hasExitHandler(session)) {
      session.setExitHandler((info) =>
        void this.recover(session.id, `pi exited (code ${info.code}, signal ${info.signal})`),
      );
    }
    this.options.onCreate?.(session);
    return session;
  }

  get(id: string): RestartableSession | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((session) => session.info);
  }

  /**
   * Trust change on a live session. Counted as a fresh start, so an intended
   * relaunch does not eat into the crash budget.
   */
  async setProjectTrust(id: string, trustProject: boolean): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || session.info.status === "disposed") return false;
    await session.setProjectTrust(trustProject);
    this.countAsFreshStart(id);
    return true;
  }

  /** pi's `/reload`, counted as a fresh start for the same reason as trust. */
  async reload(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || session.info.status === "disposed") return false;
    await session.reload();
    this.countAsFreshStart(id);
    return true;
  }

  private countAsFreshStart(id: string): void {
    this.startedAt.set(id, this.options.now());
    this.restarts.set(id, 0);
  }

  async dispose(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.restarts.delete(id);
    this.startedAt.delete(id);
    this.options.onDispose?.(id);
    await session.dispose();
  }

  async disposeAll(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await Promise.allSettled(this.starting.values());
    await Promise.all([...this.sessions.keys()].map((id) => this.dispose(id)));
  }

  /**
   * Restarts a dead session, or gives up and leaves it `crashed`.
   *
   * A session that stayed up long enough before dying gets a fresh budget:
   * one crash an hour is a bad day, three crashes in a second is a crash loop
   * and restarting again just burns the machine.
   */
  async recover(id: string, reason: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || session.info.status === "disposed") return false;

    const uptime = this.options.now() - (this.startedAt.get(id) ?? 0);
    if (uptime >= HEALTHY_UPTIME_MS) this.restarts.set(id, 0);

    const attempts = this.restarts.get(id) ?? 0;
    if (attempts >= this.options.maxRestarts) {
      console.error(`[pi-host] session ${id} exceeded ${this.options.maxRestarts} restarts`);
      return false;
    }
    this.restarts.set(id, attempts + 1);

    await this.options.sleep(this.options.restartDelayMs);
    if (!this.sessions.has(id)) return false;

    try {
      await session.restart(reason);
      this.startedAt.set(id, this.options.now());
      return true;
    } catch (error) {
      console.error(`[pi-host] restart of session ${id} failed: ${String(error)}`);
      return false;
    }
  }
}

function isSleepable(
  session: RestartableSession,
): session is RestartableSession & SleepableSession {
  return typeof (session as { sleep?: unknown }).sleep === "function";
}

function hasExitHandler(
  session: PiSession,
): session is PiSession & { setExitHandler(h: (i: { code: number | null; signal: string | null }) => void): void } {
  return typeof (session as { setExitHandler?: unknown }).setExitHandler === "function";
}

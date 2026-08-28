import type { CreateSessionOptions, PiSession, SessionInfo } from "./types.ts";
import { InProcessSession, type AgentSessionFactory } from "./in-process.ts";
import { SubprocessSession, type SubprocessOptions } from "./subprocess.ts";

export interface RestartableSession extends PiSession {
  restart(reason: string): Promise<void>;
}

export interface SessionHost {
  create(options: CreateSessionOptions): Promise<RestartableSession>;
}

export interface RegistryOptions {
  /** Attempts before a session is left `crashed` for the user to deal with. */
  maxRestarts?: number;
  /** Backoff before each restart, capped like every other retry ladder here. */
  restartDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Observer for every session this registry owns, live and restarted. */
  onCreate?: (session: RestartableSession) => void;
  onDispose?: (id: string) => void;
}

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_RESTART_DELAY_MS = 500;
/** A session that ran this long before dying is treated as healthy again. */
const HEALTHY_UPTIME_MS = 60_000;

export function inProcessHost(factory: AgentSessionFactory): SessionHost {
  return { create: (options) => InProcessSession.start(options, factory) };
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
  private readonly restarts = new Map<string, number>();
  private readonly startedAt = new Map<string, number>();
  private readonly options: Required<Omit<RegistryOptions, "onCreate" | "onDispose">> &
    Pick<RegistryOptions, "onCreate" | "onDispose">;
  private readonly host: SessionHost;

  constructor(host: SessionHost, options: RegistryOptions = {}) {
    this.host = host;
    this.options = {
      maxRestarts: options.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      restartDelayMs: options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      onCreate: options.onCreate,
      onDispose: options.onDispose,
    };
  }

  async create(options: CreateSessionOptions): Promise<RestartableSession> {
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
    this.startedAt.set(id, this.options.now());
    this.restarts.set(id, 0);
    return true;
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

function hasExitHandler(
  session: PiSession,
): session is PiSession & { setExitHandler(h: (i: { code: number | null; signal: string | null }) => void): void } {
  return typeof (session as { setExitHandler?: unknown }).setExitHandler === "function";
}

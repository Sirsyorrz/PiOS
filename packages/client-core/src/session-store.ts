import { TranscriptAssembler, type AgentEvent, type SessionEntry } from "@pios/protocol";
import { readVersioned, writeVersioned, type StorageAdapter } from "./storage.ts";

export const SESSION_CACHE_VERSION = 1;
const STORAGE_PREFIX = "pios.session.";

export interface SessionCache {
  sessionId: string;
  /** Durable resume cursor. */
  cursor: string | null;
  /** Live tail cursor into the daemon's ring buffer. */
  lastSeq: number;
  entries: SessionEntry[];
}

export interface ApplyResult {
  /** The cached transcript was thrown away and rebuilt. */
  reset: boolean;
  applied: number;
}

/**
 * Per-session transcript cache and cursor.
 *
 * Cached entries are for rendering while offline, never for deciding whether
 * the client is up to date. That decision is always `leafId` from the daemon
 * against the cursor held here.
 */
export class SessionStore {
  private readonly caches = new Map<string, SessionCache>();
  private readonly assemblers = new Map<string, TranscriptAssembler>();
  /** Last status the daemon reported. Never persisted: it is live state. */
  private readonly daemonStatus = new Map<string, string>();
  /** Interrupt sent, agent not yet observed stopping. */
  private readonly interrupting = new Set<string>();
  private readonly storage: StorageAdapter | null;
  private readonly listeners = new Set<(sessionId: string) => void>();

  constructor(storage?: StorageAdapter) {
    this.storage = storage ?? null;
  }

  get(sessionId: string): SessionCache {
    const existing = this.caches.get(sessionId);
    if (existing) return existing;

    const loaded = this.storage
      ? readVersioned<SessionCache | null>(
          this.storage,
          STORAGE_PREFIX + sessionId,
          SESSION_CACHE_VERSION,
          null,
        )
      : null;
    const cache = loaded ?? { sessionId, cursor: null, lastSeq: 0, entries: [] };
    this.caches.set(sessionId, cache);
    return cache;
  }

  /** Cursor to send with `get_entries`. Null means "send everything". */
  cursor(sessionId: string): string | null {
    return this.get(sessionId).cursor;
  }

  lastSeq(sessionId: string): number {
    return this.get(sessionId).lastSeq;
  }

  subscribe(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Applies an `entries` response.
   *
   * `reset` from the daemon means the cursor was not recognised and the
   * payload is the whole session, so the cache is replaced rather than
   * appended to. Appending would splice a duplicate history onto the front.
   */
  applyEntries(
    sessionId: string,
    entries: SessionEntry[],
    leafId: string | null,
    reset: boolean,
  ): ApplyResult {
    const cache = this.get(sessionId);
    if (reset) {
      cache.entries = [...entries];
    } else {
      const known = new Set(cache.entries.map((e) => e.id));
      for (const entry of entries) {
        if (known.has(entry.id)) continue;
        cache.entries.push(entry);
      }
    }
    cache.cursor = leafId ?? cache.entries.at(-1)?.id ?? null;
    this.persist(cache);
    return { reset, applied: entries.length };
  }

  /**
   * Compares a freshly reported leaf against the cursor.
   *
   * A leaf the cache has never seen means the branch moved, usually because
   * another client forked or switched sessions. There is no safe incremental
   * fix for that, so the answer is always a full refetch.
   */
  needsFullRefetch(sessionId: string, leafId: string | null): boolean {
    const cache = this.get(sessionId);
    if (leafId === null) return cache.entries.length > 0;
    if (cache.cursor === leafId) return false;
    return !cache.entries.some((entry) => entry.id === leafId);
  }

  /** Live events, applied to the in-memory transcript only. */
  applyEvent(sessionId: string, seq: number, event: AgentEvent): void {
    const cache = this.get(sessionId);
    cache.lastSeq = Math.max(cache.lastSeq, seq);
    this.assembler(sessionId).apply(event);
    if (event.type === "agent_settled") this.interrupting.delete(sessionId);
    this.notify(sessionId);
  }

  transcript(sessionId: string) {
    return this.assembler(sessionId).snapshot();
  }

  /**
   * The daemon's view of whether the agent is working.
   *
   * Needed because an aborted turn does not always produce `agent_settled`:
   * without this the transcript would stay "running" forever after a stop.
   */
  setDaemonStatus(sessionId: string, status: string): void {
    if (this.daemonStatus.get(sessionId) === status) return;
    this.daemonStatus.set(sessionId, status);
    if (status !== "running") this.interrupting.delete(sessionId);
    this.notify(sessionId);
  }

  status(sessionId: string): string | undefined {
    return this.daemonStatus.get(sessionId);
  }

  setInterrupting(sessionId: string, interrupting: boolean): void {
    if (interrupting) this.interrupting.add(sessionId);
    else this.interrupting.delete(sessionId);
    this.notify(sessionId);
  }

  isInterrupting(sessionId: string): boolean {
    return this.interrupting.has(sessionId);
  }

  /** Drops everything for a session, for a reset or a dispose. */
  clear(sessionId: string): void {
    this.caches.delete(sessionId);
    this.assemblers.delete(sessionId);
    this.daemonStatus.delete(sessionId);
    this.interrupting.delete(sessionId);
    this.storage?.remove(STORAGE_PREFIX + sessionId);
    this.notify(sessionId);
  }

  /** After a gap the tail is incomplete, so the live transcript is rebuilt. */
  resetLiveTranscript(sessionId: string): void {
    this.assemblers.delete(sessionId);
    const cache = this.get(sessionId);
    cache.lastSeq = 0;
    this.persist(cache);
  }

  private assembler(sessionId: string): TranscriptAssembler {
    let assembler = this.assemblers.get(sessionId);
    if (!assembler) {
      assembler = new TranscriptAssembler();
      this.assemblers.set(sessionId, assembler);
    }
    return assembler;
  }

  private persist(cache: SessionCache): void {
    if (this.storage) {
      writeVersioned(this.storage, STORAGE_PREFIX + cache.sessionId, SESSION_CACHE_VERSION, cache);
    }
    this.notify(cache.sessionId);
  }

  private notify(sessionId: string): void {
    for (const listener of [...this.listeners]) listener(sessionId);
  }
}

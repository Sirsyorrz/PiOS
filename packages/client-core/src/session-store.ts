import {
  TranscriptAssembler,
  applyPresentation,
  emptyPresentation,
  isDialogRequest,
  stripAnsi,
  type AgentEvent,
  type ExtensionUiRequest,
  type SessionEntry,
  type SessionPresentation,
} from "@pios/protocol";
import { readVersioned, writeVersioned, type StorageAdapter } from "./storage.ts";

export const SESSION_CACHE_VERSION = 1;
const STORAGE_PREFIX = "pios.session.";
/** A chatty extension must not be able to bury the transcript. */
const MAX_NOTICES = 3;

export interface Notice {
  id: string;
  message: string;
  type: "info" | "warning" | "error";
}

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
  /**
   * Open extension dialogs, keyed by request id so a resend on reconnect
   * collapses onto the one already shown. Never persisted: only the daemon
   * knows whether one is still waiting.
   */
  private readonly dialogs = new Map<string, Map<string, ExtensionUiRequest>>();
  /** Status lines, widgets and title asked for by extensions. */
  private readonly presentations = new Map<string, SessionPresentation>();
  /** Transient extension messages, newest last. Never restored on reconnect. */
  private readonly notices = new Map<string, Notice[]>();
  private noticeCounter = 0;
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

  openDialog(sessionId: string, request: ExtensionUiRequest): void {
    const open = this.dialogs.get(sessionId) ?? new Map<string, ExtensionUiRequest>();
    if (open.get(request.id)) return;
    open.set(request.id, request);
    this.dialogs.set(sessionId, open);
    this.notify(sessionId);
  }

  closeDialog(sessionId: string, requestId: string): void {
    if (!this.dialogs.get(sessionId)?.delete(requestId)) return;
    this.notify(sessionId);
  }

  /** Oldest first, so answering one at a time follows the order asked. */
  openDialogs(sessionId: string): ExtensionUiRequest[] {
    return [...(this.dialogs.get(sessionId)?.values() ?? [])];
  }

  /**
   * Applies one non-blocking extension request.
   *
   * `notify` is the only one that is an event rather than state: replaying it
   * on reconnect would show a message about something that already happened.
   */
  applyPresentationRequest(sessionId: string, request: ExtensionUiRequest): void {
    if (isDialogRequest(request)) return;
    if (request.method === "notify") {
      if (!request.message) return;
      const notices = [...(this.notices.get(sessionId) ?? []), {
        id: `n${++this.noticeCounter}`,
        message: stripAnsi(request.message),
        type: request.notifyType ?? "info",
      }].slice(-MAX_NOTICES);
      this.notices.set(sessionId, notices);
      this.notify(sessionId);
      return;
    }
    const current = this.presentation(sessionId);
    const next = applyPresentation(current, request);
    if (next === current) return;
    this.presentations.set(sessionId, next);
    this.notify(sessionId);
  }

  /** The daemon's snapshot, which supersedes whatever was accumulated live. */
  setPresentation(sessionId: string, presentation: SessionPresentation): void {
    this.presentations.set(sessionId, presentation);
    this.notify(sessionId);
  }

  presentation(sessionId: string): SessionPresentation {
    return this.presentations.get(sessionId) ?? emptyPresentation();
  }

  openNotices(sessionId: string): Notice[] {
    return this.notices.get(sessionId) ?? [];
  }

  dismissNotice(sessionId: string, id: string): void {
    const rest = this.openNotices(sessionId).filter((notice) => notice.id !== id);
    this.notices.set(sessionId, rest);
    this.notify(sessionId);
  }

  /** Drops everything for a session, for a reset or a dispose. */
  clear(sessionId: string): void {
    this.caches.delete(sessionId);
    this.assemblers.delete(sessionId);
    this.daemonStatus.delete(sessionId);
    this.interrupting.delete(sessionId);
    this.dialogs.delete(sessionId);
    this.presentations.delete(sessionId);
    this.notices.delete(sessionId);
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

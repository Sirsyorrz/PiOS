import {
  TranscriptAssembler,
  applyPresentation,
  emptyPresentation,
  isDialogRequest,
  stripAnsi,
  type AgentEvent,
  type BashResult,
  type ExtensionUiRequest,
  type SessionEntry,
  type SessionPresentation,
} from "@pios/protocol";
import { readVersioned, writeVersioned, type StorageAdapter } from "./storage.ts";
import { Listeners } from "./listeners.ts";

export const SESSION_CACHE_VERSION = 2;
const STORAGE_PREFIX = "pios.session.";
/** A chatty extension must not be able to bury the transcript. */
const MAX_NOTICES = 3;

export interface Notice {
  id: string;
  message: string;
  type: "info" | "warning" | "error";
}

/** A `!` command in flight, or the one that just finished. */
export interface BashRun {
  command: string;
  /** Ran with `!!`: shown here, never sent to the model. */
  excludeFromContext: boolean;
  /** Deltas so far, which is all there is until the entry is persisted. */
  output: string;
  running: boolean;
  result?: BashResult;
}

export interface SessionCache {
  sessionId: string;
  /** Durable resume cursor. */
  cursor: string | null;
  /** Live tail cursor into the daemon's ring buffer. */
  lastSeq: number;
  entries: SessionEntry[];
  /** Index of the first held entry within the whole transcript. */
  offset: number;
  /** Entries the whole transcript has, so the UI knows more exist above. */
  total: number;
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
  /**
   * When the session last became blocked on a dialog. A blocked agent runs
   * nothing, so this span is discounted from any tool call in flight.
   */
  private readonly blockedSince = new Map<string, number>();
  /** Status lines, widgets and title asked for by extensions. */
  private readonly presentations = new Map<string, SessionPresentation>();
  /** Transient extension messages, newest last. Never restored on reconnect. */
  private readonly notices = new Map<string, Notice[]>();
  /** Live `!` command per session. pi runs one at a time. */
  private readonly bashRuns = new Map<string, BashRun>();
  private noticeCounter = 0;
  private readonly storage: StorageAdapter | null;
  private readonly listeners = new Listeners<[sessionId: string]>();

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
    const cache = loaded ?? {
      sessionId,
      cursor: null,
      lastSeq: 0,
      entries: [],
      offset: 0,
      total: 0,
    };
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

  /** Where the held transcript starts, which is the next backfill's `before`. */
  firstHeldIndex(sessionId: string): number {
    return this.get(sessionId).offset;
  }

  /** True when the transcript continues above what is held here. */
  hasOlder(sessionId: string): boolean {
    return this.get(sessionId).offset > 0;
  }

  /**
   * Prepends a page of older entries.
   *
   * A chat is read from the bottom, so history above the first held entry is
   * fetched only when someone scrolls up to look for it.
   */
  applyOlderEntries(sessionId: string, entries: SessionEntry[], offset: number, total: number): void {
    const cache = this.get(sessionId);
    if (!entries.length) {
      cache.offset = offset;
      this.persistAndNotify(cache);
      return;
    }
    const known = new Set(cache.entries.map((entry) => entry.id));
    cache.entries = [...entries.filter((entry) => !known.has(entry.id)), ...cache.entries];
    cache.offset = offset;
    cache.total = Math.max(total, cache.total);
    this.persistAndNotify(cache);
  }

  subscribe(listener: (sessionId: string) => void): () => void {
    return this.listeners.add(listener);
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
    page?: { offset: number; total: number },
  ): ApplyResult {
    const cache = this.get(sessionId);
    if (page) {
      cache.total = Math.max(page.total, cache.total);
      // A tail page starts partway in; a delta does not move where the held
      // transcript begins.
      if (reset || cache.entries.length === 0) cache.offset = page.offset;
    }
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
    // A finished command is held on screen until pi's own entry for it lands,
    // so the output never blinks out between the two.
    const bash = this.bashRuns.get(sessionId);
    if (bash && !bash.running && entries.some((entry) => isBashEntry(entry, bash.command))) {
      this.bashRuns.delete(sessionId);
    }
    this.persistAndNotify(cache);
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
    // Null is "not known from here", not "empty": a cold session reports no
    // leaf because its cursor lives in its file, and throwing the cache away
    // for that would refetch every transcript on every reconnect.
    if (leafId === null) return false;
    if (cache.cursor === leafId) return false;
    return !cache.entries.some((entry) => entry.id === leafId);
  }

  /**
   * Live events, applied to the in-memory transcript only.
   *
   * `at` is the daemon's clock at publish. Daemon timestamps are rewritten
   * into the local clock here, so nothing downstream has to know that two
   * machines with two clocks are involved.
   */
  applyEvent(sessionId: string, seq: number, event: AgentEvent, at?: number): void {
    const cache = this.get(sessionId);
    cache.lastSeq = seq;
    this.assembler(sessionId).apply(localise(event, at));
    if (event.type === "bash_execution_update") this.appendBashOutput(sessionId, event.delta);
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
    // No process means no turn: whatever was in flight died with it, e.g. a
    // daemon restart or an OOM kill.
    if (status === "cold" || status === "crashed") this.assemblers.get(sessionId)?.abandon();
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

  /** A command started. Output arrives afterwards, as deltas. */
  startBash(sessionId: string, command: string, excludeFromContext: boolean): void {
    this.bashRuns.set(sessionId, { command, excludeFromContext, output: "", running: true });
    this.notify(sessionId);
  }

  finishBash(sessionId: string, result: BashResult): void {
    const run = this.bashRuns.get(sessionId);
    if (!run) return;
    // pi's result carries the whole output; the deltas were only the preview.
    this.bashRuns.set(sessionId, {
      ...run,
      running: false,
      result,
      output: result.output || run.output,
    });
    this.notify(sessionId);
  }

  bash(sessionId: string): BashRun | null {
    return this.bashRuns.get(sessionId) ?? null;
  }

  private appendBashOutput(sessionId: string, delta: string): void {
    const run = this.bashRuns.get(sessionId);
    if (!run || !run.running) return;
    this.bashRuns.set(sessionId, { ...run, output: run.output + delta });
  }

  openDialog(sessionId: string, request: ExtensionUiRequest): void {
    const open = this.dialogs.get(sessionId) ?? new Map<string, ExtensionUiRequest>();
    if (open.get(request.id)) return;
    open.set(request.id, request);
    this.dialogs.set(sessionId, open);
    if (open.size === 1) this.blockedSince.set(sessionId, Date.now());
    this.notify(sessionId);
  }

  closeDialog(sessionId: string, requestId: string): void {
    if (!this.dialogs.get(sessionId)?.delete(requestId)) return;
    if (this.dialogs.get(sessionId)?.size === 0) this.unblock(sessionId);
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
      if (request.message) this.addNotice(sessionId, stripAnsi(request.message), request.notifyType);
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

  /** A message for the reader, shown with the extension's own until dismissed. */
  addNotice(sessionId: string, message: string, type: Notice["type"] = "info"): void {
    const notices = [...(this.notices.get(sessionId) ?? []), {
      id: `n${++this.noticeCounter}`,
      message,
      type,
    }].slice(-MAX_NOTICES);
    this.notices.set(sessionId, notices);
    this.notify(sessionId);
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
    this.blockedSince.delete(sessionId);
    this.presentations.delete(sessionId);
    this.notices.delete(sessionId);
    this.bashRuns.delete(sessionId);
    this.storage?.remove(STORAGE_PREFIX + sessionId);
    this.notify(sessionId);
  }

  /**
   * Adopts the daemon's live cursor as reported on subscribe.
   *
   * seq only means anything within one session process. A cursor kept from an
   * earlier one is ahead of a counter that restarted at 1, and comparing the
   * two would silently drop every event of the turn in flight.
   */
  setLastSeq(sessionId: string, seq: number): void {
    const cache = this.get(sessionId);
    if (cache.lastSeq === seq) return;
    cache.lastSeq = seq;
    this.persistAndNotify(cache);
  }

  /** After a gap the tail is incomplete, so the live transcript is rebuilt. */
  resetLiveTranscript(sessionId: string): void {
    this.assemblers.delete(sessionId);
    const cache = this.get(sessionId);
    cache.lastSeq = 0;
    this.persistAndNotify(cache);
  }

  private unblock(sessionId: string): void {
    const since = this.blockedSince.get(sessionId);
    if (since === undefined) return;
    this.blockedSince.delete(sessionId);
    this.assembler(sessionId).excludeSince(since);
  }

  private assembler(sessionId: string): TranscriptAssembler {
    let assembler = this.assemblers.get(sessionId);
    if (!assembler) {
      assembler = new TranscriptAssembler();
      this.assemblers.set(sessionId, assembler);
    }
    return assembler;
  }

  private persistAndNotify(cache: SessionCache): void {
    if (this.storage) {
      writeVersioned(this.storage, STORAGE_PREFIX + cache.sessionId, SESSION_CACHE_VERSION, cache);
    }
    this.notify(cache.sessionId);
  }

  private notify(sessionId: string): void {
    this.listeners.emit(sessionId);
  }
}

/**
 * Rewrites a daemon timestamp into the local clock.
 *
 * The offset is measured per event from `at`, so it also absorbs transport
 * latency: a running tool then reads as at-least-this-old rather than
 * in-the-future, which is the safe direction for a live counter.
 */
function isBashEntry(entry: SessionEntry, command: string): boolean {
  return entry.message?.role === "bashExecution" && entry.message.command === command;
}

function localise(event: AgentEvent, at?: number): AgentEvent {
  if (event.type !== "tool_execution_start" || event.startedAt === undefined) return event;
  const skew = at === undefined ? 0 : Date.now() - at;
  return { ...event, startedAt: event.startedAt + skew };
}

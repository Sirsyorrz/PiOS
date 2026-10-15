import {
  WIRE_VERSION,
  isDialogRequest,
  type ClientFrame,
  type ImageContent,
  type CommandOption,
  type ModelOption,
  type SessionStats,
  type ServerFrame,
  type SessionSummary,
  type StreamingBehavior,
} from "@pios/protocol";
import { AppStatePolicy } from "./app-state.ts";
import type { BackoffOptions } from "./backoff.ts";
import { Listeners } from "./listeners.ts";
import { ThreadOutbox, outboxFrame, type OutboxEntry } from "./outbox.ts";
import { SessionStore } from "./session-store.ts";
import { TerminalChannel } from "./terminal.ts";
import { systemScheduler, type Scheduler } from "./scheduler.ts";
import {
  MemoryStorage,
  readVersioned,
  writeVersioned,
  type StorageAdapter,
} from "./storage.ts";
import {
  ConnectionSupervisor,
  type Credentials,
  type SupervisorOptions,
  type SupervisorState,
} from "./supervisor.ts";

type FrameOf<T extends ServerFrame["type"]> = Extract<ServerFrame, { type: T }>;

/** A command frame minus the envelope the client fills in for every send. */
type Command = ClientFrame extends infer Frame
  ? Frame extends { commandId: string }
    ? Omit<Frame, "v" | "commandId">
    : never
  : never;

/** A one-off command the daemon refused, with the id that identified it. */
export interface CommandError {
  commandId?: string;
  message: string;
}

export interface ModelListing {
  models: ModelOption[];
  /** The full catalogue rather than the session's scope. */
  all: boolean;
}

export interface ListQuery {
  /** Restrict to one project directory. Omitted means every project. */
  cwd?: string;
  /** Matched by the daemon against path, name and preview. */
  query?: string;
  limit?: number;
  offset?: number;
}

/** What it takes to bring a session into being, sent by whatever needs it first. */
export interface SessionCreate {
  cwd: string;
  name?: string;
  trustProject?: boolean;
  model?: string;
}

/** Entries fetched at a time. A chat is read from the bottom, not the top. */
const ENTRY_PAGE = 200;
const SESSIONS_KEY = "pios.sessions";
const SESSIONS_VERSION = 1;

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
  /** Interactive shells on the machine, over the same socket. */
  readonly terminals: TerminalChannel;

  private readonly scheduler: Scheduler;
  private readonly storage: StorageAdapter;
  private readonly generateId: () => string;
  /** Sessions the UI wants live, re-subscribed on every reconnect. */
  private readonly subscribed = new Set<string>();
  /** The query behind the list on screen, replayed on a store change. */
  private lastListing: ListQuery = {};
  private readonly sessionsChangedHandlers = new Listeners<[]>();
  /**
   * Commands whose failure means the transcript is stale.
   *
   * Only these turn into a sync error. A rejected one-off command (an old
   * daemon that does not know the frame, a busy agent) says nothing about
   * whether the cached transcript is current, and reporting it as "out of
   * sync" sends the user looking for a problem that is not there.
   */
  private readonly syncCommands = new Set<string>();
  /** Backfill requests, whose reply prepends history instead of appending. */
  private readonly olderRequests = new Set<string>();
  /** Model lists by session, from the last `listModels`. */
  private readonly models = new Map<string, ModelListing>();
  /** The last model question per session, re-asked on reconnect. */
  private readonly modelsWanted = new Map<string, { all: boolean; create?: SessionCreate }>();
  /** Sessions whose commands were asked for, re-asked on reconnect. */
  private readonly commandsWanted = new Set<string>();
  private readonly modelHandlers = new Listeners<[sessionId: string, listing: ModelListing]>();
  /** Slash commands by session, from the last `listCommands`. Never persisted. */
  private readonly commands = new Map<string, CommandOption[]>();
  private readonly commandHandlers = new Listeners<[sessionId: string, commands: CommandOption[]]>();
  /** Session accounting by session, from the last `requestStats`. */
  private readonly stats = new Map<string, SessionStats>();
  /** Sessions whose stats were asked for, re-asked on reconnect. */
  private readonly statsWanted = new Set<string>();
  private readonly statsHandlers = new Listeners<[sessionId: string, stats: SessionStats]>();
  /** Failures of one-off commands, for the UI to say out loud. */
  private readonly commandErrorHandlers = new Listeners<[error: CommandError]>();
  private readonly rewindHandlers = new Listeners<[branchSessionId: string, text: string]>();
  private readonly exportHandlers = new Listeners<[sessionId: string, path: string]>();
  /** Text waiting for the branched session's composer to mount and claim it. */
  private readonly rewoundText = new Map<string, string>();
  private lastTransport: SupervisorState["transport"] = "idle";

  constructor(options: PiosClientOptions) {
    this.scheduler = options.scheduler ?? systemScheduler;
    this.generateId = options.generateId ?? defaultId;
    const storage = options.storage ?? new MemoryStorage();
    this.storage = storage;

    this.supervisor = new ConnectionSupervisor({ ...options, scheduler: this.scheduler });
    // The list from last time, so a cold launch shows conversations instead of
    // an empty screen while the socket comes up.
    this.supervisor.seedSessions(
      readVersioned<SessionSummary[]>(storage, SESSIONS_KEY, SESSIONS_VERSION, []),
    );
    this.sessions = new SessionStore(storage);
    this.outbox = new ThreadOutbox({
      storage,
      scheduler: this.scheduler,
      backoff: options.outboxBackoff ?? options.backoff,
      send: (entry) => this.supervisor.send(outboxFrame(entry)),
    });
    this.appState = new AppStatePolicy(this.supervisor, { scheduler: this.scheduler });
    this.terminals = new TerminalChannel(
      (command, commandId) => this.send(command, commandId),
      this.generateId,
    );

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
    /**
     * Starts the session, for the first prompt of a draft. The session takes
     * the id composed against, so nothing has to be renamed afterwards.
     */
    create?: SessionCreate;
  }): OutboxEntry {
    return this.outbox.enqueue({
      messageId: this.generateId(),
      commandId: this.generateId(),
      sessionId: args.sessionId,
      text: args.text,
      images: args.images ?? [],
      streamingBehavior: args.streamingBehavior,
      create: args.create,
    });
  }

  /** A session id to compose against before the session exists. */
  newSessionId(): string {
    return this.generateId();
  }

  /**
   * Asks for a page of the session list.
   *
   * The list is every session on disk, running or not, so it is paged and
   * searched on the daemon rather than filtered here: the rows past the first
   * page are not on this device to filter.
   */
  listSessions(query: ListQuery = {}): boolean {
    this.lastListing = query;
    return this.send({
      type: "list_sessions",
      cwd: query.cwd,
      query: query.query,
      limit: query.limit,
      offset: query.offset,
    });
  }

  /** Fires when the store changed on disk and the list should be re-asked. */
  onSessionsChanged(handler: () => void): () => void {
    return this.sessionsChangedHandlers.add(handler);
  }

  /**
   * Asks what this session can run on: its model scope, or everything.
   *
   * Not queued: the answer depends on which providers are authenticated right
   * now, so a reply to a question asked before a reconnect is not worth
   * replaying.
   */
  listModels(
    sessionId: string,
    options: { all?: boolean; create?: SessionCreate } = {},
  ): boolean {
    // Asked on mount, which after a cold launch is before the socket is up.
    const wanted = { all: options.all ?? false, create: options.create };
    this.modelsWanted.set(sessionId, wanted);
    return this.sendListModels(sessionId, wanted);
  }

  private sendListModels(sessionId: string, wanted: { all: boolean; create?: SessionCreate }): boolean {
    return this.send({
      type: "list_models",
      sessionId,
      all: wanted.all,
      create: wanted.create
        ? { ...wanted.create, trustProject: wanted.create.trustProject ?? false }
        : undefined,
    });
  }

  getModels(sessionId: string): ModelListing {
    return this.models.get(sessionId) ?? { models: [], all: false };
  }

  /**
   * Asks which slash commands this session can invoke.
   *
   * Not queued, for the same reason as `listModels`: extensions, templates and
   * skills can be reloaded under the daemon, so a stale answer is worse than
   * no answer and the list is re-asked rather than replayed.
   */
  listCommands(sessionId: string): boolean {
    this.commandsWanted.add(sessionId);
    return this.send({ type: "list_commands", sessionId });
  }

  getCommands(sessionId: string): CommandOption[] {
    return this.commands.get(sessionId) ?? [];
  }

  onCommands(handler: (sessionId: string, commands: CommandOption[]) => void): () => void {
    return this.commandHandlers.add(handler);
  }

  /**
   * Asks for the session's token, cost and context accounting.
   *
   * Not queued: the numbers move with every turn, so a reply to a question
   * asked before a reconnect describes a session that no longer exists.
   */
  requestStats(sessionId: string): boolean {
    // A request dropped while offline, or a turn that settled while offline,
    // would otherwise leave the numbers from before it until the next turn.
    this.statsWanted.add(sessionId);
    return this.send({ type: "get_stats", sessionId });
  }

  getStats(sessionId: string): SessionStats | null {
    return this.stats.get(sessionId) ?? null;
  }

  onStats(handler: (sessionId: string, stats: SessionStats) => void): () => void {
    return this.statsHandlers.add(handler);
  }

  onModels(handler: (sessionId: string, listing: ModelListing) => void): () => void {
    return this.modelHandlers.add(handler);
  }

  /**
   * Switches the model for one session.
   *
   * The daemon answers with `session_state`, so every device sees the switch,
   * not just the one that asked.
   */
  setModel(sessionId: string, provider: string, modelId: string): boolean {
    return this.send({ type: "set_model", sessionId, provider, modelId });
  }

  /**
   * Switches the thinking level for one session.
   *
   * Not queued, like `set_model`: the levels on offer belong to the model that
   * is loaded now, so replaying a stale choice after a reconnect is wrong.
   */
  setThinkingLevel(sessionId: string, level: string): boolean {
    return this.send({ type: "set_thinking_level", sessionId, level });
  }

  /**
   * Names a session, as pi's `/name` does.
   *
   * Not queued: renaming is a reply to what is on screen now. The daemon
   * answers with `session_state` and nudges every device's list.
   */
  setSessionName(sessionId: string, name: string): boolean {
    return this.send({ type: "set_session_name", sessionId, name });
  }

  /**
   * Summarises the history so far, as pi's `/compact` does.
   *
   * Not queued: a compaction replayed after a reconnect would summarise a
   * conversation that has moved on. Its progress arrives as events.
   */
  compact(sessionId: string, customInstructions?: string): boolean {
    return this.send({ type: "compact", sessionId, customInstructions: customInstructions || undefined });
  }

  /** pi's own setting: it applies to every session, here and in the TUI. */
  setAutoCompaction(sessionId: string, enabled: boolean): boolean {
    return this.send({ type: "set_auto_compaction", sessionId, enabled });
  }

  /**
   * pi's `/reload`. Not queued: a reload replayed later would cut off a turn
   * started since. The daemon refuses while the agent is busy, and the new
   * agent is announced with `session_recovered`.
   */
  reload(sessionId: string): boolean {
    return this.send({ type: "reload_session", sessionId });
  }

  /**
   * pi's `/export` to HTML, written on the machine. Not queued: the file
   * would describe the conversation as it was when the reply finally ran.
   */
  exportSession(sessionId: string, outputPath?: string): boolean {
    return this.send({ type: "export_session", sessionId, outputPath: outputPath || undefined });
  }

  /** Fires with the absolute path an export was written to. */
  onExported(handler: (sessionId: string, path: string) => void): () => void {
    return this.exportHandlers.add(handler);
  }

  /**
   * Relaunches a session with project trust enabled.
   *
   * The session id does not change, so the open transcript stays open; the
   * daemon answers with `session_state` and pushes a `session_recovered`
   * event once pi is back.
   */
  setSessionTrust(sessionId: string, trustProject: boolean): boolean {
    return this.send({ type: "set_session_trust", sessionId, trustProject });
  }

  /**
   * Reports what this client is looking at.
   *
   * The daemon uses it to decide whether a settled session needs a push: a
   * phone already showing the transcript does not. Advisory and fire and
   * forget, so it is never queued or retried; a lost report costs at most one
   * redundant notification.
   */
  reportActivity(activity: {
    visible: boolean;
    focused: boolean;
    appState: "active" | "inactive" | "background";
    sessionIds?: string[];
  }): boolean {
    return this.send({
      type: "activity",
      visible: activity.visible,
      focused: activity.focused,
      appState: activity.appState,
      sessionIds: activity.sessionIds ?? [...this.subscribed],
    });
  }

  /**
   * Continues from just before a user turn, in a new session.
   *
   * The daemon branches the history into a session of its own and answers with
   * its id; this session is left alone, so nothing cached about it is stale.
   */
  rewind(sessionId: string, entryId: string): boolean {
    return this.send({ type: "rewind", sessionId, entryId });
  }

  /** Fires with the branched session to open and the text it starts from. */
  onRewound(handler: (branchSessionId: string, text: string) => void): () => void {
    return this.rewindHandlers.add(handler);
  }

  /**
   * Claims the text a rewind left for a session, once only.
   *
   * The branched session's composer is not mounted when the reply lands, so
   * the text waits here instead of being pushed at a component that does not
   * exist yet.
   */
  takeRewoundText(sessionId: string): string | undefined {
    const text = this.rewoundText.get(sessionId);
    this.rewoundText.delete(sessionId);
    return text;
  }

  /** Notifies on a rejected one-off command. Returns an unsubscribe. */
  onCommandError(handler: (error: CommandError) => void): () => void {
    return this.commandErrorHandlers.add(handler);
  }

  /** Re-asks for the list on screen, with the query it was built from. */
  refreshSessions(): boolean {
    return this.listSessions(this.lastListing);
  }

  /**
   * Asks the agent to stop.
   *
   * Marked locally as well as sent, because the stop is not instant and a
   * button that goes back to looking idle reads as "nothing happened".
   */
  interrupt(sessionId: string): boolean {
    const sent = this.send({ type: "interrupt", sessionId });
    if (sent) this.sessions.setInterrupting(sessionId, true);
    return sent;
  }

  /**
   * Runs one shell command in the session cwd, as pi's `!` does.
   *
   * Not queued, unlike a prompt: a command replayed after a reconnect would
   * run against a tree that has moved on. Output arrives as events, and the
   * daemon broadcasts start and end, so every attached device sees the run.
   */
  runBash(sessionId: string, command: string, excludeFromContext = false): boolean {
    return this.send({ type: "run_bash", sessionId, command, excludeFromContext });
  }

  /** Cancels the session's running command. pi runs one at a time. */
  abortBash(sessionId: string): boolean {
    return this.send({ type: "abort_bash", sessionId });
  }

  /**
   * Answers an open extension dialog.
   *
   * Closed locally on send rather than on the daemon's echo: the agent is
   * blocked meanwhile, and a sheet that lingers invites a second answer.
   */
  answerDialog(
    sessionId: string,
    requestId: string,
    answer: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): boolean {
    const sent = this.send({ type: "extension_ui_response", sessionId, requestId, ...answer });
    if (sent) this.sessions.closeDialog(sessionId, requestId);
    return sent;
  }

  /** Marks a session live: subscribed now and after every reconnect. */
  watch(sessionId: string): void {
    this.subscribed.add(sessionId);
    if (this.supervisor.getState().transport === "connected") this.resync(sessionId);
  }

  unwatch(sessionId: string): void {
    this.subscribed.delete(sessionId);
    // Re-asking these wakes the agent, which only a session on screen earns.
    this.modelsWanted.delete(sessionId);
    this.commandsWanted.delete(sessionId);
    this.send({ type: "unsubscribe", sessionId });
  }

  /** Stamps the wire envelope on a command and hands it to the supervisor. */
  private send(command: Command, commandId: string = this.generateId()): boolean {
    // The spread widens the union back to a plain object; the discriminant
    // still comes from `Command`, so the frame is well formed by construction.
    return this.supervisor.send({ ...command, v: WIRE_VERSION, commandId } as ClientFrame);
  }

  private onSupervisorState(state: SupervisorState): void {
    const previous = this.lastTransport;
    this.lastTransport = state.transport;
    // Only the transition into `connected` matters. Reacting to every state
    // emission would resync on the sync-status change that resyncing itself
    // produces, which is an infinite loop.
    if (state.transport !== "connected" || previous === "connected") return;

    for (const sessionId of this.subscribed) {
      this.resync(sessionId);
      if (this.statsWanted.has(sessionId)) this.send({ type: "get_stats", sessionId });
      if (this.commandsWanted.has(sessionId)) this.send({ type: "list_commands", sessionId });
    }
    // Not scoped to subscriptions: a draft asks for models before it exists.
    for (const [sessionId, wanted] of this.modelsWanted) this.sendListModels(sessionId, wanted);
    this.terminals.reconnected();
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
    const subscribeId = this.generateId();
    this.syncCommands.add(subscribeId);
    this.fetchEntries(sessionId, cursor);
    this.send(
      { type: "subscribe", sessionId, sinceSeq: this.sessions.lastSeq(sessionId) },
      subscribeId,
    );
  }

  /**
   * Asks for the entries after a cursor, as a sync command.
   *
   * With no cursor this is a first load, which takes the tail rather than the
   * whole transcript: a long conversation would otherwise cost a phone the
   * entire history to show its last screen.
   */
  private fetchEntries(sessionId: string, cursor: string | null): void {
    const commandId = this.generateId();
    this.syncCommands.add(commandId);
    this.send(
      {
        type: "get_entries",
        sessionId,
        since: cursor ?? undefined,
        limit: cursor ? undefined : ENTRY_PAGE,
      },
      commandId,
    );
  }

  /** Fetches the page of history above what is held. */
  loadOlderEntries(sessionId: string): boolean {
    if (!this.sessions.hasOlder(sessionId)) return false;
    const commandId = this.generateId();
    this.olderRequests.add(commandId);
    return this.send(
      {
        type: "get_entries",
        sessionId,
        before: this.sessions.firstHeldIndex(sessionId),
        limit: ENTRY_PAGE,
      },
      commandId,
    );
  }

  private persistSessions(): void {
    writeVersioned(
      this.storage,
      SESSIONS_KEY,
      SESSIONS_VERSION,
      this.supervisor.getState().sessions,
    );
  }

  private onFrame(frame: ServerFrame): void {
    if (this.terminals.onFrame(frame)) return;
    switch (frame.type) {
      case "ack":
        this.outbox.acknowledge(frame.commandId);
        break;
      case "error":
        this.onError(frame);
        break;
      case "entries":
        this.onEntries(frame);
        break;
      case "subscribed":
        if (frame.commandId) this.syncCommands.delete(frame.commandId);
        // Buffered events were evicted, so the live transcript is missing a
        // middle. Rebuild it from entries instead of pretending it is whole.
        if (frame.gap) this.sessions.resetLiveTranscript(frame.sessionId);
        else this.sessions.setLastSeq(frame.sessionId, frame.seq);
        break;
      case "agent_event":
        this.sessions.applyEvent(frame.sessionId, frame.seq, frame.event, frame.at);
        // A settled turn is on disk, so its entry ids exist. Without this the
        // transcript stays event-only until the next reconnect, and anything
        // that addresses a turn by id has nothing to address.
        // A manual compaction ends without a turn, and its entry is the
        // marker the transcript shows.
        if (frame.event.type === "agent_settled" || frame.event.type === "compaction_end") {
          this.fetchNewEntries(frame.sessionId);
        }
        break;
      case "session_state":
        this.trackStatus([frame.summary]);
        break;
      case "welcome":
        this.trackStatus(frame.sessions);
        // The list is a disk read the daemon does not do unasked, so the first
        // page is asked for as soon as there is a socket to ask on.
        this.listSessions(this.lastListing);
        break;
      case "sessions":
        this.trackStatus(frame.sessions);
        this.persistSessions();
        break;
      case "sessions_changed":
        this.sessionsChangedHandlers.emit();
        break;
      case "commands":
        this.commands.set(frame.sessionId, frame.commands);
        this.commandHandlers.emit(frame.sessionId, frame.commands);
        break;
      case "session_stats":
        this.stats.set(frame.sessionId, frame.stats);
        this.statsHandlers.emit(frame.sessionId, frame.stats);
        break;
      case "models": {
        const listing = { models: frame.models, all: frame.all };
        this.models.set(frame.sessionId, listing);
        this.modelHandlers.emit(frame.sessionId, listing);
        break;
      }
      case "extension_ui_request":
        // Most methods are presentation the agent does not wait on; only a
        // dialog blocks it, and only a dialog gets a sheet.
        if (isDialogRequest(frame.request)) this.sessions.openDialog(frame.sessionId, frame.request);
        else this.sessions.applyPresentationRequest(frame.sessionId, frame.request);
        break;
      case "extension_ui_state":
        this.sessions.setPresentation(frame.sessionId, frame.presentation);
        break;
      case "extension_ui_closed":
        this.sessions.closeDialog(frame.sessionId, frame.requestId);
        break;
      case "bash_state":
        this.onBashState(frame);
        break;
      case "rewound": {
        const text = frame.text ?? "";
        this.rewoundText.set(frame.branchSessionId, text);
        this.rewindHandlers.emit(frame.branchSessionId, text);
        break;
      }
      case "exported":
        this.exportHandlers.emit(frame.sessionId, frame.path);
        break;
      case "session_recovered":
        // The process behind the session was replaced, by a crash, a trust
        // change, a reload, or a wake. Whether the transcript moved is decided
        // by the leaf it came back with, not by assuming either way.
        if (this.sessions.needsFullRefetch(frame.sessionId, frame.leafId)) {
          this.sessions.clear(frame.sessionId);
        }
        if (this.subscribed.has(frame.sessionId)) this.resync(frame.sessionId);
        // A new agent may have loaded different extensions, templates, skills.
        if (this.commandsWanted.has(frame.sessionId)) {
          this.send({ type: "list_commands", sessionId: frame.sessionId });
        }
        break;
      default:
        break;
    }
  }

  private onError(frame: FrameOf<"error">): void {
    if (frame.commandId && this.terminals.onError(frame.commandId, frame.message)) return;
    const queued = frame.commandId ? this.outbox.reject(frame.commandId, frame.message) : false;
    const isSync = !!frame.commandId && this.syncCommands.delete(frame.commandId);
    if (frame.code === "unauthorized") return;
    // A failed resync on a healthy socket is a sync problem, not a
    // transport one, and must not trigger a reconnect.
    if (isSync) this.supervisor.setSyncStatus("error");
    // A queued prompt already carries its own error in the outbox.
    else if (!queued) {
      this.commandErrorHandlers.emit({ commandId: frame.commandId, message: frame.message });
    }
  }

  private onEntries(frame: FrameOf<"entries">): void {
    if (frame.commandId && this.olderRequests.delete(frame.commandId)) {
      this.sessions.applyOlderEntries(frame.sessionId, frame.entries, frame.offset, frame.total);
      return;
    }
    if (frame.commandId) this.syncCommands.delete(frame.commandId);
    this.sessions.applyEntries(frame.sessionId, frame.entries, frame.leafId, frame.reset, {
      offset: frame.offset,
      total: frame.total,
    });
    this.supervisor.setSyncStatus("synced");
  }

  private onBashState(frame: FrameOf<"bash_state">): void {
    if (frame.running) {
      this.sessions.startBash(frame.sessionId, frame.command, frame.excludeFromContext);
      return;
    }
    this.sessions.finishBash(
      frame.sessionId,
      frame.result ?? { output: "", cancelled: false, truncated: false },
    );
    // pi persists the run as an entry of its own, and no `agent_settled`
    // follows a bare command, so nothing else would go and fetch it.
    this.fetchNewEntries(frame.sessionId);
  }

  /** Entries past the cursor, for a session the UI is watching. */
  private fetchNewEntries(sessionId: string): void {
    if (this.subscribed.has(sessionId)) {
      this.fetchEntries(sessionId, this.sessions.cursor(sessionId));
    }
  }

  private trackStatus(summaries: SessionSummary[]): void {
    for (const summary of summaries) {
      this.sessions.setDaemonStatus(summary.sessionId, summary.status);
    }
  }
}

function defaultId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

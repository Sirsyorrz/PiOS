import {
  WIRE_VERSION,
  isDialogRequest,
  type ClientFrame,
  type ImageContent,
  type CommandOption,
  type ModelOption,
  type ResumableSessionWire,
  type SessionStats,
  type SessionSummary,
  type StreamingBehavior,
} from "@pios/protocol";
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
  /** Create commands still waiting for the daemon to name their session. */
  private readonly pendingCreates = new Map<string, (sessionId: string) => void>();
  /**
   * Commands whose failure means the transcript is stale.
   *
   * Only these turn into a sync error. A rejected one-off command (an old
   * daemon that does not know the frame, a busy agent) says nothing about
   * whether the cached transcript is current, and reporting it as "out of
   * sync" sends the user looking for a problem that is not there.
   */
  private readonly syncCommands = new Set<string>();
  /** Sessions on disk, from the last `listResumable`. */
  private resumable: ResumableSessionWire[] = [];
  private readonly resumableHandlers = new Set<(sessions: ResumableSessionWire[]) => void>();
  /** Model lists by session, from the last `listModels`. */
  private readonly models = new Map<string, ModelListing>();
  private readonly modelHandlers = new Set<(sessionId: string, listing: ModelListing) => void>();
  /** Slash commands by session, from the last `listCommands`. Never persisted. */
  private readonly commands = new Map<string, CommandOption[]>();
  private readonly commandHandlers = new Set<
    (sessionId: string, commands: CommandOption[]) => void
  >();
  /** Session accounting by session, from the last `requestStats`. */
  private readonly stats = new Map<string, SessionStats>();
  private readonly statsHandlers = new Set<(sessionId: string, stats: SessionStats) => void>();
  /** Failures of one-off commands, for the UI to say out loud. */
  private readonly commandErrorHandlers = new Set<(error: CommandError) => void>();
  private readonly rewindHandlers = new Set<(branchSessionId: string, text: string) => void>();
  /** Text waiting for the branched session's composer to mount and claim it. */
  private readonly rewoundText = new Map<string, string>();
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
  createSession(
    args: {
      cwd: string;
      name?: string;
      trustProject?: boolean;
      model?: string;
      /**
       * Session file to adopt, from `listResumable`. Continues a transcript
       * started elsewhere, including one started in the pi TUI.
       */
      resumeFrom?: string;
    },
    /** Called once the daemon names the session, so the UI can open it. */
    onCreated?: (sessionId: string) => void,
  ): boolean {
    const commandId = this.generateId();
    if (onCreated) this.pendingCreates.set(commandId, onCreated);
    const sent = this.send(
      {
        type: "create_session",
        cwd: args.cwd,
        name: args.name,
        trustProject: args.trustProject ?? false,
        model: args.model,
        resumeFrom: args.resumeFrom,
      },
      commandId,
    );
    if (!sent) this.pendingCreates.delete(commandId);
    return sent;
  }

  /**
   * Asks for the sessions on disk, including ones this daemon never started.
   *
   * Not queued and not cached across reconnects: the answer is a directory
   * listing, and a stale one is worse than asking again.
   */
  listResumable(args: { cwd?: string; limit?: number } = {}): boolean {
    return this.send({ type: "list_resumable", cwd: args.cwd, limit: args.limit });
  }

  getResumable(): ResumableSessionWire[] {
    return this.resumable;
  }

  onResumable(handler: (sessions: ResumableSessionWire[]) => void): () => void {
    this.resumableHandlers.add(handler);
    return () => this.resumableHandlers.delete(handler);
  }

  /**
   * Asks what this session can run on: its model scope, or everything.
   *
   * Not queued: the answer depends on which providers are authenticated right
   * now, so a reply to a question asked before a reconnect is not worth
   * replaying.
   */
  listModels(sessionId: string, options: { all?: boolean } = {}): boolean {
    return this.send({ type: "list_models", sessionId, all: options.all ?? false });
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
    return this.send({ type: "list_commands", sessionId });
  }

  getCommands(sessionId: string): CommandOption[] {
    return this.commands.get(sessionId) ?? [];
  }

  onCommands(handler: (sessionId: string, commands: CommandOption[]) => void): () => void {
    this.commandHandlers.add(handler);
    return () => this.commandHandlers.delete(handler);
  }

  /**
   * Asks for the session's token, cost and context accounting.
   *
   * Not queued: the numbers move with every turn, so a reply to a question
   * asked before a reconnect describes a session that no longer exists.
   */
  requestStats(sessionId: string): boolean {
    return this.send({ type: "get_stats", sessionId });
  }

  getStats(sessionId: string): SessionStats | null {
    return this.stats.get(sessionId) ?? null;
  }

  onStats(handler: (sessionId: string, stats: SessionStats) => void): () => void {
    this.statsHandlers.add(handler);
    return () => this.statsHandlers.delete(handler);
  }

  onModels(handler: (sessionId: string, listing: ModelListing) => void): () => void {
    this.modelHandlers.add(handler);
    return () => this.modelHandlers.delete(handler);
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

  /** Notifies on a rejected one-off command. Returns an unsubscribe. */
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
    this.rewindHandlers.add(handler);
    return () => this.rewindHandlers.delete(handler);
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

  onCommandError(handler: (error: CommandError) => void): () => void {
    this.commandErrorHandlers.add(handler);
    return () => this.commandErrorHandlers.delete(handler);
  }

  disposeSession(sessionId: string): boolean {
    this.subscribed.delete(sessionId);
    this.models.delete(sessionId);
    this.commands.delete(sessionId);
    this.stats.delete(sessionId);
    this.sessions.clear(sessionId);
    this.supervisor.forgetSession(sessionId);
    return this.send({ type: "dispose_session", sessionId });
  }

  refreshSessions(): boolean {
    return this.send({ type: "list_sessions" });
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
    const subscribeId = this.generateId();
    this.syncCommands.add(subscribeId);
    this.fetchEntries(sessionId, cursor);
    this.send(
      { type: "subscribe", sessionId, sinceSeq: this.sessions.lastSeq(sessionId) },
      subscribeId,
    );
  }

  /** Asks for the entries after a cursor, as a sync command. */
  private fetchEntries(sessionId: string, cursor: string | null): void {
    const commandId = this.generateId();
    this.syncCommands.add(commandId);
    this.send({ type: "get_entries", sessionId, since: cursor ?? undefined }, commandId);
  }

  private onFrame(frame: Parameters<Parameters<ConnectionSupervisor["onFrame"]>[0]>[0]): void {
    switch (frame.type) {
      case "ack":
        this.outbox.acknowledge(frame.commandId);
        break;
      case "error": {
        const queued = frame.commandId ? this.outbox.reject(frame.commandId, frame.message) : false;
        const isSync = !!frame.commandId && this.syncCommands.delete(frame.commandId);
        if (frame.code === "unauthorized") break;
        // A failed resync on a healthy socket is a sync problem, not a
        // transport one, and must not trigger a reconnect.
        if (isSync) this.supervisor.setSyncStatus("error");
        // A queued prompt already carries its own error in the outbox.
        else if (!queued) {
          for (const handler of [...this.commandErrorHandlers]) {
            handler({ commandId: frame.commandId, message: frame.message });
          }
        }
        break;
      }
      case "entries":
        if (frame.commandId) this.syncCommands.delete(frame.commandId);
        this.sessions.applyEntries(frame.sessionId, frame.entries, frame.leafId, frame.reset);
        this.supervisor.setSyncStatus("synced");
        break;
      case "subscribed":
        if (frame.commandId) this.syncCommands.delete(frame.commandId);
        // Buffered events were evicted, so the live transcript is missing a
        // middle. Rebuild it from entries instead of pretending it is whole.
        if (frame.gap) this.sessions.resetLiveTranscript(frame.sessionId);
        break;
      case "agent_event":
        this.sessions.applyEvent(frame.sessionId, frame.seq, frame.event, frame.at);
        // A settled turn is on disk, so its entry ids exist. Without this the
        // transcript stays event-only until the next reconnect, and anything
        // that addresses a turn by id has nothing to address.
        if (frame.event.type === "agent_settled" && this.subscribed.has(frame.sessionId)) {
          this.fetchEntries(frame.sessionId, this.sessions.cursor(frame.sessionId));
        }
        break;
      case "session_state": {
        this.trackStatus([frame.summary]);
        const onCreated = frame.commandId ? this.pendingCreates.get(frame.commandId) : undefined;
        if (frame.commandId) this.pendingCreates.delete(frame.commandId);
        onCreated?.(frame.sessionId);
        break;
      }
      case "welcome":
      case "sessions":
        this.trackStatus(frame.sessions);
        break;
      case "commands": {
        this.commands.set(frame.sessionId, frame.commands);
        for (const handler of [...this.commandHandlers])
          handler(frame.sessionId, frame.commands);
        break;
      }
      case "session_stats": {
        this.stats.set(frame.sessionId, frame.stats);
        for (const handler of [...this.statsHandlers]) handler(frame.sessionId, frame.stats);
        break;
      }
      case "models": {
        const listing = { models: frame.models, all: frame.all };
        this.models.set(frame.sessionId, listing);
        for (const handler of [...this.modelHandlers]) handler(frame.sessionId, listing);
        break;
      }
      case "resumable_sessions":
        this.resumable = frame.sessions;
        for (const handler of [...this.resumableHandlers]) handler(this.resumable);
        break;
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
      case "rewound": {
        const text = frame.text ?? "";
        this.rewoundText.set(frame.branchSessionId, text);
        for (const handler of [...this.rewindHandlers]) handler(frame.branchSessionId, text);
        break;
      }
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

  private trackStatus(summaries: SessionSummary[]): void {
    for (const summary of summaries) {
      this.sessions.setDaemonStatus(summary.sessionId, summary.status);
    }
  }
}

function defaultId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

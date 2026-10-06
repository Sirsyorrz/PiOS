import type { WebSocket } from "ws";
import type {
  BufferedEvent,
  EntriesWindow,
  HostEvent,
  PiSession,
  SessionIndex,
  SessionRegistry,
} from "@pios/pi-host";
import { readTranscript, sliceEntries } from "@pios/pi-host";
import {
  ClientFrameSchema,
  WIRE_VERSION,
  type ClientFrame,
  type ServerFrame,
} from "@pios/protocol";
import type { AuthStore, DeviceRecord } from "./auth.ts";
import type { CommandLedger } from "./dedupe.ts";
import { SERVER_VERSION } from "./config.ts";
import { listSessions, liveSummary, summaryFor } from "./sessions.ts";
import type { TrustStore } from "./trust.ts";

type FrameOf<T extends ClientFrame["type"]> = Extract<ClientFrame, { type: T }>;

/** Well under what the relay hop accepts in one message. */
const ENTRIES_FRAME_BYTES = 4 * 1024 * 1024;

export interface ConnectionDeps {
  auth: AuthStore;
  registry: SessionRegistry;
  ledger: CommandLedger;
  piVersion: string;
  helloTimeoutMs: number;
  /** The session store on disk, which is where the session list comes from. */
  index: SessionIndex;
  /** Project trust, applied whenever a session's process is (re)started. */
  trust: TrustStore;
  /** Tells every authenticated socket the session list changed. */
  announceSessions?: () => void;
}

/**
 * One client socket, multiplexing every session it subscribes to.
 *
 * A socket is anonymous until `hello` succeeds, and is closed if it does not
 * arrive in time. Nothing is sent to an unauthenticated socket beyond the
 * close frame, so an unauthorised client cannot even enumerate sessions.
 */
export class Connection {
  private readonly socket: WebSocket;
  private readonly deps: ConnectionDeps;
  private device: DeviceRecord | null = null;
  private readonly subscriptions = new Map<string, () => void>();
  /** Subscribed while cold: attached for real as soon as a process exists. */
  private readonly pendingSubscriptions = new Set<string>();
  private helloTimer: NodeJS.Timeout | null = null;
  private activity: { sessionIds: Set<string>; foreground: boolean; at: number } | null = null;

  constructor(socket: WebSocket, deps: ConnectionDeps) {
    this.socket = socket;
    this.deps = deps;

    this.helloTimer = setTimeout(() => {
      if (!this.device) this.close(4401, "unauthorized");
    }, deps.helloTimeoutMs);

    socket.on("message", (data) => void this.onMessage(data));
    socket.on("close", () => this.cleanup());
    socket.on("error", () => this.cleanup());
  }

  private async onMessage(data: unknown): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(String(data));
    } catch {
      return this.send({ v: WIRE_VERSION, type: "error", code: "bad_request", message: "invalid JSON" });
    }

    const parsed = ClientFrameSchema.safeParse(json);
    if (!parsed.success) {
      const version = (json as { v?: unknown })?.v;
      const message =
        version !== WIRE_VERSION
          ? `unsupported wire version ${String(version)}, expected ${WIRE_VERSION}`
          : parsed.error.issues.map((i) => i.message).join("; ");
      return this.send({ v: WIRE_VERSION, type: "error", code: "bad_request", message });
    }

    const frame = parsed.data;
    if (frame.type === "hello") return this.onHello(frame);
    if (!this.device) return this.close(4401, "unauthorized");

    try {
      await this.dispatch(frame);
    } catch (error) {
      console.error("[pios] frame failed", error);
      this.fail(frame.commandId, "internal", String(error));
    }
  }

  private onHello(frame: FrameOf<"hello">): void {
    const device = this.deps.auth.verify(frame.deviceToken);
    if (!device) return this.close(4401, "unauthorized");

    this.device = device;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;

    this.send({
      v: WIRE_VERSION,
      type: "welcome",
      commandId: frame.commandId,
      serverVersion: SERVER_VERSION,
      piVersion: this.deps.piVersion,
      // The list itself is a disk read, so it is asked for rather than paid
      // for on every handshake; this is only what is running right now.
      sessions: this.deps.registry.list().map((info) => liveSummary(info)),
    });
  }

  private async dispatch(frame: Exclude<ClientFrame, { type: "hello" }>): Promise<void> {
    switch (frame.type) {
      case "list_sessions":
        return this.listSessions(frame);
      case "set_session_trust":
        return this.setSessionTrust(frame);
      case "list_models":
        return this.listModels(frame);
      case "list_commands":
        return this.listCommands(frame);
      case "get_stats":
        return this.getStats(frame);
      case "set_model":
        return this.setModel(frame);
      case "set_thinking_level":
        return this.setThinkingLevel(frame);
      case "subscribe":
        return this.subscribe(frame);
      case "unsubscribe":
        this.unsubscribe(frame.sessionId);
        return this.ack(frame.commandId);
      case "get_entries":
        return this.getEntries(frame);
      case "prompt":
        return this.prompt(frame);
      case "interrupt":
        return this.interrupt(frame);
      case "run_bash":
        return this.runBash(frame);
      case "abort_bash":
        return this.abortBash(frame);
      case "rewind":
        return this.rewind(frame);
      case "extension_ui_response":
        return this.answerDialog(frame);
      case "activity":
        return this.recordActivity(frame);
    }
  }

  private async listSessions(frame: FrameOf<"list_sessions">): Promise<void> {
    const trust = (cwd: string) => this.deps.trust.isTrusted(cwd);
    const page = await listSessions(this.deps.index, this.deps.registry, trust, {
      cwd: frame.cwd,
      query: frame.query,
      limit: frame.limit,
      offset: frame.offset,
    });
    this.send({
      v: WIRE_VERSION,
      type: "sessions",
      commandId: frame.commandId,
      sessions: page.sessions,
      offset: page.offset,
      total: page.total,
      hasMore: page.hasMore,
    });
  }

  private async setSessionTrust(frame: FrameOf<"set_session_trust">): Promise<void> {
    const session = await this.requireLive(frame.sessionId, frame.commandId);
    if (!session) return;
    // Trust belongs to the directory: this session is what asked, but every
    // session in that project inherits the answer, now and on every wake.
    this.deps.trust.set(session.info.cwd, frame.trustProject);
    // Idempotent by nature: asking for the trust it already has is a no-op
    // in the registry, so a redelivered frame needs no ledger claim.
    await this.deps.registry.setProjectTrust(frame.sessionId, frame.trustProject);
    this.deps.announceSessions?.();
    this.sendSessionState(frame.commandId, session);
  }

  private async listModels(frame: FrameOf<"list_models">): Promise<void> {
    // `create` for a draft: the catalogue only exists behind an agent, and
    // the session is started under the id the draft composed against, so
    // the first prompt lands on it rather than on a second session.
    const session = await this.requireLive(frame.sessionId, frame.commandId, frame.create);
    if (!session) return;
    const listing = await session.listModels({ all: frame.all });
    this.send({
      v: WIRE_VERSION,
      type: "models",
      commandId: frame.commandId,
      sessionId: frame.sessionId,
      models: listing.models,
      all: listing.all,
    });
  }

  private async listCommands(frame: FrameOf<"list_commands">): Promise<void> {
    const session = await this.requireLive(frame.sessionId, frame.commandId);
    if (!session) return;
    this.send({
      v: WIRE_VERSION,
      type: "commands",
      commandId: frame.commandId,
      sessionId: frame.sessionId,
      commands: await session.listCommands(),
    });
  }

  private async getStats(frame: FrameOf<"get_stats">): Promise<void> {
    const session = await this.requireLive(frame.sessionId, frame.commandId);
    if (!session) return;
    this.send({
      v: WIRE_VERSION,
      type: "session_stats",
      commandId: frame.commandId,
      sessionId: frame.sessionId,
      stats: await session.getStats(),
    });
  }

  private async setModel(frame: FrameOf<"set_model">): Promise<void> {
    const session = await this.requireLive(frame.sessionId, frame.commandId);
    if (!session) return;
    // Idempotent: setting the model it already has changes nothing, so a
    // redelivered frame needs no ledger claim.
    await session.setModel(frame.provider, frame.modelId);
    this.sendSessionState(frame.commandId, session);
  }

  private async setThinkingLevel(frame: FrameOf<"set_thinking_level">): Promise<void> {
    const session = await this.requireLive(frame.sessionId, frame.commandId);
    if (!session) return;
    // Idempotent for the same reason as set_model: re-applying the level it
    // already has changes nothing.
    await session.setThinkingLevel(frame.level);
    this.sendSessionState(frame.commandId, session);
  }

  /**
   * Read from the file, so opening a conversation never starts a process. An
   * id with nothing behind it is a session that has not been written yet,
   * which is an empty transcript, not an error.
   */
  private async getEntries(frame: FrameOf<"get_entries">): Promise<void> {
    const page = await this.readEntries(frame.sessionId, frame);
    this.send({
      v: WIRE_VERSION,
      type: "entries",
      commandId: frame.commandId,
      sessionId: frame.sessionId,
      entries: page.entries,
      leafId: page.leafId,
      reset: page.reset,
      offset: page.offset,
      total: page.total,
    });
  }

  private async prompt(frame: FrameOf<"prompt">): Promise<void> {
    const session = await this.requireLive(frame.sessionId, frame.commandId, frame.create);
    if (!session) return;
    if (!this.deps.ledger.claim(frame.commandId)) return this.ack(frame.commandId, true);
    const result = await session.prompt(frame.text, {
      images: frame.images,
      streamingBehavior: frame.streamingBehavior,
    });
    if (!result.accepted) {
      return this.fail(frame.commandId, "agent_busy", result.error ?? "prompt rejected");
    }
    this.ack(frame.commandId);
  }

  private async interrupt(frame: FrameOf<"interrupt">): Promise<void> {
    const session = await this.requireLive(frame.sessionId, frame.commandId);
    if (!session) return;
    await session.interrupt();
    this.ack(frame.commandId);
  }

  private async runBash(frame: FrameOf<"run_bash">): Promise<void> {
    const session = await this.requireLive(frame.sessionId, frame.commandId);
    if (!session) return;
    // Running arbitrary shell twice is worse than not running it at all,
    // so a redelivered frame is acked rather than replayed.
    if (!this.deps.ledger.claim(frame.commandId)) return this.ack(frame.commandId, true);
    try {
      // The result reaches every subscriber as `bash_state`; this only
      // tells the caller the command was accepted.
      await session.runBash(frame.command, { excludeFromContext: frame.excludeFromContext });
    } catch (error) {
      return this.fail(frame.commandId, "agent_busy", errorMessage(error));
    }
    this.ack(frame.commandId);
  }

  private async abortBash(frame: FrameOf<"abort_bash">): Promise<void> {
    const session = await this.requireLive(frame.sessionId, frame.commandId);
    if (!session) return;
    await session.abortBash();
    this.ack(frame.commandId);
  }

  private async rewind(frame: FrameOf<"rewind">): Promise<void> {
    const session = await this.requireLive(frame.sessionId, frame.commandId);
    if (!session) return;
    // Not idempotent: a redelivered rewind would branch a second time and
    // throw away the turn the user just re-composed.
    if (!this.deps.ledger.claim(frame.commandId)) return this.ack(frame.commandId, true);
    let branch: Awaited<ReturnType<typeof session.branch>>;
    try {
      branch = await session.branch(frame.entryId);
    } catch (error) {
      return this.fail(frame.commandId, "bad_request", errorMessage(error));
    }
    // The branch is a session of its own: the conversation it was cut from
    // stays live and untouched, and both show up in the picker.
    const branched = await this.deps.registry.create({
      cwd: session.info.cwd,
      name: session.info.name,
      trustProject: session.info.trusted,
      resumeFrom: branch.sessionFile,
    });
    this.deps.announceSessions?.();
    this.send({
      v: WIRE_VERSION,
      type: "rewound",
      commandId: frame.commandId,
      sessionId: frame.sessionId,
      branchSessionId: branched.id,
      text: branch.text,
    });
  }

  private async answerDialog(frame: FrameOf<"extension_ui_response">): Promise<void> {
    const session = await this.requireLive(frame.sessionId, frame.commandId);
    if (!session) return;
    // A second device, or a retry after the deadline expired, arrives with
    // an id nobody is waiting on. Acked as a duplicate: the dialog is gone
    // either way, and failing it would only make clients retry.
    const delivered = session.answerDialog({
      type: "extension_ui_response",
      id: frame.requestId,
      value: frame.value,
      confirmed: frame.confirmed,
      cancelled: frame.cancelled,
    });
    this.ack(frame.commandId, !delivered);
  }

  private recordActivity(frame: FrameOf<"activity">): void {
    this.activity = {
      sessionIds: new Set(frame.sessionIds),
      foreground: frame.visible && frame.appState === "active",
      at: Date.now(),
    };
    this.ack(frame.commandId);
  }

  /**
   * Attaches to a session's live events.
   *
   * A cold session is subscribed to without waking it: there is nothing in
   * flight to miss, and seq only ever meant anything within one process, so
   * the client tails from zero once one exists.
   */
  private subscribe(frame: FrameOf<"subscribe">): void {
    const session = this.deps.registry.get(frame.sessionId);
    if (!session) {
      this.pendingSubscriptions.add(frame.sessionId);
      return this.send({
        v: WIRE_VERSION,
        type: "subscribed",
        commandId: frame.commandId,
        sessionId: frame.sessionId,
        seq: 0,
        gap: false,
      });
    }
    this.pendingSubscriptions.delete(frame.sessionId);
    this.unsubscribe(frame.sessionId);

    const { events, gap } = session.replay(frame.sinceSeq);
    for (const buffered of events) this.forward(session, buffered);

    // Live events start flowing only after the replay, so ordering by seq
    // holds across the handover.
    const off = session.subscribe((buffered) =>
      this.forward(session, buffered),
    );
    this.subscriptions.set(frame.sessionId, off);

    // Replay only covers what is still in the ring buffer, and a dialog can
    // outlive it. Clients key on request id, so a resend is harmless.
    for (const request of session.pendingDialogs) {
      this.send({ v: WIRE_VERSION, type: "extension_ui_request", sessionId: session.id, request });
    }
    this.send({
      v: WIRE_VERSION,
      type: "extension_ui_state",
      sessionId: session.id,
      presentation: session.presentation,
    });

    this.send({
      v: WIRE_VERSION,
      type: "subscribed",
      commandId: frame.commandId,
      sessionId: frame.sessionId,
      seq: events.at(-1)?.seq ?? frame.sinceSeq ?? 0,
      gap,
    });
  }

  private forward(session: PiSession, buffered: BufferedEvent): void {
    this.send(forwardFrame(session, buffered.seq, buffered.event, buffered.at));
  }

  private unsubscribe(sessionId: string): void {
    this.pendingSubscriptions.delete(sessionId);
    this.subscriptions.get(sessionId)?.();
    this.subscriptions.delete(sessionId);
  }

  /** Attaches any subscription that was made while the session was cold. */
  private attachPending(session: PiSession): void {
    if (!this.pendingSubscriptions.delete(session.id)) return;
    this.subscriptions.set(
      session.id,
      session.subscribe((buffered) => this.forward(session, buffered)),
    );
  }

  /**
   * The session's process, started if it does not have one.
   *
   * Everything but reading needs pi, and a session is only ever cold because
   * nobody has needed it lately, so waking it is the answer rather than an
   * error. `create` starts one that does not exist at all, under the id the
   * client composed against.
   */
  private async requireLive(
    sessionId: string,
    commandId: string,
    create?: { cwd: string; name?: string; trustProject?: boolean; model?: string },
  ): Promise<PiSession | undefined> {
    const live = this.deps.registry.get(sessionId);
    if (live) return live;

    const record = await this.deps.index.find(sessionId);
    const cwd = record?.cwd || create?.cwd;
    if (!cwd) {
      this.fail(commandId, "unknown_session", `no session ${sessionId}`);
      return undefined;
    }

    try {
      const session = await this.deps.registry.create({
        id: sessionId,
        cwd,
        name: record?.name ?? create?.name,
        // The directory's answer, not this request's: trust outlives the
        // session that first granted it.
        trustProject: this.deps.trust.isTrusted(cwd) || (create?.trustProject ?? false),
        model: create?.model,
        resumeFrom: record?.path,
      });
      if (create?.trustProject) this.deps.trust.set(cwd, true);
      this.attachPending(session);
      this.deps.announceSessions?.();
      return session;
    } catch (error) {
      this.fail(commandId, "internal", errorMessage(error));
      return undefined;
    }
  }

  /**
   * A page of transcript, read from the session file.
   *
   * pi persists an entry before it announces it, so the file is the durable
   * truth whether or not a process exists. A session with no file yet is the
   * one case the live agent has to answer for.
   */
  private async readEntries(
    sessionId: string,
    query: { since?: string; limit?: number; before?: number },
  ): Promise<EntriesWindow> {
    const live = this.deps.registry.get(sessionId);
    const file = live?.info.sessionFile ?? (await this.deps.index.find(sessionId))?.path;
    const transcript = file ? readTranscript(file) : null;
    if (transcript) {
      return sliceEntries(transcript.entries, transcript.leafId, {
        ...query,
        maxBytes: ENTRIES_FRAME_BYTES,
      });
    }

    // No file yet: either the agent has written nothing, or it is not pi's
    // format at all, which is what a stubbed host in the sandbox looks like.
    if (!live) return { entries: [], leafId: null, reset: false, offset: 0, total: 0 };
    const page = await live.getEntries(query.since);
    return { ...page, offset: 0, total: page.entries.length };
  }

  /** Device on this socket, once it has authenticated. */
  get deviceId(): string | null {
    return this.device?.id ?? null;
  }

  /**
   * Whether this client is looking at a session right now.
   *
   * A subscription alone is not attention: a backgrounded PWA keeps its
   * socket for a while. Reports are periodic, so a stale one is ignored and
   * the device gets pushed to instead of silently missing the turn.
   */
  watching(sessionId: string, ttlMs: number, now = Date.now()): boolean {
    const activity = this.activity;
    if (!activity || !activity.foreground) return false;
    if (now - activity.at > ttlMs) return false;
    return activity.sessionIds.has(sessionId);
  }

  /**
   * Nudges the client that the session store changed.
   *
   * A nudge, not a payload: the client is the only one that knows which page,
   * filter, and search it is looking at. Ignored before `hello`.
   */
  sendSessions(): void {
    if (!this.device) return;
    this.send({ v: WIRE_VERSION, type: "sessions_changed" });
  }

  private sendSessionState(commandId: string, session: PiSession): void {
    this.send({
      v: WIRE_VERSION,
      type: "session_state",
      commandId,
      sessionId: session.id,
      summary:
        summaryFor(
          this.deps.index,
          this.deps.registry,
          (cwd) => this.deps.trust.isTrusted(cwd),
          session.id,
        ) ?? liveSummary(session.info),
    });
  }

  private ack(commandId: string, duplicate = false): void {
    this.send({ v: WIRE_VERSION, type: "ack", commandId, duplicate });
  }

  private fail(
    commandId: string,
    code: Extract<ServerFrame, { type: "error" }>["code"],
    message: string,
  ): void {
    this.send({ v: WIRE_VERSION, type: "error", commandId, code, message });
  }

  private send(frame: ServerFrame): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }

  private close(code: number, reason: string): void {
    this.cleanup();
    this.socket.close(code, reason);
  }

  private cleanup(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    for (const off of this.subscriptions.values()) off();
    this.subscriptions.clear();
  }
}

function forwardFrame(
  session: PiSession,
  seq: number,
  event: HostEvent,
  at: number,
): ServerFrame {
  const sessionId = session.id;
  switch (event.type) {
    case "agent_event":
      return { v: WIRE_VERSION, type: "agent_event", sessionId, seq, at, event: event.event };
    case "bash_state":
      return {
        v: WIRE_VERSION,
        type: "bash_state",
        sessionId,
        command: event.command,
        excludeFromContext: event.excludeFromContext,
        running: event.running,
        result: event.result,
      };
    case "extension_ui_request":
      return { v: WIRE_VERSION, type: "extension_ui_request", sessionId, request: event.request };
    case "extension_ui_closed":
      return { v: WIRE_VERSION, type: "extension_ui_closed", sessionId, requestId: event.id };
    case "session_recovered":
      return {
        v: WIRE_VERSION,
        type: "session_recovered",
        sessionId,
        leafId: event.leafId,
        reason: event.reason,
      };
    case "status":
      // Sent as a whole summary rather than a bare status so the client never
      // has to merge two sources to know what a session is doing.
      return {
        v: WIRE_VERSION,
        type: "session_state",
        sessionId,
        summary: liveSummary(session.info),
      };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

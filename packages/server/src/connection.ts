import type { WebSocket } from "ws";
import type {
  BufferedEvent,
  HostEvent,
  PiSession,
  SessionInfo,
  SessionLister,
  SessionRegistry,
} from "@pios/pi-host";
import {
  ClientFrameSchema,
  WIRE_VERSION,
  type ClientFrame,
  type ServerFrame,
  type SessionSummary,
} from "@pios/protocol";
import type { AuthStore, DeviceRecord } from "./auth.ts";
import type { CommandLedger } from "./dedupe.ts";
import { SERVER_VERSION } from "./config.ts";

export interface ConnectionDeps {
  auth: AuthStore;
  registry: SessionRegistry;
  ledger: CommandLedger;
  piVersion: string;
  helloTimeoutMs: number;
  /** Reads pi's session directory, so TUI sessions are resumable from here. */
  lister?: SessionLister;
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

  private onHello(frame: Extract<ClientFrame, { type: "hello" }>): void {
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
      sessions: this.deps.registry.list().map(toSummary),
    });
  }

  private async dispatch(frame: Exclude<ClientFrame, { type: "hello" }>): Promise<void> {
    switch (frame.type) {
      case "list_sessions":
        return this.send({
          v: WIRE_VERSION,
          type: "sessions",
          commandId: frame.commandId,
          sessions: this.deps.registry.list().map(toSummary),
        });

      case "create_session": {
        // Creating a session starts a process; a redelivered create must not
        // start a second one.
        if (!this.deps.ledger.claim(frame.commandId)) {
          return this.ack(frame.commandId, true);
        }
        // Resuming a session that is already live must attach, not open the
        // same JSONL twice: two writers on one file interleave entries.
        const existing = frame.resumeFrom ? this.liveByFile(frame.resumeFrom) : undefined;
        const session =
          existing ??
          (await this.deps.registry.create({
            cwd: frame.cwd,
            name: frame.name,
            trustProject: frame.trustProject,
            model: frame.model,
            resumeFrom: frame.resumeFrom,
          }));
        // Sessions are shared, so a second device must not have to guess that
        // one appeared.
        this.deps.announceSessions?.();
        return this.sendSessionState(frame.commandId, session);
      }

      case "list_resumable": {
        const lister = this.deps.lister;
        if (!lister) return this.fail(frame.commandId, "internal", "session listing disabled");
        const found = await lister({ cwd: frame.cwd, limit: frame.limit });
        const live = new Set(
          this.deps.registry
            .list()
            .map((info) => info.sessionFile)
            .filter((path): path is string => Boolean(path)),
        );
        return this.send({
          v: WIRE_VERSION,
          type: "resumable_sessions",
          commandId: frame.commandId,
          sessions: found.map((session) => ({
            path: session.path,
            sessionId: session.id,
            cwd: session.cwd,
            name: session.name,
            createdAt: session.createdAt,
            modifiedAt: session.modifiedAt,
            messageCount: session.messageCount,
            preview: session.preview,
            live: live.has(session.path),
          })),
        });
      }

      case "dispose_session": {
        this.unsubscribe(frame.sessionId);
        await this.deps.registry.dispose(frame.sessionId);
        this.deps.announceSessions?.();
        return this.ack(frame.commandId);
      }

      case "set_session_trust": {
        const session = this.require(frame.sessionId, frame.commandId);
        if (!session) return;
        // Idempotent by nature: asking for the trust it already has is a no-op
        // in the registry, so a redelivered frame needs no ledger claim.
        await this.deps.registry.setProjectTrust(frame.sessionId, frame.trustProject);
        this.deps.announceSessions?.();
        return this.sendSessionState(frame.commandId, session);
      }

      case "list_models": {
        const session = this.require(frame.sessionId, frame.commandId);
        if (!session) return;
        const listing = await session.listModels({ all: frame.all });
        return this.send({
          v: WIRE_VERSION,
          type: "models",
          commandId: frame.commandId,
          sessionId: frame.sessionId,
          models: listing.models,
          all: listing.all,
        });
      }

      case "list_commands": {
        const session = this.require(frame.sessionId, frame.commandId);
        if (!session) return;
        return this.send({
          v: WIRE_VERSION,
          type: "commands",
          commandId: frame.commandId,
          sessionId: frame.sessionId,
          commands: await session.listCommands(),
        });
      }

      case "get_stats": {
        const session = this.require(frame.sessionId, frame.commandId);
        if (!session) return;
        return this.send({
          v: WIRE_VERSION,
          type: "session_stats",
          commandId: frame.commandId,
          sessionId: frame.sessionId,
          stats: await session.getStats(),
        });
      }

      case "set_model": {
        const session = this.require(frame.sessionId, frame.commandId);
        if (!session) return;
        // Idempotent: setting the model it already has changes nothing, so a
        // redelivered frame needs no ledger claim.
        await session.setModel(frame.provider, frame.modelId);
        return this.sendSessionState(frame.commandId, session);
      }

      case "set_thinking_level": {
        const session = this.require(frame.sessionId, frame.commandId);
        if (!session) return;
        // Idempotent for the same reason as set_model: re-applying the level it
        // already has changes nothing.
        await session.setThinkingLevel(frame.level);
        return this.sendSessionState(frame.commandId, session);
      }

      case "subscribe":
        return this.subscribe(frame);

      case "unsubscribe":
        this.unsubscribe(frame.sessionId);
        return this.ack(frame.commandId);

      case "get_entries": {
        const session = this.require(frame.sessionId, frame.commandId);
        if (!session) return;
        const page = await session.getEntries(frame.since);
        return this.send({
          v: WIRE_VERSION,
          type: "entries",
          commandId: frame.commandId,
          sessionId: frame.sessionId,
          entries: page.entries,
          leafId: page.leafId,
          reset: page.reset,
        });
      }

      case "prompt": {
        const session = this.require(frame.sessionId, frame.commandId);
        if (!session) return;
        if (!this.deps.ledger.claim(frame.commandId)) {
          return this.ack(frame.commandId, true);
        }
        const result = await session.prompt(frame.text, {
          images: frame.images,
          streamingBehavior: frame.streamingBehavior,
        });
        if (!result.accepted) {
          return this.fail(frame.commandId, "agent_busy", result.error ?? "prompt rejected");
        }
        return this.ack(frame.commandId);
      }

      case "interrupt": {
        const session = this.require(frame.sessionId, frame.commandId);
        if (!session) return;
        await session.interrupt();
        return this.ack(frame.commandId);
      }

      case "run_bash": {
        const session = this.require(frame.sessionId, frame.commandId);
        if (!session) return;
        // Running arbitrary shell twice is worse than not running it at all,
        // so a redelivered frame is acked rather than replayed.
        if (!this.deps.ledger.claim(frame.commandId)) {
          return this.ack(frame.commandId, true);
        }
        try {
          // The result reaches every subscriber as `bash_state`; this only
          // tells the caller the command was accepted.
          await session.runBash(frame.command, {
            excludeFromContext: frame.excludeFromContext,
          });
        } catch (error) {
          return this.fail(
            frame.commandId,
            "agent_busy",
            error instanceof Error ? error.message : String(error),
          );
        }
        return this.ack(frame.commandId);
      }

      case "abort_bash": {
        const session = this.require(frame.sessionId, frame.commandId);
        if (!session) return;
        await session.abortBash();
        return this.ack(frame.commandId);
      }

      case "rewind": {
        const session = this.require(frame.sessionId, frame.commandId);
        if (!session) return;
        // Not idempotent: a redelivered rewind would branch a second time and
        // throw away the turn the user just re-composed.
        if (!this.deps.ledger.claim(frame.commandId)) {
          return this.ack(frame.commandId, true);
        }
        let branch: Awaited<ReturnType<typeof session.branch>>;
        try {
          branch = await session.branch(frame.entryId);
        } catch (error) {
          return this.fail(
            frame.commandId,
            "bad_request",
            error instanceof Error ? error.message : String(error),
          );
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
        return this.send({
          v: WIRE_VERSION,
          type: "rewound",
          commandId: frame.commandId,
          sessionId: frame.sessionId,
          branchSessionId: branched.id,
          text: branch.text,
        });
      }

      case "extension_ui_response": {
        const session = this.require(frame.sessionId, frame.commandId);
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
        return this.ack(frame.commandId, !delivered);
      }

      case "activity":
        this.activity = {
          sessionIds: new Set(frame.sessionIds),
          foreground: frame.visible && frame.appState === "active",
          at: Date.now(),
        };
        return this.ack(frame.commandId);
    }
  }

  private subscribe(frame: Extract<ClientFrame, { type: "subscribe" }>): void {
    const session = this.require(frame.sessionId, frame.commandId);
    if (!session) return;
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
    this.subscriptions.get(sessionId)?.();
    this.subscriptions.delete(sessionId);
  }

  private require(sessionId: string, commandId: string): PiSession | undefined {
    const session = this.deps.registry.get(sessionId);
    if (!session) {
      this.fail(commandId, "unknown_session", `no session ${sessionId}`);
      return undefined;
    }
    return session;
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

  /** Pushes the current session list, unprompted. Ignored before `hello`. */
  sendSessions(): void {
    if (!this.device) return;
    this.send({
      v: WIRE_VERSION,
      type: "sessions",
      sessions: this.deps.registry.list().map(toSummary),
    });
  }

  private liveByFile(path: string): PiSession | undefined {
    for (const info of this.deps.registry.list()) {
      if (info.sessionFile === path) return this.deps.registry.get(info.id);
    }
    return undefined;
  }

  private sendSessionState(commandId: string, session: PiSession): void {
    this.send({
      v: WIRE_VERSION,
      type: "session_state",
      commandId,
      sessionId: session.id,
      summary: toSummary(session.info),
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
        summary: toSummary(session.info),
      };
  }
}

function toSummary(info: SessionInfo): SessionSummary {
  return {
    sessionId: info.id,
    name: info.name,
    cwd: info.cwd,
    status: info.status === "starting" ? "idle" : info.status,
    awaitingInput: info.awaitingInput,
    trusted: info.trusted,
    leafId: info.leafId,
    lastSeq: info.lastSeq,
    updatedAt: info.updatedAt,
    preview: info.preview,
    model: info.model,
    thinkingLevel: info.thinkingLevel,
    thinkingLevels: info.thinkingLevels,
  };
}

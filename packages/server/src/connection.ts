import type { WebSocket } from "ws";
import type {
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
        return this.send({
          v: WIRE_VERSION,
          type: "session_state",
          commandId: frame.commandId,
          sessionId: session.id,
          summary: toSummary(session.info),
        });
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
        return this.send({
          v: WIRE_VERSION,
          type: "session_state",
          commandId: frame.commandId,
          sessionId: frame.sessionId,
          summary: toSummary(session.info),
        });
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

      case "extension_ui_response":
        // Dialogs are Phase 8. Answering nothing would hang the agent until
        // its timeout, so the rejection is explicit.
        return this.fail(frame.commandId, "bad_request", "extension UI is not implemented");

      case "activity":
        // Recorded as a lease later; acked now so clients can send it safely.
        return this.ack(frame.commandId);
    }
  }

  private subscribe(frame: Extract<ClientFrame, { type: "subscribe" }>): void {
    const session = this.require(frame.sessionId, frame.commandId);
    if (!session) return;
    this.unsubscribe(frame.sessionId);

    const { events, gap } = session.replay(frame.sinceSeq);
    for (const buffered of events) this.forward(session, buffered.seq, buffered.event);

    // Live events start flowing only after the replay, so ordering by seq
    // holds across the handover.
    const off = session.subscribe((buffered) =>
      this.forward(session, buffered.seq, buffered.event),
    );
    this.subscriptions.set(frame.sessionId, off);

    this.send({
      v: WIRE_VERSION,
      type: "subscribed",
      commandId: frame.commandId,
      sessionId: frame.sessionId,
      seq: events.at(-1)?.seq ?? frame.sinceSeq ?? 0,
      gap,
    });
  }

  private forward(session: PiSession, seq: number, event: HostEvent): void {
    this.send(forwardFrame(session, seq, event));
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

function forwardFrame(session: PiSession, seq: number, event: HostEvent): ServerFrame {
  const sessionId = session.id;
  switch (event.type) {
    case "agent_event":
      return { v: WIRE_VERSION, type: "agent_event", sessionId, seq, event: event.event };
    case "extension_ui_request":
      return { v: WIRE_VERSION, type: "extension_ui_request", sessionId, request: event.request };
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
    trusted: info.trusted,
    leafId: info.leafId,
    lastSeq: info.lastSeq,
    updatedAt: info.updatedAt,
  };
}

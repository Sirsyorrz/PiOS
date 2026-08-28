import type { BufferedEvent, PiSession } from "@pios/pi-host";
import type { PushMessage } from "./push.ts";

/**
 * Turns `agent_settled` into one push per session.
 *
 * `agent_settled`, not `agent_end`: a turn can be followed by a retry, a
 * compaction, or a queued continuation, and a phone that buzzed three times
 * for one prompt is worse than one that buzzed late.
 *
 * A settle with no turn behind it is silent. Restarts, trust changes, and
 * resubscribes can all end in a settle without the agent ever having run, and
 * a notification for those is pure noise.
 */

export interface Notification {
  sessionId: string;
  message: PushMessage;
  /** Devices watching this session right now, which do not need waking. */
  skipDeviceIds: Set<string>;
}

export interface NotifierDeps {
  send(notification: Notification): void | Promise<void>;
  /** Devices with a foreground client subscribed to the session. */
  watchers(sessionId: string): Set<string>;
  now?: () => number;
}

interface TurnState {
  startedAt: number | null;
  lastTool: string | null;
  errored: boolean;
}

export class SettleNotifier {
  private readonly deps: NotifierDeps;
  private readonly now: () => number;
  private readonly turns = new Map<string, TurnState>();
  private readonly detach = new Map<string, () => void>();

  constructor(deps: NotifierDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  attach(session: PiSession): void {
    this.detach.get(session.id)?.();
    // Only live events matter: replaying the ring buffer would notify for
    // turns that settled before this daemon ever saw them.
    this.detach.set(
      session.id,
      session.subscribe((buffered) => this.onEvent(session, buffered)),
    );
  }

  release(sessionId: string): void {
    this.detach.get(sessionId)?.();
    this.detach.delete(sessionId);
    this.turns.delete(sessionId);
  }

  releaseAll(): void {
    for (const id of [...this.detach.keys()]) this.release(id);
  }

  private onEvent(session: PiSession, buffered: BufferedEvent): void {
    if (buffered.event.type !== "agent_event") return;
    const event = buffered.event.event;
    const turn = this.turns.get(session.id) ?? { startedAt: null, lastTool: null, errored: false };
    this.turns.set(session.id, turn);

    switch (event.type) {
      case "agent_start":
        turn.startedAt ??= this.now();
        turn.lastTool = null;
        turn.errored = false;
        return;
      case "tool_execution_start":
      case "tool_execution_end":
        turn.lastTool = event.toolName;
        return;
      case "agent_end":
        if (event.reason && event.reason !== "done") turn.errored = true;
        return;
      case "agent_settled": {
        this.turns.delete(session.id);
        if (turn.startedAt === null) return;
        void this.deps.send({
          sessionId: session.id,
          message: compose(session, turn, this.now()),
          skipDeviceIds: this.deps.watchers(session.id),
        });
        return;
      }
      default:
        return;
    }
  }
}

function compose(session: PiSession, turn: TurnState, now: number): PushMessage {
  const info = session.info;
  const name = info.name?.trim() || basename(info.cwd);
  const elapsed = turn.startedAt === null ? null : formatElapsed(now - turn.startedAt);

  const parts = [
    info.awaitingInput ? "needs input" : turn.errored ? "stopped" : "done",
    turn.lastTool ? `last: ${turn.lastTool}` : null,
    elapsed,
  ].filter((part): part is string => Boolean(part));

  return {
    title: name,
    body: parts.join(" - "),
    url: `/?session=${encodeURIComponent(session.id)}`,
    // One live notification per session: a second settle replaces the first.
    tag: `session:${session.id}`,
  };
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

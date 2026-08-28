import type { BufferedEvent, PiSession } from "@pios/pi-host";
import { messageText } from "@pios/protocol";
import type { PushMessage } from "./push.ts";

/** Kept short: a lock screen shows two lines and iOS truncates the rest. */
const BODY_LIMIT = 180;

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
  /** What the agent actually said last, which is the point of the alert. */
  lastText: string | null;
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
    const turn = this.turns.get(session.id) ?? { startedAt: null, lastText: null, errored: false };
    this.turns.set(session.id, turn);

    switch (event.type) {
      case "agent_start":
        turn.startedAt ??= this.now();
        turn.lastText = null;
        turn.errored = false;
        return;
      case "message_end": {
        // Only the assistant's prose: a tool call or a thinking block is not
        // what the agent came back to say.
        if (event.message.role !== "assistant") return;
        const text = messageText(event.message).trim();
        if (text) turn.lastText = text;
        return;
      }
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
  const elapsed = turn.startedAt === null ? null : formatElapsed(now - turn.startedAt);

  return {
    // The same label the session list shows, so the notification and the row
    // it opens name the same thing.
    title: info.name?.trim() || info.preview?.trim() || shortenPath(info.cwd),
    body: turn.lastText
      ? summarise(turn.lastText)
      : [info.awaitingInput ? "Needs input" : turn.errored ? "Stopped" : "Finished", elapsed]
          .filter((part): part is string => Boolean(part))
          .join(" - "),
    url: `/?session=${encodeURIComponent(session.id)}`,
    // One live notification per session: a second settle replaces the first.
    tag: `session:${session.id}`,
  };
}

/**
 * Opening of the agent's closing message.
 *
 * Markdown reads badly in a notification, so the heaviest markers are
 * stripped and the text is flattened to one paragraph.
 */
function summarise(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= BODY_LIMIT) return flat || "Finished";
  // Cut on a word so the ellipsis does not land mid-identifier.
  const clipped = flat.slice(0, BODY_LIMIT);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > 80 ? lastSpace : BODY_LIMIT).trimEnd()}...`;
}

/** Mirrors the session list: the last two path segments are enough to place it. */
function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `.../${parts.slice(-2).join("/")}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

import { AgentMessageSchema, messageText, turnFailure, type AgentMessage } from "@pios/protocol";
import { entryTimestamp, scanTail, type SessionIndex } from "@pios/pi-host";
import { pushFor, type Notification } from "./notifier.ts";

/**
 * Notifications for turns that ran somewhere else, i.e. in the TUI.
 *
 * Those never pass through this daemon's event stream, so `agent_settled`
 * cannot be seen; the session file is all there is. A turn counts as settled
 * once the file has gone quiet with an assistant answer as its last message.
 * Quiet, because pi writes that answer before deciding on a retry, a
 * compaction, or a queued follow-up, and one buzz late beats three on time.
 */

export interface ExternalTurnDeps {
  index: SessionIndex;
  /** A session this daemon runs reports its own settles; those are skipped. */
  isLive(sessionId: string): boolean;
  watchers(sessionId: string): Set<string>;
  send(notification: Notification): void | Promise<void>;
  now?: () => number;
  quietMs?: number;
  /** A failed request is retried by pi after a delay, so it waits longer. */
  failureQuietMs?: number;
}

const QUIET_MS = 4_000;
const FAILURE_QUIET_MS = 30_000;

export class ExternalTurnNotifier {
  private readonly deps: ExternalTurnDeps;
  private readonly now: () => number;
  /** Turns from before the daemon started were somebody else's problem. */
  private readonly since: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Last entry announced per file, so a rewrite of the same turn is silent. */
  private readonly announced = new Map<string, string>();

  constructor(deps: ExternalTurnDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.since = this.now();
  }

  /** Files the store watcher saw written. Each is looked at once it is quiet. */
  changed(files: string[]): void {
    for (const file of files) this.schedule(file, this.deps.quietMs ?? QUIET_MS);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(file: string, delay: number): void {
    clearTimeout(this.timers.get(file));
    const timer = setTimeout(() => {
      this.timers.delete(file);
      void this.check(file).catch((error: unknown) =>
        console.error(`[pios] could not read ${file} for a notification`, error),
      );
    }, delay);
    timer.unref?.();
    this.timers.set(file, timer);
  }

  private async check(file: string): Promise<void> {
    const record = await this.deps.index.recordAt(file);
    if (!record || this.deps.isLive(record.id)) return;

    const last = await lastMessage(file);
    if (!last || this.announced.get(file) === last.id) return;
    if (last.at === undefined || last.at < this.since) return;
    const message = last.message;
    if (message.role !== "assistant") return;
    // Still working, or stopped by the person at the keyboard.
    if (message.stopReason === "toolUse" || message.stopReason === "aborted") return;

    const failure = turnFailure(message);
    const failureQuiet = this.deps.failureQuietMs ?? FAILURE_QUIET_MS;
    const quietFor = this.now() - record.mtimeMs;
    if (failure && quietFor < failureQuiet) return this.schedule(file, failureQuiet - quietFor);

    this.announced.set(file, last.id);
    await this.deps.send({
      sessionId: record.id,
      message: pushFor(record, {
        text: messageText(message).trim(),
        failure,
        fallback: "Finished",
      }),
      skipDeviceIds: this.deps.watchers(record.id),
    });
  }
}

interface FileMessage {
  id: string;
  at?: number;
  message: AgentMessage;
}

async function lastMessage(file: string): Promise<FileMessage | null> {
  let found: FileMessage | null = null;
  await scanTail(
    file,
    (entry) => {
      if (entry.type !== "message") return false;
      const message = AgentMessageSchema.safeParse(entry.message);
      if (message.success && typeof entry.id === "string") {
        found = { id: entry.id, at: entryTimestamp(entry), message: message.data };
      }
      return true;
    },
    // The last message is the newest entry but one or two; a huge tool result
    // is the only thing that pushes it further back.
    4 * 1024 * 1024,
  );
  return found;
}

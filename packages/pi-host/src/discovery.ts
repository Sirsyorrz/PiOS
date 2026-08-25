import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * A session file on disk that no PiOS session currently owns.
 *
 * Everything here is read from pi's own session JSONL, so a session started in
 * the TUI looks the same as one started by the daemon.
 */
export interface ResumableSession {
  /** Path to the session JSONL. This is what `resumeFrom` takes. */
  path: string;
  id: string;
  cwd: string;
  name?: string;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
  /** First user message, for a list row that is readable without opening it. */
  preview: string;
}

export interface ListResumableOptions {
  /** Restrict to one project directory. Omitted means every project. */
  cwd?: string;
  sessionDir?: string;
  /** Newest first, capped so a phone does not receive years of history. */
  limit?: number;
}

export type SessionLister = (options: ListResumableOptions) => Promise<ResumableSession[]>;

const DEFAULT_LIMIT = 50;

export function createSessionLister(defaults: ListResumableOptions = {}): SessionLister {
  return async (options) => {
    const sessionDir = options.sessionDir ?? defaults.sessionDir;
    const limit = options.limit ?? defaults.limit ?? DEFAULT_LIMIT;
    const cwd = options.cwd ?? defaults.cwd;

    const found = cwd
      ? await SessionManager.list(cwd, sessionDir)
      : await SessionManager.listAll(sessionDir);

    return found
      .map(toResumable)
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, limit);
  };
}

function toResumable(info: {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}): ResumableSession {
  return {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    name: info.name,
    createdAt: info.created.getTime(),
    modifiedAt: info.modified.getTime(),
    messageCount: info.messageCount,
    preview: info.firstMessage.slice(0, 200),
  };
}

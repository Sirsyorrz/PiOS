import { SessionIndex, type SessionRecord } from "./session-index.ts";

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
  /** Absent for a session too large to count without reading all of it. */
  messageCount?: number;
  /** First user message, for a list row that is readable without opening it. */
  preview: string;
}

export interface ListResumableOptions {
  /** Restrict to one project directory. Omitted means every project. */
  cwd?: string;
  /** Newest first, capped so a phone does not receive years of history. */
  limit?: number;
}

export type SessionLister = (options: ListResumableOptions) => Promise<ResumableSession[]>;

export interface SessionListerOptions extends ListResumableOptions {
  sessionDir: string;
  /** Warm-start seed for the index behind this lister. */
  cacheFile?: string;
}

/**
 * Listing backed by one long-lived index, so repeat calls skim only the files
 * that changed. Creating a lister per request would throw that cache away.
 */
export function createSessionLister(defaults: SessionListerOptions): SessionLister {
  const index = new SessionIndex({
    sessionDir: defaults.sessionDir,
    cacheFile: defaults.cacheFile,
    limit: defaults.limit,
  });
  // Nothing waits on this: the first list is correct either way, just slower.
  void index.warm();
  return async (options) => {
    const page = await index.list({ cwd: options.cwd ?? defaults.cwd, limit: options.limit });
    return page.sessions.map(toResumable);
  };
}

function toResumable(record: SessionRecord): ResumableSession {
  return {
    path: record.path,
    id: record.id,
    cwd: record.cwd,
    name: record.name,
    createdAt: record.createdAt,
    modifiedAt: record.modifiedAt,
    messageCount: record.messageCount,
    preview: record.preview,
  };
}

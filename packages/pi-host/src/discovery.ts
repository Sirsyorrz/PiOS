import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { previewText } from "@pios/protocol";
import { projectSessionDir } from "./session-paths.ts";

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

    const found = cwd ? await listForCwd(cwd, sessionDir) : await listEverything(sessionDir);

    return found
      .map(toResumable)
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, limit);
  };
}

/**
 * pi's `sessionDir` is one project's directory, not the root above them.
 *
 * The root holds one encoded directory per project, so a plain `listAll(root)`
 * finds nothing: every file is one level further down.
 */
async function listEverything(root?: string): Promise<PiSessionInfo[]> {
  if (!root) return SessionManager.listAll();
  const leaves = await leafDirs(root);
  // The root itself is included for a flat directory, e.g. a test fixture.
  const batches = await Promise.all([root, ...leaves].map((dir) => SessionManager.listAll(dir)));
  return batches.flat();
}

async function listForCwd(cwd: string, root?: string): Promise<PiSessionInfo[]> {
  if (!root) return SessionManager.list(cwd);
  const leaf = projectSessionDir(cwd, root);
  if (existsSync(leaf)) return SessionManager.list(cwd, leaf);
  // A session file can name a cwd that does not match the directory it sits
  // in, e.g. after a fork, so falling back to a filtered scan is not dead code.
  const all = await listEverything(root);
  const resolved = resolve(cwd);
  return all.filter((session) => resolve(session.cwd || "/") === resolved);
}

async function leafDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

interface PiSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
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
    preview: previewText(info.firstMessage).slice(0, 200),
  };
}

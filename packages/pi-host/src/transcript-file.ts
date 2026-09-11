import { statSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@pios/protocol";
import type { EntriesPage } from "./types.ts";

/**
 * Reads a session transcript from its file.
 *
 * pi persists every entry before it announces it, so the file is the durable
 * truth and a running process only ever adds partials on top of it. Reading
 * from disk therefore works the same whether or not a process exists, which is
 * what lets a session be opened without starting one.
 *
 * Parsing is the SDK's job: it owns pi's on-disk format and tracks its changes.
 * What is ours is deciding which file to hand it and caching the result, keyed
 * on mtime and size so a stale transcript cannot be served.
 */

export interface FileTranscript {
  entries: SessionEntry[];
  leafId: string | null;
  cwd: string;
}

/** Enough sessions for a phone flicking between conversations, not a history. */
const MAX_CACHED = 8;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  transcript: FileTranscript;
}

const cache = new Map<string, CacheEntry>();

export function readTranscript(sessionFile: string): FileTranscript | null {
  let info: { mtimeMs: number; size: number };
  try {
    info = statSync(sessionFile);
  } catch {
    return null;
  }

  const hit = cache.get(sessionFile);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.transcript;

  let transcript: FileTranscript;
  try {
    const manager = SessionManager.open(sessionFile);
    transcript = {
      entries: manager.getEntries() as SessionEntry[],
      leafId: manager.getLeafId(),
      cwd: manager.getCwd(),
    };
  } catch {
    return null;
  }

  cache.set(sessionFile, { mtimeMs: info.mtimeMs, size: info.size, transcript });
  // Insertion order eviction: the oldest read is the least likely to be next.
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return transcript;
}

/** Drops a cached transcript, or all of them. */
export function forgetTranscript(sessionFile?: string): void {
  if (sessionFile) cache.delete(sessionFile);
  else cache.clear();
}

export interface EntriesQuery {
  /** Delta since a durable entry id. Takes precedence over the tail window. */
  since?: string;
  /** Newest N entries. Omitted or 0 means the whole transcript. */
  limit?: number;
  /** Index to page backwards from, as returned in `offset`. */
  before?: number;
}

export interface EntriesWindow extends EntriesPage {
  /** Index of the first returned entry, for the next `before`. */
  offset: number;
  total: number;
}

/**
 * Slices a transcript for one request.
 *
 * A chat is read from the bottom, so the tail is the part that has to be cheap;
 * `since` answers "what changed" and `before` answers "what came earlier", and
 * they are separate questions rather than one cursor doing both jobs.
 */
export function sliceEntries(
  entries: SessionEntry[],
  leafId: string | null,
  query: EntriesQuery = {},
): EntriesWindow {
  const total = entries.length;

  if (query.since !== undefined) {
    const index = entries.findIndex((entry) => entry.id === query.since);
    // An unknown cursor makes the client's cache worthless, so it gets the
    // whole session and is told to start over rather than an error.
    if (index === -1) return { entries, leafId, reset: true, offset: 0, total };
    return { entries: entries.slice(index + 1), leafId, reset: false, offset: index + 1, total };
  }

  const end = query.before === undefined ? total : Math.max(0, Math.min(query.before, total));
  const limit = query.limit ?? 0;
  const start = limit > 0 ? Math.max(0, end - limit) : 0;
  return { entries: entries.slice(start, end), leafId, reset: false, offset: start, total };
}

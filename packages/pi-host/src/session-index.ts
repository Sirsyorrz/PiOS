import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { previewText } from "@pios/protocol";
import { entryTimestamp, scanTail } from "./session-tail.ts";

/**
 * Index over pi's session files.
 *
 * The session store on disk is the list: a session started in the TUI and one
 * started here are the same kind of thing, and neither needs a running process
 * to be listed. Reading every file to build that list is what made listing take
 * seconds, so the scan is split in two: a stat-only pass that decides order and
 * paging, and a bounded skim that only touches the files on the page asked for.
 *
 * Records are cached in memory keyed on mtime+size, so a stale one cannot be
 * served, and mirrored to a seed file so the first list after a daemon restart
 * is warm. The seed is never an authority: every record it holds is revalidated
 * against the file before use.
 */

export interface SessionRecord {
  /** Path to the session JSONL. This is what `resumeFrom` takes. */
  path: string;
  id: string;
  cwd: string;
  name?: string;
  createdAt: number;
  modifiedAt: number;
  /** First user message, for a list row readable without opening it. */
  preview: string;
  /** Absent for a session too large to count without reading all of it. */
  messageCount?: number;
  /**
   * Last thing the user did: a prompt or a shell command, from this device or
   * the TUI. The list is ordered on it rather than on the file's mtime, which
   * a long unattended run keeps bumping past the conversation just left.
   */
  activeAt: number;
  mtimeMs: number;
  size: number;
}

export interface ListOptions {
  /** Restrict to one project directory. Omitted means every project. */
  cwd?: string;
  /** Matched against path, name and preview. Never against full transcripts. */
  query?: string;
  limit?: number;
  offset?: number;
}

export interface ListPage {
  sessions: SessionRecord[];
  offset: number;
  total: number;
  hasMore: boolean;
}

export interface SessionIndexOptions {
  /** Root holding one directory per project, i.e. pi's session store. */
  sessionDir: string;
  /** Warm-start seed. Omitted means memory only. */
  cacheFile?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
/** Bumped whenever `SessionRecord` changes shape; a mismatch drops the seed. */
const CACHE_VERSION = 2;
/**
 * A session file grows without bound, but everything the list shows lives in
 * its opening entries, so the skim stops here rather than at end of file.
 */
const SKIM_BYTES = 64 * 1024;
/**
 * How far back from the end the last user action is looked for. A long run
 * of tool output can bury it deeper, and then the oldest entry read stands in
 * for it: the user acted before that, so it is never later than the truth.
 */
const TAIL_BYTES = 512 * 1024;
/** Entries past the last user action still searched for a rename. */
const NAME_LOOKBACK = 200;
/** Entry timestamps are milliseconds, mtimes can round below them. */
const MTIME_SLACK_MS = 1000;

interface Candidate {
  path: string;
  mtimeMs: number;
  size: number;
}

export class SessionIndex {
  private readonly sessionDir: string;
  private readonly cacheFile?: string;
  private readonly defaultLimit: number;
  private readonly records = new Map<string, SessionRecord>();
  private seeded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(options: SessionIndexOptions) {
    this.sessionDir = options.sessionDir;
    this.cacheFile = options.cacheFile;
    this.defaultLimit = options.limit ?? DEFAULT_LIMIT;
  }

  /**
   * Fills the index before anyone asks for it.
   *
   * Called at startup and after the store changes, so the cost of the skim is
   * paid while nobody is waiting on a list.
   */
  async warm(): Promise<void> {
    await this.list({ limit: Number.MAX_SAFE_INTEGER });
  }

  async list(options: ListOptions = {}): Promise<ListPage> {
    await this.loadSeed();
    const limit = options.limit ?? this.defaultLimit;
    const offset = Math.max(0, options.offset ?? 0);

    // Stat order first: `activeAt` is never later than mtime, so walking by
    // mtime lets the scan stop as soon as nothing further down can make it in.
    const candidates = (await this.candidates()).sort((a, b) => b.mtimeMs - a.mtimeMs);

    const wanted = options.cwd ? resolve(options.cwd) : undefined;
    const needle = options.query?.trim().toLowerCase();
    const filtered = Boolean(wanted || needle);
    const needed = offset + limit;
    const kept: SessionRecord[] = [];

    for (const candidate of candidates) {
      const latest = candidate.mtimeMs + MTIME_SLACK_MS;
      if (!filtered && kept.length >= needed && latest < kthActive(kept, needed)) break;
      const record = await this.record(candidate);
      if (!record) continue;
      if (wanted && resolve(record.cwd || "/") !== wanted) continue;
      if (needle && !matches(record, needle)) continue;
      kept.push(record);
    }

    kept.sort((a, b) => b.activeAt - a.activeAt);
    const page = kept.slice(offset, needed);
    this.persist();
    // Unfiltered, an upper bound: a file with no header is counted but never
    // listed. Paging stays correct because a page is filled by walking on.
    const total = filtered ? kept.length : candidates.length;
    return { sessions: page, offset, total, hasMore: offset + page.length < total };
  }

  /**
   * Looks an id up, scanning the store first if it has never been read.
   *
   * An id arrives from a client that saw it in a list, so it almost always
   * hits the cache; the scan is for a daemon that restarted since.
   */
  async find(id: string): Promise<SessionRecord | undefined> {
    const known = this.recordFor(id);
    if (known) return known;
    await this.warm();
    return this.recordFor(id);
  }

  /** What the last scan saw for an id. */
  recordFor(id: string): SessionRecord | undefined {
    for (const record of this.records.values()) if (record.id === id) return record;
    return undefined;
  }

  /** The session file for an id, from what the last scan saw. */
  fileFor(id: string): string | undefined {
    return this.recordFor(id)?.path;
  }

  /** The record for one file, re-read if it changed since the last look. */
  async recordAt(path: string): Promise<SessionRecord | undefined> {
    try {
      const info = await stat(path);
      return (await this.record({ path, mtimeMs: info.mtimeMs, size: info.size })) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Drops a cached record, for a file known to have changed underneath us. */
  invalidate(path?: string): void {
    if (path) this.records.delete(path);
    else this.records.clear();
  }

  private async candidates(): Promise<Candidate[]> {
    const dirs = [this.sessionDir, ...(await subdirectories(this.sessionDir))];
    const found: Candidate[] = [];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        try {
          const info = await stat(path);
          found.push({ path, mtimeMs: info.mtimeMs, size: info.size });
        } catch {
          // Deleted between readdir and stat. Nothing to list.
        }
      }
    }
    return found;
  }

  /** Cached record if the file is unchanged, otherwise a fresh skim. */
  private async record(candidate: Candidate): Promise<SessionRecord | null> {
    const cached = this.records.get(candidate.path);
    if (cached && cached.mtimeMs === candidate.mtimeMs && cached.size === candidate.size) {
      return cached;
    }
    const record = await skim(candidate);
    if (!record) {
      this.records.delete(candidate.path);
      return null;
    }
    this.records.set(candidate.path, record);
    return record;
  }

  private async loadSeed(): Promise<void> {
    if (this.seeded) return;
    this.seeded = true;
    if (!this.cacheFile) return;
    try {
      const raw = JSON.parse(await readFile(this.cacheFile, "utf8")) as {
        version?: number;
        records?: SessionRecord[];
      };
      if (raw.version !== CACHE_VERSION || !Array.isArray(raw.records)) return;
      for (const record of raw.records) this.records.set(record.path, record);
    } catch {
      // Missing or corrupt: the next list rebuilds it. A slow list is the
      // whole cost of losing this file.
    }
  }

  /** Mirrors the in-memory records out, one writer at a time. */
  private persist(): void {
    const file = this.cacheFile;
    if (!file) return;
    const payload = JSON.stringify({
      version: CACHE_VERSION,
      records: [...this.records.values()],
    });
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        await writeFile(temporary, payload);
        await rename(temporary, file);
      } catch {
        // The seed is an optimisation; failing to write one is not an error.
      }
    });
  }
}

/** The `k`th most recent `activeAt` among what has been read so far. */
function kthActive(records: SessionRecord[], k: number): number {
  return records
    .map((record) => record.activeAt)
    .sort((a, b) => b - a)[k - 1]!;
}

function matches(record: SessionRecord, needle: string): boolean {
  return `${record.path} ${record.name ?? ""} ${record.preview}`.toLowerCase().includes(needle);
}

async function subdirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

/**
 * Reads the opening entries of a session file.
 *
 * Bounded by bytes rather than by entries: one pasted image is megabytes on a
 * single line, and a list must not stall on it.
 */
async function skim(candidate: Candidate): Promise<SessionRecord | null> {
  let id: string | undefined;
  let cwd = "";
  let createdAt = candidate.mtimeMs;
  let name: string | undefined;
  let preview = "";
  let messages = 0;

  const complete = candidate.size <= SKIM_BYTES;
  for await (const line of lines(candidate.path, SKIM_BYTES)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A line cut by the byte budget, or a partial write from a live pi.
      continue;
    }
    if (entry.type === "session") {
      id = typeof entry.id === "string" ? entry.id : undefined;
      cwd = typeof entry.cwd === "string" ? entry.cwd : "";
      const at = Date.parse(String(entry.timestamp));
      if (Number.isFinite(at)) createdAt = at;
      if (typeof entry.name === "string") name = entry.name;
      continue;
    }
    if (typeof entry.name === "string" && isNaming(entry.type)) name = entry.name;
    if (entry.type !== "message") continue;
    messages++;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (!preview && message?.role === "user") preview = previewText(textOf(message.content)).slice(0, 200);
    // A name can be set at any point, so a skim only stops once it has both.
    if (id && preview && name && !complete) break;
  }

  if (!id) return null;
  const tail = await skimTail(candidate);
  return {
    path: candidate.path,
    id,
    cwd,
    // A rename can land anywhere, and the head is only read so far.
    name: tail.name ?? name,
    createdAt,
    modifiedAt: candidate.mtimeMs,
    preview,
    messageCount: complete ? messages : undefined,
    activeAt: tail.activeAt ?? createdAt,
    mtimeMs: candidate.mtimeMs,
    size: candidate.size,
  };
}

/**
 * The latest user action and name, read backwards from the end of the file.
 *
 * Both live near the end of a session that is in use, and nowhere near the
 * head the list skim reads, so this reads the other end instead.
 */
async function skimTail(candidate: Candidate): Promise<{ activeAt?: number; name?: string }> {
  let activeAt: number | undefined;
  let name: string | undefined;
  let oldest: number | undefined;
  // A rename usually comes a few turns before the last prompt, so the scan
  // looks a little further for one; any deeper and the head skim answers.
  let beyond = 0;
  try {
    await scanTail(
      candidate.path,
      (entry) => {
        const at = entryTimestamp(entry);
        if (at !== undefined) oldest = at;
        if (name === undefined && typeof entry.name === "string" && isNaming(entry.type)) name = entry.name;
        if (activeAt === undefined && isUserAction(entry)) activeAt = at ?? oldest;
        if (activeAt !== undefined) beyond++;
        return name !== undefined ? activeAt !== undefined : beyond > NAME_LOOKBACK;
      },
      TAIL_BYTES,
    );
  } catch {
    return {};
  }
  return { activeAt: activeAt ?? oldest, name };
}

function isUserAction(entry: Record<string, unknown>): boolean {
  if (entry.type !== "message") return false;
  const role = (entry.message as { role?: unknown } | undefined)?.role;
  return role === "user" || role === "bashExecution";
}

function isNaming(type: unknown): boolean {
  return type === "session_name" || type === "name_change" || type === "session_info";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text = content.find(
    (part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
  );
  return text?.text ?? "";
}

/**
 * LF-framed lines from the head of a file.
 *
 * Not `readline`: it also splits on U+2028 and U+2029, which are legal inside
 * JSON strings and so appear in real transcripts.
 */
async function* lines(path: string, budget: number): AsyncGenerator<string> {
  const stream = createReadStream(path, { start: 0, end: budget - 1, encoding: "utf8" });
  let buffer = "";
  try {
    for await (const chunk of stream) {
      buffer += chunk as string;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line) yield line;
      }
    }
    if (buffer) yield buffer;
  } finally {
    stream.destroy();
  }
}

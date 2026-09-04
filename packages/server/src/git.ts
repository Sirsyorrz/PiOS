import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import { containedPath } from "./paths.ts";

/**
 * Local git state for a session directory.
 *
 * Read-only status plus the working-tree actions that need no network. Fetch,
 * pull and push are deliberately absent: they need credentials, they can hang
 * for a minute, and managing a remote is not this daemon's job.
 */

export interface GitFile {
  path: string;
  /** Porcelain v2 staged-side code, "." when unchanged. */
  index: string;
  /** Porcelain v2 worktree-side code, "." when unchanged. */
  work: string;
  /** Pre-rename path, for a staged rename or copy. */
  from?: string;
  untracked?: boolean;
  unmerged?: boolean;
}

export interface GitStatus {
  /** Repository top level, which is not necessarily the session cwd. */
  root: string;
  /** Session cwd relative to the root, "" at the top level. */
  prefix: string;
  branch: string | null;
  head: string | null;
  /** Ahead/behind against the tracked branch, read from local refs only. */
  upstream: { name: string; ahead: number; behind: number } | null;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  files: GitFile[];
  /** True when `files` was cut short; the counts above are still exact. */
  truncated: boolean;
}

/** Above this the list is neither renderable on a phone nor worth sending. */
const MAX_FILES = 500;

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

/** Status is asked for on every open and after every action; this absorbs bursts. */
const CACHE_TTL_MS = 1_000;
const cache = new Map<string, { at: number; status: GitStatus | null }>();

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Runs git with an argument vector, never a shell string: paths here come from
 * a client and may contain anything a filename may contain.
 */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || error.message).trim().split("\n").slice(0, 4).join("\n");
          reject(new GitError(detail || "git failed"));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

/**
 * Runs git and returns stdout even on a non-zero exit.
 *
 * `diff --no-index` exits 1 precisely when it produced output, so for that
 * call a failure status carries no information.
 */
function gitTolerant(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: "utf8" },
      (_error, stdout) => resolvePromise(stdout ?? ""),
    );
  });
}

/** Repository top level containing `cwd`, or null when there is none. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return out.trim() || null;
  } catch {
    // Not a repository, git missing, or the directory is gone. All three mean
    // the same thing to a caller: there is no git here.
    return null;
  }
}

export function invalidateGitCache(cwd?: string): void {
  if (cwd) cache.delete(resolve(cwd));
  else cache.clear();
}

export async function gitStatus(cwd: string, options: { fresh?: boolean } = {}): Promise<GitStatus | null> {
  const key = resolve(cwd);
  const hit = cache.get(key);
  if (!options.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.status;

  const status = await readStatus(cwd);
  cache.set(key, { at: Date.now(), status });
  return status;
}

async function readStatus(cwd: string): Promise<GitStatus | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;

  const out = await git(cwd, [
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=normal",
    "-z",
  ]);
  const status = parsePorcelainV2(out);
  return {
    ...status,
    root,
    prefix: relative(root, resolve(cwd)),
  };
}

/**
 * Parses `git status --porcelain=v2 -z`.
 *
 * Records are NUL-separated, not newline-separated: a filename may legally
 * contain a newline, so splitting on one would invent files that do not exist.
 * A rename record is followed by a second record holding the original path.
 */
export function parsePorcelainV2(out: string): Omit<GitStatus, "root" | "prefix"> {
  const records = out.split("\0");
  const files: GitFile[] = [];
  let branch: string | null = null;
  let head: string | null = null;
  let upstreamName: string | null = null;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record === "") continue;

    if (record.startsWith("# ")) {
      const [key, ...rest] = record.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.head") branch = value === "(detached)" ? null : value;
      else if (key === "branch.oid") head = value.startsWith("(") ? null : value.slice(0, 8);
      else if (key === "branch.upstream") upstreamName = value;
      else if (key === "branch.ab") {
        for (const token of value.split(" ")) {
          if (token.startsWith("+")) ahead = Number(token.slice(1)) || 0;
          if (token.startsWith("-")) behind = Number(token.slice(1)) || 0;
        }
      }
      continue;
    }

    const kind = record[0];
    let file: GitFile | null = null;

    if (kind === "1" || kind === "2") {
      const fields = record.split(" ");
      const xy = fields[1] ?? "..";
      // Fixed field count up to the path, which may itself contain spaces.
      const pathStart = kind === "1" ? 8 : 9;
      file = { path: fields.slice(pathStart).join(" "), index: xy[0]!, work: xy[1]! };
      // The rename source is its own NUL-terminated record.
      if (kind === "2") file.from = records[++i] ?? "";
      if (file.index !== ".") staged++;
      if (file.work !== ".") unstaged++;
    } else if (kind === "u") {
      const fields = record.split(" ");
      const xy = fields[1] ?? "UU";
      file = { path: fields.slice(10).join(" "), index: xy[0]!, work: xy[1]!, unmerged: true };
      conflicted++;
    } else if (kind === "?") {
      file = { path: record.slice(2), index: ".", work: "?", untracked: true };
      untracked++;
    }

    if (!file) continue;
    if (files.length < MAX_FILES) files.push(file);
  }

  return {
    branch,
    head,
    upstream: upstreamName ? { name: upstreamName, ahead, behind } : null,
    staged,
    unstaged,
    untracked,
    conflicted,
    files,
    truncated: staged + unstaged + untracked + conflicted > files.length,
  };
}

/**
 * Resolves a client-supplied path against the repository root.
 *
 * `containedPath` alone is not enough: the session cwd may sit below the root,
 * and `git -C` would happily accept a path reaching up into a parent repo.
 */
function repoPath(root: string, candidate: string): string | null {
  const contained = containedPath(root, candidate);
  if (!contained) return null;
  return relative(root, contained) || ".";
}

function repoPaths(root: string, candidates: string[]): string[] | null {
  const out: string[] = [];
  for (const candidate of candidates) {
    const path = repoPath(root, candidate);
    if (!path) return null;
    out.push(path);
  }
  return out;
}

/** Unified diff for one file, or for the whole tree when `path` is omitted. */
export async function gitDiff(
  cwd: string,
  options: { path?: string; staged?: boolean; context?: number } = {},
): Promise<{ root: string; diff: string; untracked: boolean } | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;

  const args = ["diff", "--no-color", `--unified=${options.context ?? 3}`];
  if (options.staged) args.push("--staged");

  if (!options.path) return { root, diff: await git(root, args), untracked: false };

  const path = repoPath(root, options.path);
  if (!path) throw new GitError("path outside repository");

  // An untracked file has nothing to diff against, so it is shown against the
  // empty tree instead of silently rendering as no change at all.
  if (!options.staged && (await isUntracked(root, path))) {
    const diff = await gitTolerant(root, [
      "diff",
      "--no-color",
      "--no-index",
      `--unified=${options.context ?? 3}`,
      "--",
      "/dev/null",
      path,
    ]);
    return { root, diff, untracked: true };
  }

  return { root, diff: await git(root, [...args, "--", path]), untracked: false };
}

async function isUntracked(root: string, path: string): Promise<boolean> {
  const out = await git(root, ["ls-files", "--error-unmatch", "--", path]).catch(() => null);
  return out === null;
}

export interface GitLogEntry {
  sha: string;
  subject: string;
  author: string;
  at: number;
}

export async function gitLog(cwd: string, limit = 30): Promise<GitLogEntry[] | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const count = Math.min(Math.max(limit, 1), 200);
  const out = await git(root, [
    "log",
    `--max-count=${count}`,
    "--no-color",
    "--format=%h%x1f%s%x1f%an%x1f%at%x1e",
  ]).catch(() => "");

  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", subject = "", author = "", at = "0"] = record.split("\x1f");
      return { sha, subject, author, at: Number(at) * 1000 };
    });
}

export type GitAction =
  | { type: "stage"; paths: string[] }
  | { type: "stage_all" }
  | { type: "unstage"; paths: string[] }
  | { type: "unstage_all" }
  | { type: "discard"; paths: string[] }
  | { type: "commit"; message: string; amend?: boolean }
  | { type: "stash" }
  | { type: "stash_pop" };

/**
 * Actions that mutate the working tree.
 *
 * `discard` stashes rather than checking out: the caller is on a phone and
 * cannot see the whole change being thrown away, so the destructive form is
 * the recoverable one.
 */
export async function gitAction(cwd: string, action: GitAction): Promise<GitStatus | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;

  const args = await actionArgs(root, action);
  try {
    await git(root, args);
  } finally {
    invalidateGitCache(cwd);
  }
  return await gitStatus(cwd, { fresh: true });
}

async function actionArgs(root: string, action: GitAction): Promise<string[]> {
  switch (action.type) {
    case "stage_all":
      return ["add", "-A"];
    case "unstage_all":
      return (await hasHead(root))
        ? ["reset", "--quiet", "HEAD", "--"]
        : ["rm", "--cached", "-r", "--quiet", "--", "."];
    case "stage":
    case "unstage":
    case "discard": {
      const paths = repoPaths(root, action.paths);
      if (!paths || paths.length === 0) throw new GitError("no valid paths");
      if (action.type === "stage") return ["add", "--", ...paths];
      // Before the first commit there is no HEAD to reset against.
      if (action.type === "unstage") {
        return (await hasHead(root))
          ? ["reset", "--quiet", "HEAD", "--", ...paths]
          : ["rm", "--cached", "-r", "--quiet", "--", ...paths];
      }
      return ["stash", "push", "--include-untracked", "--", ...paths];
    }
    case "commit": {
      const message = action.message.trim();
      if (!message && !action.amend) throw new GitError("empty commit message");
      const args = ["commit"];
      if (action.amend) args.push("--amend");
      args.push(...(message ? ["--message", message] : ["--no-edit"]));
      return args;
    }
    case "stash":
      return ["stash", "push", "--include-untracked"];
    case "stash_pop":
      return ["stash", "pop"];
    default:
      throw new GitError("unknown action");
  }
}

async function hasHead(root: string): Promise<boolean> {
  const out = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => null);
  return Boolean(out?.trim());
}

/** Narrows a JSON body to a `GitAction`, rejecting anything else. */
export function parseGitAction(body: unknown): GitAction | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const type = record.type;
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((p): p is string => typeof p === "string")
    : [];

  switch (type) {
    case "stage":
    case "unstage":
    case "discard":
      return paths.length > 0 ? { type, paths } : null;
    case "stage_all":
    case "unstage_all":
    case "stash":
    case "stash_pop":
      return { type };
    case "commit":
      return typeof record.message === "string"
        ? { type, message: record.message, amend: record.amend === true }
        : null;
    default:
      return null;
  }
}

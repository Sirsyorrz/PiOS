import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import type {
  GitAction,
  GitBranch,
  GitBranches,
  GitFile,
  GitLogEntry,
  GitOperation,
  GitStash,
  GitStatus,
} from "@pios/protocol";
import { containedPath } from "./paths.ts";

/**
 * Git state for a session directory, and the one way git is run.
 *
 * Everything a phone client can read: status, diffs, history, branches and
 * stashes. What changes the repository lives in `git-actions.ts`; both go
 * through `git()`, which never lets git prompt for anything.
 */

/** Above this the list is neither renderable on a phone nor worth sending. */
const MAX_FILES = 500;

const TIMEOUT_MS = 10_000;
/** A fetch over a slow link is normal; a hung credential prompt is not. */
const NETWORK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

/** Status is asked for on every open and after every action; this absorbs bursts. */
const CACHE_TTL_MS = 1_000;
const cache = new Map<string, { at: number; status: GitStatus | null }>();

/**
 * Nothing may open a terminal, a GUI prompt, or an editor.
 *
 * The daemon has no tty. Without this a push to a repository whose credentials
 * expired blocks until the timeout instead of failing with a message the user
 * can act on.
 */
const NON_INTERACTIVE = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  SSH_ASKPASS: "true",
  SSH_ASKPASS_REQUIRE: "never",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
  GIT_EDITOR: "true",
};

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

interface RunOptions {
  /** Network deadline and non-interactive credential handling. */
  network?: boolean;
}

/**
 * Runs git with an argument vector, never a shell string: paths here come from
 * a client and may contain anything a filename may contain.
 */
export function git(cwd: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      {
        cwd,
        timeout: options.network ? NETWORK_TIMEOUT_MS : TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
        encoding: "utf8",
        env: { ...process.env, ...NON_INTERACTIVE },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new GitError(failureDetail(stderr || stdout || error.message)));
          return;
        }
        // Progress and "Everything up-to-date" arrive on stderr; for a remote
        // operation that text is the entire result worth showing.
        resolvePromise(options.network ? collapseProgress(`${stdout}${stderr}`) : stdout);
      },
    );
  });
}

/**
 * Keeps only the final state of each carriage-return-overwritten line.
 *
 * Git redraws counters in place with `\r`. Nothing here is a terminal, so
 * without this the client renders every intermediate percentage as text.
 */
function collapseProgress(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split("\r").filter((part) => part.trim().length > 0).at(-1) ?? "")
    .join("\n");
}

/**
 * The part of a git failure worth reading on a phone.
 *
 * Git pads a refusal with a block of `hint:` lines suggesting commands the
 * user cannot run from here; they push the actual reason off the screen, so
 * they are kept only when there is nothing else.
 */
function failureDetail(text: string): string {
  const lines = text.trim().split("\n").filter((line) => line.trim().length > 0);
  const reasons = lines.filter((line) => !line.startsWith("hint:"));
  return (reasons.length > 0 ? reasons : lines).slice(0, 6).join("\n") || "git failed";
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
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
        encoding: "utf8",
        env: { ...process.env, ...NON_INTERACTIVE },
      },
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

  const [out, operation, stashes, remotes] = await Promise.all([
    git(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal", "-z"]),
    readOperation(root),
    countStashes(root),
    listRemotes(root),
  ]);

  const status = parsePorcelainV2(out);
  return {
    ...status,
    root,
    prefix: relative(root, resolve(cwd)),
    operation,
    stashes,
    remotes,
    defaultRemote: remotes.includes("origin") ? "origin" : (remotes[0] ?? null),
  };
}

/**
 * Which multi-step operation, if any, the repository is in the middle of.
 *
 * Read from the state files rather than from `status`, whose porcelain format
 * does not report it. Without it a refused checkout looks like a bug.
 */
export async function readOperation(root: string): Promise<GitOperation | null> {
  const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"]).catch(() => "")).trim();
  if (!gitDir) return null;
  const { existsSync } = await import("node:fs");
  const at = (name: string) => existsSync(resolve(gitDir, name));
  if (at("rebase-merge") || at("rebase-apply")) return "rebase";
  if (at("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (at("REVERT_HEAD")) return "revert";
  if (at("MERGE_HEAD")) return "merge";
  if (at("BISECT_LOG")) return "bisect";
  return null;
}

async function countStashes(root: string): Promise<number> {
  const out = await git(root, ["stash", "list", "--format=%gd"]).catch(() => "");
  return out.split("\n").filter((line) => line.trim().length > 0).length;
}

export async function listRemotes(root: string): Promise<string[]> {
  const out = await git(root, ["remote"]).catch(() => "");
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Parses `git status --porcelain=v2 -z`.
 *
 * Records are NUL-separated, not newline-separated: a filename may legally
 * contain a newline, so splitting on one would invent files that do not exist.
 * A rename record is followed by a second record holding the original path.
 */
export function parsePorcelainV2(
  out: string,
): Omit<GitStatus, "root" | "prefix" | "operation" | "stashes" | "remotes" | "defaultRemote"> {
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

export function repoPaths(root: string, candidates: string[]): string[] | null {
  const out: string[] = [];
  for (const candidate of candidates) {
    const path = repoPath(root, candidate);
    if (!path) return null;
    out.push(path);
  }
  return out;
}

/**
 * A ref name that git will accept and that cannot be read as an option.
 *
 * Client input reaches an argv position where git would treat a leading dash
 * as a flag, so the shape is checked here rather than trusted to `--`.
 */
export function checkRef(name: string): string {
  const ref = name.trim();
  if (!ref || ref.startsWith("-") || /[\s~^:?*[\\]/.test(ref) || ref.includes("..")) {
    throw new GitError(`invalid ref name: ${name}`);
  }
  return ref;
}

/** A stash selector, which is a reflog entry, not a ref name. */
export function checkStash(name: string): string {
  if (!/^stash@\{\d+\}$/.test(name.trim())) throw new GitError(`invalid stash: ${name}`);
  return name.trim();
}

/** Unified diff for one file, or for the whole tree when `path` is omitted. */
export async function gitDiff(
  cwd: string,
  options: { path?: string; staged?: boolean; context?: number; commit?: string; stash?: string } = {},
): Promise<{ root: string; diff: string; untracked: boolean } | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;

  const context = `--unified=${clampContext(options.context)}`;

  // A stash is a merge commit whose second and third parents are the index and
  // the untracked files; `git show` on it prints a combined diff that hides
  // both. `stash show` reads it the way it was made.
  if (options.stash) {
    const ref = checkStash(options.stash);
    return {
      root,
      diff: await git(root, ["stash", "show", "--no-color", "--patch", "--include-untracked", context, ref]),
      untracked: false,
    };
  }

  // A commit is a fixed object: its diff is against its own parent, so the
  // index and worktree play no part.
  if (options.commit) {
    const sha = checkRef(options.commit);
    const args = ["show", "--no-color", "--format=", context, sha];
    if (options.path) {
      const path = repoPath(root, options.path);
      if (!path) throw new GitError("path outside repository");
      args.push("--", path);
    }
    return { root, diff: await git(root, args), untracked: false };
  }

  const args = ["diff", "--no-color", context];
  if (options.staged) args.push("--staged");

  if (!options.path) return { root, diff: await git(root, args), untracked: false };

  const path = repoPath(root, options.path);
  if (!path) throw new GitError("path outside repository");

  // An untracked file has nothing to diff against, so it is shown against the
  // empty tree instead of silently rendering as no change at all.
  if (!options.staged && (await isUntracked(root, path))) {
    return { root, diff: await untrackedDiff(root, path, context), untracked: true };
  }

  return { root, diff: await git(root, [...args, "--", path]), untracked: false };
}

function clampContext(value: number | undefined): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(Math.max(Math.trunc(value!), 0), 20);
}

/** Above this an untracked directory is a build output, not a change to read. */
const MAX_UNTRACKED_FILES = 20;

/**
 * The contents of something git has never seen, as a patch against nothing.
 *
 * Status reports an untracked directory as a single entry, so the tapped path
 * may be a directory; diffing it against `/dev/null` yields nothing at all,
 * which reads as "no change" for a folder full of new code.
 */
async function untrackedDiff(root: string, path: string, context: string): Promise<string> {
  const listed = await git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    path,
  ]).catch(() => "");
  const files = listed.split("\0").filter(Boolean);
  const targets = files.length > 0 ? files.slice(0, MAX_UNTRACKED_FILES) : [path];

  const parts: string[] = [];
  for (const file of targets) {
    parts.push(await gitTolerant(root, ["diff", "--no-color", "--no-index", context, "--", "/dev/null", file]));
  }
  if (files.length > targets.length) {
    parts.push(`\\ ${files.length - targets.length} more untracked files not shown\n`);
  }
  return parts.join("");
}

async function isUntracked(root: string, path: string): Promise<boolean> {
  const out = await git(root, ["ls-files", "--error-unmatch", "--", path]).catch(() => null);
  return out === null;
}

export async function gitLog(
  cwd: string,
  options: { limit?: number; skip?: number; ref?: string } = {},
): Promise<GitLogEntry[] | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const count = Math.min(Math.max(options.limit ?? 30, 1), 200);
  const skip = Math.max(options.skip ?? 0, 0);
  const args = [
    "log",
    `--max-count=${count}`,
    `--skip=${skip}`,
    "--no-color",
    "--format=%h%x1f%s%x1f%an%x1f%at%x1f%D%x1e",
  ];
  if (options.ref) args.push(checkRef(options.ref));
  const out = await git(root, args).catch(() => "");

  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", subject = "", author = "", at = "0", refs = ""] = record.split("\x1f");
      return {
        sha,
        subject,
        author,
        at: Number(at) * 1000,
        refs: refs.split(", ").map((r) => r.replace(/^HEAD -> /, "")).filter(Boolean),
      };
    });
}

const REF_FORMAT =
  "%(refname:short)%1f%(objectname:short)%1f%(contents:subject)%1f%(committerdate:unix)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)";

export async function gitBranches(cwd: string): Promise<GitBranches | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;

  const [localOut, remoteOut, headOut, remotes] = await Promise.all([
    git(root, ["for-each-ref", "--sort=-committerdate", `--format=${REF_FORMAT}`, "refs/heads"]),
    git(root, [
      "for-each-ref",
      "--sort=-committerdate",
      "--count=200",
      `--format=${REF_FORMAT}`,
      "refs/remotes",
    ]),
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
    listRemotes(root),
  ]);

  const current = headOut.trim() || null;
  const local = parseRefs(localOut, false);
  // `origin/HEAD` is a symbolic alias, not a branch anyone checks out.
  const remote = parseRefs(remoteOut, true).filter((b) => !b.name.endsWith("/HEAD"));

  return { current, detached: current === null, local, remote, remotes };
}

function parseRefs(out: string, remote: boolean): GitBranch[] {
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [name = "", sha = "", subject = "", at = "0", upstream = "", track = "", head = ""] =
        line.split("\x1f");
      const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
      const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
      return {
        name,
        remote,
        current: head.trim() === "*",
        sha,
        subject,
        at: Number(at) * 1000,
        upstream: upstream || null,
        ahead,
        behind,
        gone: track.includes("gone"),
      };
    });
}

export async function gitStashes(cwd: string): Promise<GitStash[] | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;
  const out = await git(root, ["stash", "list", "--format=%gd%x1f%s%x1f%ct%x1e"]).catch(() => "");
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [ref = "", message = "", at = "0"] = record.split("\x1f");
      // "WIP on main: 1a2b3c subject" and "On main: message" both name the
      // branch first; it is the only part worth a column of its own.
      const branch = /^(?:WIP on|On) ([^:]+):/.exec(message)?.[1] ?? null;
      return { ref, message, at: Number(at) * 1000, branch };
    });
}

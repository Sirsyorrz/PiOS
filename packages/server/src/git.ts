import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import { containedPath } from "./paths.ts";

/**
 * Git state and operations for a session directory.
 *
 * Everything a phone client can ask for: status, diffs, history, branches,
 * stashes, and the remote operations that need the network. Remote work is
 * kept apart from local work because only it can block on credentials, so it
 * runs non-interactively and with a much longer deadline.
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
  /** Rebase, merge, cherry-pick and friends, so the UI can say why git refuses. */
  operation: GitOperation | null;
  stashes: number;
  remotes: string[];
  /** Name of the branch a push would create upstream, when there is none yet. */
  defaultRemote: string | null;
}

export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

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
function git(cwd: string, args: string[], options: RunOptions = {}): Promise<string> {
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
async function readOperation(root: string): Promise<GitOperation | null> {
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

async function listRemotes(root: string): Promise<string[]> {
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

function repoPaths(root: string, candidates: string[]): string[] | null {
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
function checkRef(name: string): string {
  const ref = name.trim();
  if (!ref || ref.startsWith("-") || /[\s~^:?*[\\]/.test(ref) || ref.includes("..")) {
    throw new GitError(`invalid ref name: ${name}`);
  }
  return ref;
}

/** A stash selector, which is a reflog entry, not a ref name. */
function checkStash(name: string): string {
  if (!/^stash@\{\d+\}$/.test(name.trim())) throw new GitError(`invalid stash: ${name}`);
  return name.trim();
}

/** Unified diff for one file, or for the whole tree when `path` is omitted. */
export async function gitDiff(
  cwd: string,
  options: { path?: string; staged?: boolean; context?: number; commit?: string } = {},
): Promise<{ root: string; diff: string; untracked: boolean } | null> {
  const root = await repoRoot(cwd);
  if (!root) return null;

  const context = `--unified=${clampContext(options.context)}`;

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

export interface GitLogEntry {
  sha: string;
  subject: string;
  author: string;
  at: number;
  /** Branch and tag names pointing here, for the history rail. */
  refs: string[];
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

export interface GitBranch {
  name: string;
  /** "origin/main" style name for a remote-tracking ref. */
  remote: boolean;
  current: boolean;
  sha: string;
  subject: string;
  at: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface GitBranches {
  current: string | null;
  detached: boolean;
  local: GitBranch[];
  remote: GitBranch[];
  remotes: string[];
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

export interface GitStash {
  ref: string;
  message: string;
  at: number;
  branch: string | null;
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

export type GitAction =
  | { type: "stage"; paths: string[] }
  | { type: "stage_all" }
  | { type: "unstage"; paths: string[] }
  | { type: "unstage_all" }
  | { type: "discard"; paths: string[] }
  | { type: "commit"; message: string; amend?: boolean }
  | { type: "stash"; message?: string }
  | { type: "stash_pop"; ref?: string }
  | { type: "stash_apply"; ref: string }
  | { type: "stash_drop"; ref: string }
  | { type: "checkout"; branch: string; create?: boolean; from?: string }
  | { type: "delete_branch"; branch: string; force?: boolean }
  | { type: "merge"; branch: string }
  | { type: "abort" }
  | { type: "continue" }
  | { type: "init" }
  | { type: "fetch"; remote?: string; prune?: boolean }
  | { type: "pull"; rebase?: boolean }
  | { type: "push"; remote?: string; force?: boolean; setUpstream?: boolean };

const NETWORK_ACTIONS = new Set(["fetch", "pull", "push"]);

export interface GitActionResult {
  status: GitStatus | null;
  /** Git's own words, shown verbatim for the operations that report progress. */
  output: string;
}

/**
 * Actions that change the repository.
 *
 * `discard` stashes rather than checking out: the caller is on a phone and
 * cannot see the whole change being thrown away, so the destructive form is
 * the recoverable one.
 */
export async function gitAction(cwd: string, action: GitAction): Promise<GitActionResult | null> {
  // The one action whose whole point is that there is no repository yet.
  if (action.type === "init") {
    try {
      await git(cwd, ["init"]);
    } finally {
      invalidateGitCache(cwd);
    }
    return { status: await gitStatus(cwd, { fresh: true }), output: "" };
  }

  const root = await repoRoot(cwd);
  if (!root) return null;

  const network = NETWORK_ACTIONS.has(action.type);
  const args = await actionArgs(root, action);
  let output = "";
  try {
    output = await git(root, args, { network });
  } finally {
    invalidateGitCache(cwd);
  }
  return { status: await gitStatus(cwd, { fresh: true }), output: output.trim() };
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
    case "stash": {
      const args = ["stash", "push", "--include-untracked"];
      if (action.message?.trim()) args.push("--message", action.message.trim());
      return args;
    }
    case "stash_pop":
      return ["stash", "pop", ...(action.ref ? [checkStash(action.ref)] : [])];
    case "stash_apply":
      return ["stash", "apply", checkStash(action.ref)];
    case "stash_drop":
      return ["stash", "drop", checkStash(action.ref)];
    case "checkout": {
      const branch = checkRef(action.branch);
      if (action.create) {
        // `-b` fails loudly when the name is taken, which is the answer the
        // user wants: silently switching to someone else's branch is worse.
        return ["checkout", "-b", branch, ...(action.from ? [checkRef(action.from)] : [])];
      }
      return ["checkout", branch];
    }
    case "delete_branch":
      return ["branch", action.force ? "-D" : "-d", checkRef(action.branch)];
    case "merge":
      return ["merge", "--no-edit", checkRef(action.branch)];
    case "abort":
    case "continue": {
      // Whichever multi-step operation is open decides the verb; asking the
      // client to name it would let a stale UI abort the wrong thing.
      const operation = await readOperation(root);
      if (!operation) throw new GitError("nothing in progress");
      if (action.type === "abort") {
        return operation === "bisect" ? ["bisect", "reset"] : [operation, "--abort"];
      }
      if (operation === "merge") return ["commit", "--no-edit"];
      if (operation === "bisect") throw new GitError("a bisect is continued on the machine");
      return [operation, "--continue"];
    }
    case "fetch": {
      // No `--progress`: there is no terminal to redraw, and the percentages
      // would arrive as text the client then has to filter out.
      const args = ["fetch", "--no-tags"];
      if (action.prune) args.push("--prune");
      args.push(action.remote ? checkRef(action.remote) : "--all");
      return args;
    }
    case "pull":
      // No merge commit is authored blind from a phone; a fast-forward or an
      // explicit rebase are the only outcomes that need no review.
      return action.rebase ? ["pull", "--rebase"] : ["pull", "--ff-only"];
    case "push": {
      const args = ["push"];
      // Never a bare `--force`: a lease refuses when the remote moved under
      // someone else's commit, which is the case worth stopping for.
      if (action.force) args.push("--force-with-lease");
      if (action.setUpstream) {
        const branch = await currentBranch(root);
        if (!branch) throw new GitError("detached HEAD has no branch to push");
        const remote = action.remote ? checkRef(action.remote) : (await listRemotes(root))[0];
        if (!remote) throw new GitError("no remote configured");
        args.push("--set-upstream", remote, branch);
      } else if (action.remote) {
        args.push(checkRef(action.remote));
      }
      return args;
    }
    default:
      throw new GitError("unknown action");
  }
}

async function currentBranch(root: string): Promise<string | null> {
  const out = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  return out.trim() || null;
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
  const text = (key: string): string | undefined =>
    typeof record[key] === "string" ? (record[key] as string) : undefined;

  switch (type) {
    case "stage":
    case "unstage":
    case "discard":
      return paths.length > 0 ? { type, paths } : null;
    case "stage_all":
    case "unstage_all":
      return { type };
    case "stash":
      return { type, message: text("message") };
    case "stash_pop":
      return { type, ref: text("ref") };
    case "stash_apply":
    case "stash_drop": {
      const ref = text("ref");
      return ref ? { type, ref } : null;
    }
    case "commit":
      return typeof record.message === "string"
        ? { type, message: record.message, amend: record.amend === true }
        : null;
    case "checkout": {
      const branch = text("branch");
      return branch
        ? { type, branch, create: record.create === true, from: text("from") }
        : null;
    }
    case "delete_branch": {
      const branch = text("branch");
      return branch ? { type, branch, force: record.force === true } : null;
    }
    case "merge": {
      const branch = text("branch");
      return branch ? { type, branch } : null;
    }
    case "abort":
    case "continue":
    case "init":
      return { type };
    case "fetch":
      return { type, remote: text("remote"), prune: record.prune === true };
    case "pull":
      return { type, rebase: record.rebase === true };
    case "push":
      return {
        type,
        remote: text("remote"),
        force: record.force === true,
        setUpstream: record.setUpstream === true,
      };
    default:
      return null;
  }
}

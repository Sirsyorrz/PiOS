/**
 * Bodies of the daemon's HTTP routes, shared so the web client reads exactly
 * what the server writes.
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

export interface GitLogEntry {
  sha: string;
  subject: string;
  author: string;
  at: number;
  /** Branch and tag names pointing here, for the history rail. */
  refs: string[];
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

export interface GitStash {
  ref: string;
  message: string;
  at: number;
  branch: string | null;
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

export interface UsageWindow {
  key: string;
  label: string;
  percent: number;
  resetsAt: string | null;
}

export interface UsageReport {
  windows: UsageWindow[];
  /** Extra-usage credits, in minor units of `currency`, when enabled. */
  spend: { used: number; limit: number | null; currency: string; exponent: number } | null;
  fetchedAt: number;
}

export interface TextFile {
  etag: string;
  bytes: number;
  /** LF-normalised content, or the head of it when `editable` is false. */
  text: string;
  /** Line ending to restore on save. */
  eol: "lf" | "crlf";
  trailingNewline: boolean;
  editable: boolean;
  /** Why editing is refused, for the client to show verbatim. */
  reason?: "too_large" | "binary" | "long_lines";
}

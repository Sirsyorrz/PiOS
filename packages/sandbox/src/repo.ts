import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Throwaway git repository used as a session cwd.
 *
 * The git routes shell out to real git, so the only honest fixture is a real
 * repository. It lives in a temp dir the sandbox deletes on exit, which is
 * what keeps a UI experiment from ever touching the developer's own tree.
 */
export interface RepoSpec {
  /** Files committed first, so later edits show up as a diff. */
  base?: Record<string, string>;
  /** Edits to tracked files, left unstaged. */
  modified?: Record<string, string>;
  /** Edits added to the index. */
  staged?: Record<string, string>;
  /** Files git has never seen. */
  untracked?: Record<string, string>;
  deleted?: string[];
  /** Extra commits after the base one, newest last. */
  commits?: { message: string; files: Record<string, string> }[];
  branch?: string;
  /** Branches created off the base commit, left unchecked out. */
  branches?: string[];
  /**
   * A bare origin beside the repo, so the remote UI has something real.
   *
   * `ahead`/`behind` are simulated by pushing, then rewinding or advancing the
   * remote: divergence read from local refs is the only kind the client sees.
   */
  remote?: { ahead?: number; behind?: number };
  /** Stash entries, made from a throwaway edit to the first base file. */
  stashes?: string[];
  /** Leaves the repo mid-merge with a conflict in `path`, as git would. */
  conflict?: { branch: string; path: string };
}

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Sandbox",
  GIT_AUTHOR_EMAIL: "sandbox@example.invalid",
  GIT_COMMITTER_NAME: "Sandbox",
  GIT_COMMITTER_EMAIL: "sandbox@example.invalid",
  // A developer's own hooks, templates, or signing key must not run here.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

/** For the commands whose failure is the point, such as a conflicting merge. */
function gitTry(cwd: string, ...args: string[]): void {
  try {
    execFileSync("git", args, { cwd, env: ENV, stdio: "ignore" });
  } catch {
    // The caller asked for the state git leaves behind, not for success.
  }
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export function createRepo(root: string, spec: RepoSpec = {}): string {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", spec.branch ?? "main");

  write(root, spec.base ?? { "README.md": "# sandbox\n" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "initial commit");

  for (const commit of spec.commits ?? []) {
    write(root, commit.files);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", commit.message);
  }

  if (spec.conflict) makeConflict(root, spec.conflict);
  for (const branch of spec.branches ?? []) git(root, "branch", branch);
  if (spec.remote) attachRemote(root, spec.remote);

  for (const message of spec.stashes ?? []) {
    writeFileSync(join(root, "scratch.tmp"), `${message}\n`);
    git(root, "stash", "push", "--include-untracked", "-m", message);
  }

  if (spec.staged) {
    write(root, spec.staged);
    git(root, "add", ...Object.keys(spec.staged));
  }
  if (spec.modified) write(root, spec.modified);
  if (spec.untracked) write(root, spec.untracked);
  for (const path of spec.deleted ?? []) rmSync(join(root, path), { force: true });

  return root;
}

/** Two edits to one line on two branches, merged, and left where git stops. */
function makeConflict(root: string, spec: { branch: string; path: string }): void {
  const here = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  git(root, "checkout", "-q", "-b", spec.branch);
  write(root, { [spec.path]: "the other branch's version\n" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", `rewrite ${spec.path}`);

  git(root, "checkout", "-q", here);
  write(root, { [spec.path]: "this branch's version\n" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", `edit ${spec.path}`);
  gitTry(root, "merge", "--no-edit", spec.branch);
}

/**
 * A bare repository beside the work tree, wired up as `origin`.
 *
 * Local, so nothing in the sandbox can reach the network, and real, so fetch,
 * pull and push do what they would do against a server.
 */
function attachRemote(root: string, spec: { ahead?: number; behind?: number }): void {
  const origin = `${root}.origin.git`;
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "--bare");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "--set-upstream", "origin", "HEAD");

  // Commits the remote has and the work tree does not: made here, pushed, then
  // rewound locally so the branch reads as behind.
  for (let i = 0; i < (spec.behind ?? 0); i++) {
    writeFileSync(join(root, `remote-${i}.txt`), `from the remote ${i}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", `upstream change ${i + 1}`);
  }
  if (spec.behind) {
    git(root, "push", "-q");
    git(root, "reset", "-q", "--hard", `HEAD~${spec.behind}`);
    // The remote-tracking ref must keep the commits the reset threw away.
    git(root, "fetch", "-q", "origin");
  }

  for (let i = 0; i < (spec.ahead ?? 0); i++) {
    writeFileSync(join(root, `local-${i}.txt`), `not pushed yet ${i}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", `local change ${i + 1}`);
  }
}

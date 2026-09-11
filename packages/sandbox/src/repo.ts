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

  if (spec.staged) {
    write(root, spec.staged);
    git(root, "add", ...Object.keys(spec.staged));
  }
  if (spec.modified) write(root, spec.modified);
  if (spec.untracked) write(root, spec.untracked);
  for (const path of spec.deleted ?? []) rmSync(join(root, path), { force: true });

  return root;
}

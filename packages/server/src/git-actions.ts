import type { GitAction, GitStatus } from "@pios/protocol";
import {
  checkRef,
  checkStash,
  git,
  gitStatus,
  GitError,
  invalidateGitCache,
  listRemotes,
  readOperation,
  repoPaths,
  repoRoot,
} from "./git.ts";

/**
 * Git operations that change a session's repository.
 *
 * Remote work is kept apart from local work because only it can block on
 * credentials, so it runs non-interactively and with a much longer deadline.
 * Every path and ref is checked before it reaches git's argv.
 */

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

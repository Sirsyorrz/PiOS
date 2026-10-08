import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitBranches,
  gitDiff,
  gitLog,
  gitStashes,
  gitStatus,
  invalidateGitCache,
  parsePorcelainV2,
} from "../src/git.ts";
import { gitAction, parseGitAction } from "../src/git-actions.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pios-git-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "--quiet", "--initial-branch", "main");
  run("config", "user.email", "test@example.invalid");
  run("config", "user.name", "Test");
  run("commit", "--quiet", "--allow-empty", "-m", "root");
  invalidateGitCache(dir);
  return dir;
}

test("a directory without a repository has no status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-nogit-"));
  assert.equal(await gitStatus(dir), null);
  assert.equal(await gitDiff(dir), null);
  assert.equal(await gitLog(dir), null);
  rmSync(dir, { recursive: true, force: true });
});

test("status reports branch, staged, unstaged and untracked separately", async () => {
  const dir = repo();
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
  execFileSync("git", ["commit", "--quiet", "-m", "add"], { cwd: dir });

  writeFileSync(join(dir, "tracked.txt"), "two\n");
  writeFileSync(join(dir, "staged.txt"), "new\n");
  execFileSync("git", ["add", "staged.txt"], { cwd: dir });
  writeFileSync(join(dir, "loose.txt"), "loose\n");

  const status = (await gitStatus(dir, { fresh: true }))!;
  assert.equal(status.branch, "main");
  assert.equal(status.root, realpathSync(dir));
  assert.equal(status.prefix, "");
  assert.equal(status.staged, 1);
  assert.equal(status.unstaged, 1);
  assert.equal(status.untracked, 1);
  assert.equal(status.upstream, null);
  assert.equal(status.truncated, false);
  assert.deepEqual(
    status.files.map((f) => f.path).sort(),
    ["loose.txt", "staged.txt", "tracked.txt"],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("status from a subdirectory reports the repository root and prefix", async () => {
  const dir = repo();
  mkdirSync(join(dir, "sub", "deep"), { recursive: true });
  const status = (await gitStatus(join(dir, "sub", "deep"), { fresh: true }))!;
  assert.equal(status.prefix, join("sub", "deep"));
  rmSync(dir, { recursive: true, force: true });
});

test("a filename containing a newline survives parsing", () => {
  // Porcelain v2 -z separates on NUL precisely so this stays one file.
  const path = "we\nird.txt";
  const status = parsePorcelainV2(`# branch.head main\0? ${path}\0`);
  assert.equal(status.untracked, 1);
  assert.equal(status.files[0]!.path, path);
});

test("a rename consumes its source record without inventing a file", () => {
  const status = parsePorcelainV2(
    "# branch.head main\0" +
      "2 R. N... 100644 100644 100644 aaaa bbbb R100 new.txt\0old.txt\0" +
      "? other.txt\0",
  );
  assert.equal(status.files.length, 2);
  assert.equal(status.files[0]!.path, "new.txt");
  assert.equal(status.files[0]!.from, "old.txt");
  assert.equal(status.files[1]!.path, "other.txt");
});

test("ahead and behind are read from the branch header", () => {
  const status = parsePorcelainV2(
    "# branch.oid 0123456789abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +3 -2\0",
  );
  assert.equal(status.head, "01234567");
  assert.deepEqual(status.upstream, { name: "origin/main", ahead: 3, behind: 2 });
});

test("a detached head has no branch", () => {
  const status = parsePorcelainV2("# branch.oid abcdef1234\0# branch.head (detached)\0");
  assert.equal(status.branch, null);
});

test("stage, commit and unstage move files between the two sides", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.txt"), "hello\n");

  let status = (await gitAction(dir, { type: "stage", paths: ["a.txt"] }))!.status!;
  assert.equal(status.staged, 1);
  assert.equal(status.untracked, 0);

  status = (await gitAction(dir, { type: "unstage", paths: ["a.txt"] }))!.status!;
  assert.equal(status.staged, 0);
  assert.equal(status.untracked, 1);

  await gitAction(dir, { type: "stage_all" });
  status = (await gitAction(dir, { type: "commit", message: "add a" }))!.status!;
  assert.equal(status.staged, 0);
  assert.equal(status.untracked, 0);

  const log = (await gitLog(dir, { limit: 5 }))!;
  assert.equal(log[0]!.subject, "add a");
  rmSync(dir, { recursive: true, force: true });
});

test("discard stashes rather than destroying the change", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.txt"), "one\n");
  await gitAction(dir, { type: "stage_all" });
  await gitAction(dir, { type: "commit", message: "add a" });

  writeFileSync(join(dir, "a.txt"), "two\n");
  let status = (await gitAction(dir, { type: "discard", paths: ["a.txt"] }))!.status!;
  assert.equal(status.unstaged, 0);
  assert.equal(status.stashes, 1);

  // Recoverable: the point of stashing instead of checking out.
  status = (await gitAction(dir, { type: "stash_pop" }))!.status!;
  assert.equal(status.unstaged, 1);
  assert.equal(status.stashes, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("a path outside the repository is refused", async () => {
  const dir = repo();
  await assert.rejects(() => gitAction(dir, { type: "stage", paths: ["../escape.txt"] }));
  await assert.rejects(() => gitDiff(dir, { path: "/etc/passwd" }));
  rmSync(dir, { recursive: true, force: true });
});

test("an untracked file diffs against nothing instead of showing no change", async () => {
  const dir = repo();
  writeFileSync(join(dir, "fresh.txt"), "line\n");
  const result = (await gitDiff(dir, { path: "fresh.txt" }))!;
  assert.equal(result.untracked, true);
  assert.match(result.diff, /\+line/);
  rmSync(dir, { recursive: true, force: true });
});

test("an untracked directory shows the files inside it, not nothing", async () => {
  const dir = repo();
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "out", "one.txt"), "first\n");
  writeFileSync(join(dir, "out", "two.txt"), "second\n");

  // Status collapses the directory to one entry, so that is what gets tapped.
  const status = (await gitStatus(dir, { fresh: true }))!;
  assert.deepEqual(status.files.map((f) => f.path), ["out/"]);

  const result = (await gitDiff(dir, { path: "out/" }))!;
  assert.equal(result.untracked, true);
  assert.match(result.diff, /\+first/);
  assert.match(result.diff, /\+second/);
  rmSync(dir, { recursive: true, force: true });
});

test("only known actions are accepted from a client", () => {
  assert.deepEqual(parseGitAction({ type: "stash" }), { type: "stash", message: undefined });
  assert.deepEqual(parseGitAction({ type: "stage", paths: ["a"] }), { type: "stage", paths: ["a"] });
  assert.equal(parseGitAction({ type: "stage", paths: [] }), null);
  assert.equal(parseGitAction({ type: "commit" }), null);
  assert.deepEqual(parseGitAction({ type: "pull", rebase: true }), { type: "pull", rebase: true });
  assert.deepEqual(parseGitAction({ type: "push", setUpstream: true }), {
    type: "push",
    remote: undefined,
    force: false,
    setUpstream: true,
  });
  // A branch operation without a branch names nothing to operate on.
  assert.equal(parseGitAction({ type: "checkout" }), null);
  assert.equal(parseGitAction({ type: "delete_branch" }), null);
  assert.equal(parseGitAction({ type: "reset", paths: ["a"] }), null);
  assert.equal(parseGitAction(null), null);
});

test("the git routes are authenticated and scoped to a known session", async () => {
  const { startHarness } = await import("./helpers.ts");
  const harness = await startHarness();
  const bearer = { authorization: `Bearer ${harness.deviceToken}` };

  const anonymous = await fetch(`${harness.baseUrl}/git/status?session=nope`);
  assert.equal(anonymous.status, 401);

  // An unknown session, not a path error: the daemon never resolves a cwd it
  // was not given by the registry.
  const unknown = await fetch(`${harness.baseUrl}/git/status?session=nope`, { headers: bearer });
  assert.equal(unknown.status, 404);

  const rejected = await fetch(`${harness.baseUrl}/git/action?session=nope`, {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({ type: "push" }),
  });
  assert.equal(rejected.status, 404);

  // A directory outside what the picker can reach is refused, whether or not
  // it happens to hold a repository.
  const escaped = await fetch(
    `${harness.baseUrl}/git/status?cwd=${encodeURIComponent("/etc/../etc")}`,
    { headers: bearer },
  );
  assert.equal(escaped.status, 404);

  await harness.close();
});

test("a draft addresses git by directory, with no session to name", async () => {
  const { startHarness } = await import("./helpers.ts");
  const harness = await startHarness();
  const bearer = { authorization: `Bearer ${harness.deviceToken}` };
  // Only what the directory picker can reach is addressable, and it is rooted
  // at home, so the test repository has to live there.
  const dir = mkdtempSync(join(homedir(), ".pios-draft-git-"));

  try {
    const cwd = encodeURIComponent(dir);
    const read = async (response: Response) =>
      (await response.json()) as { status: { root: string } | null };

    const before = await fetch(`${harness.baseUrl}/git/status?cwd=${cwd}`, { headers: bearer });
    assert.equal(before.status, 200);
    // Not an error: a directory with no repository is a normal answer.
    assert.equal((await read(before)).status, null);

    const init = await fetch(`${harness.baseUrl}/git/action?cwd=${cwd}`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ type: "init" }),
    });
    assert.equal(init.status, 200);
    assert.ok((await read(init)).status);

    const after = await fetch(`${harness.baseUrl}/git/status?cwd=${cwd}&fresh=1`, {
      headers: bearer,
    });
    assert.ok((await read(after)).status);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await harness.close();
  }
});

test("init makes a repository where there was none, and is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-init-"));
  try {
    assert.equal(await gitStatus(dir), null);

    const result = (await gitAction(dir, { type: "init" }))!;
    assert.ok(result.status, "init reports the fresh status");
    assert.equal(result.status!.root, realpathSync(dir));

    // Re-running on a repository is git's own no-op, not an error.
    assert.ok((await gitAction(dir, { type: "init" }))?.status);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("branches report their upstream, divergence and which one is checked out", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.txt"), "one\n");
  await gitAction(dir, { type: "stage_all" });
  await gitAction(dir, { type: "commit", message: "add a" });

  await gitAction(dir, { type: "checkout", branch: "feature", create: true });
  writeFileSync(join(dir, "b.txt"), "two\n");
  await gitAction(dir, { type: "stage_all" });
  await gitAction(dir, { type: "commit", message: "add b" });

  const branches = (await gitBranches(dir))!;
  assert.equal(branches.current, "feature");
  assert.equal(branches.detached, false);
  assert.deepEqual(
    branches.local.map((b) => b.name).sort(),
    ["feature", "main"],
  );
  assert.equal(branches.local.find((b) => b.name === "feature")!.current, true);

  // A merge of the branch just left brings its commit back to main.
  await gitAction(dir, { type: "checkout", branch: "main" });
  const merged = (await gitAction(dir, { type: "merge", branch: "feature" }))!.status!;
  assert.equal(merged.branch, "main");
  assert.equal((await gitLog(dir, { limit: 1 }))![0]!.subject, "add b");

  const deleted = (await gitAction(dir, { type: "delete_branch", branch: "feature" }))!;
  assert.equal(deleted.status!.branch, "main");
  assert.deepEqual((await gitBranches(dir))!.local.map((b) => b.name), ["main"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a ref name that could be read as an option is refused", async () => {
  const dir = repo();
  await assert.rejects(() => gitAction(dir, { type: "checkout", branch: "--upload-pack=evil" }));
  await assert.rejects(() => gitAction(dir, { type: "merge", branch: "a b" }));
  await assert.rejects(() => gitAction(dir, { type: "stash_drop", ref: "stash@{x}" }));
  await assert.rejects(() => gitDiff(dir, { commit: "-x" }));
  rmSync(dir, { recursive: true, force: true });
});

test("a commit's diff is read from the commit, not from the working tree", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.txt"), "one\n");
  await gitAction(dir, { type: "stage_all" });
  await gitAction(dir, { type: "commit", message: "add a" });
  writeFileSync(join(dir, "a.txt"), "uncommitted\n");

  const sha = (await gitLog(dir, { limit: 1 }))![0]!.sha;
  const result = (await gitDiff(dir, { commit: sha }))!;
  assert.match(result.diff, /\+one/);
  assert.doesNotMatch(result.diff, /uncommitted/);
  rmSync(dir, { recursive: true, force: true });
});

test("named stashes are listed, applied and dropped", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.txt"), "one\n");
  await gitAction(dir, { type: "stash", message: "work in progress" });

  const stashes = (await gitStashes(dir))!;
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0]!.ref, "stash@{0}");
  assert.match(stashes[0]!.message, /work in progress/);

  const applied = (await gitAction(dir, { type: "stash_apply", ref: "stash@{0}" }))!.status!;
  assert.equal(applied.untracked, 1);
  // Apply keeps the entry; drop is what removes it.
  assert.equal(applied.stashes, 1);
  const dropped = (await gitAction(dir, { type: "stash_drop", ref: "stash@{0}" }))!.status!;
  assert.equal(dropped.stashes, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("push publishes a branch to a remote and pull brings a commit back", async () => {
  const origin = mkdtempSync(join(tmpdir(), "pios-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch", "main", origin]);

  const dir = repo();
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "one\n");
  await gitAction(dir, { type: "stage_all" });
  await gitAction(dir, { type: "commit", message: "add a" });

  const published = (await gitAction(dir, { type: "push", setUpstream: true }))!;
  assert.equal(published.status!.upstream?.name, "origin/main");
  assert.equal(published.status!.upstream?.ahead, 0);

  // A second clone commits, so the first has something real to pull.
  const other = mkdtempSync(join(tmpdir(), "pios-clone-"));
  execFileSync("git", ["clone", "--quiet", origin, other]);
  execFileSync("git", ["config", "user.email", "other@example.invalid"], { cwd: other });
  execFileSync("git", ["config", "user.name", "Other"], { cwd: other });
  writeFileSync(join(other, "b.txt"), "two\n");
  execFileSync("git", ["add", "-A"], { cwd: other });
  execFileSync("git", ["commit", "--quiet", "-m", "add b"], { cwd: other });
  execFileSync("git", ["push", "--quiet"], { cwd: other });

  const fetched = (await gitAction(dir, { type: "fetch" }))!.status!;
  assert.equal(fetched.upstream?.behind, 1);

  const pulled = (await gitAction(dir, { type: "pull" }))!.status!;
  assert.equal(pulled.upstream?.behind, 0);
  assert.equal((await gitLog(dir, { limit: 1 }))![0]!.subject, "add b");

  const branches = (await gitBranches(dir))!;
  assert.deepEqual(branches.remotes, ["origin"]);
  assert.ok(branches.remote.some((b) => b.name === "origin/main"));

  for (const path of [dir, origin, other]) rmSync(path, { recursive: true, force: true });
});

test("an in-progress merge is reported so the UI can say why git refuses", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.txt"), "base\n");
  await gitAction(dir, { type: "stage_all" });
  await gitAction(dir, { type: "commit", message: "base" });

  await gitAction(dir, { type: "checkout", branch: "other", create: true });
  writeFileSync(join(dir, "a.txt"), "theirs\n");
  await gitAction(dir, { type: "stage_all" });
  await gitAction(dir, { type: "commit", message: "theirs" });

  await gitAction(dir, { type: "checkout", branch: "main" });
  writeFileSync(join(dir, "a.txt"), "ours\n");
  await gitAction(dir, { type: "stage_all" });
  await gitAction(dir, { type: "commit", message: "ours" });

  await assert.rejects(() => gitAction(dir, { type: "merge", branch: "other" }));
  invalidateGitCache(dir);
  const status = (await gitStatus(dir, { fresh: true }))!;
  assert.equal(status.operation, "merge");
  assert.equal(status.conflicted, 1);

  // Resolving and continuing is the same two steps the UI offers.
  writeFileSync(join(dir, "a.txt"), "resolved\n");
  await gitAction(dir, { type: "stage_all" });
  const done = (await gitAction(dir, { type: "continue" }))!.status!;
  assert.equal(done.operation, null);
  assert.equal(done.conflicted, 0);
  await assert.rejects(() => gitAction(dir, { type: "continue" }), /nothing in progress/);
  rmSync(dir, { recursive: true, force: true });
});

test("aborting a conflicted merge puts the tree back", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.txt"), "base\n");
  await gitAction(dir, { type: "stage_all" });
  await gitAction(dir, { type: "commit", message: "base" });

  await gitAction(dir, { type: "checkout", branch: "other", create: true });
  writeFileSync(join(dir, "a.txt"), "theirs\n");
  await gitAction(dir, { type: "stage_all" });
  await gitAction(dir, { type: "commit", message: "theirs" });

  await gitAction(dir, { type: "checkout", branch: "main" });
  writeFileSync(join(dir, "a.txt"), "ours\n");
  await gitAction(dir, { type: "stage_all" });
  await gitAction(dir, { type: "commit", message: "ours" });
  await assert.rejects(() => gitAction(dir, { type: "merge", branch: "other" }));

  const aborted = (await gitAction(dir, { type: "abort" }))!.status!;
  assert.equal(aborted.operation, null);
  assert.equal(aborted.conflicted, 0);
  assert.equal((await gitLog(dir, { limit: 1 }))![0]!.subject, "ours");
  rmSync(dir, { recursive: true, force: true });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitAction,
  gitDiff,
  gitLog,
  gitStatus,
  invalidateGitCache,
  parseGitAction,
  parsePorcelainV2,
} from "../src/git.ts";

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

  let status = (await gitAction(dir, { type: "stage", paths: ["a.txt"] }))!;
  assert.equal(status.staged, 1);
  assert.equal(status.untracked, 0);

  status = (await gitAction(dir, { type: "unstage", paths: ["a.txt"] }))!;
  assert.equal(status.staged, 0);
  assert.equal(status.untracked, 1);

  await gitAction(dir, { type: "stage_all" });
  status = (await gitAction(dir, { type: "commit", message: "add a" }))!;
  assert.equal(status.staged, 0);
  assert.equal(status.untracked, 0);

  const log = (await gitLog(dir, 5))!;
  assert.equal(log[0]!.subject, "add a");
  rmSync(dir, { recursive: true, force: true });
});

test("discard stashes rather than destroying the change", async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.txt"), "one\n");
  await gitAction(dir, { type: "stage_all" });
  await gitAction(dir, { type: "commit", message: "add a" });

  writeFileSync(join(dir, "a.txt"), "two\n");
  let status = (await gitAction(dir, { type: "discard", paths: ["a.txt"] }))!;
  assert.equal(status.unstaged, 0);

  // Recoverable: the point of stashing instead of checking out.
  status = (await gitAction(dir, { type: "stash_pop" }))!;
  assert.equal(status.unstaged, 1);
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

test("only known actions are accepted from a client", () => {
  assert.deepEqual(parseGitAction({ type: "stash" }), { type: "stash" });
  assert.deepEqual(parseGitAction({ type: "stage", paths: ["a"] }), { type: "stage", paths: ["a"] });
  assert.equal(parseGitAction({ type: "stage", paths: [] }), null);
  assert.equal(parseGitAction({ type: "commit" }), null);
  // No remote features: these must not be reachable at all.
  assert.equal(parseGitAction({ type: "push" }), null);
  assert.equal(parseGitAction({ type: "pull" }), null);
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

  await harness.close();
});

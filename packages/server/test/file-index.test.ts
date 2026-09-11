import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fuzzyScore, invalidateFileIndex, searchFiles } from "../src/file-index.ts";

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pios-files-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  invalidateFileIndex(dir);
  return dir;
}

test("a subsequence matches and a missing character does not", () => {
  assert.notEqual(fuzzyScore("apps/web/src/composer.tsx", "webcomp"), null);
  assert.equal(fuzzyScore("apps/web/src/composer.tsx", "zzz"), null);
});

test("a basename hit outranks a path-only hit", () => {
  const direct = fuzzyScore("src/composer.tsx", "composer")!;
  const indirect = fuzzyScore("composer/src/other-file.ts", "composer")!;
  assert.ok(direct > indirect, `${direct} !> ${indirect}`);
});

test("search walks a plain directory and skips noise", async () => {
  const dir = tree({
    "src/composer.tsx": "",
    "src/deep/notes.md": "",
    "node_modules/pkg/index.js": "",
    ".hidden/secret": "",
  });
  const paths = (await searchFiles(dir, "")).map((match) => match.path);
  assert.deepEqual(paths.sort(), ["src/composer.tsx", "src/deep/notes.md"]);
  rmSync(dir, { recursive: true, force: true });
});

test("search ranks the intended file first and honours the limit", async () => {
  const dir = tree({
    "src/composer.tsx": "",
    "src/compose-helpers.ts": "",
    "docs/composition.md": "",
  });
  const matches = await searchFiles(dir, "composer", 2);
  assert.equal(matches[0]!.path, "src/composer.tsx");
  assert.ok(matches.length <= 2);
  rmSync(dir, { recursive: true, force: true });
});

test("a repository listing respects gitignore", async () => {
  const dir = tree({ "kept.ts": "", "ignored.log": "", ".gitignore": "*.log\n" });
  execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
  invalidateFileIndex(dir);

  const paths = (await searchFiles(dir, "")).map((match) => match.path);
  assert.ok(paths.includes("kept.ts"));
  assert.ok(!paths.includes("ignored.log"));
  rmSync(dir, { recursive: true, force: true });
});

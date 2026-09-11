import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_EDIT_BYTES, readTextFile, writeTextFile } from "../src/file-edit.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pios-file-edit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test("reads text with an etag and refuses what it cannot edit", async () => {
  const file = await readTextFile(write("a.ts", "export const x = 1;\n"));
  assert.equal(file?.editable, true);
  assert.equal(file?.text, "export const x = 1;\n");
  assert.match(file!.etag, /^"[0-9a-f]{64}"$/);

  assert.equal(await readTextFile(join(dir, "missing")), null);
  assert.equal((await readTextFile(write("bin", Buffer.from([1, 0, 2]))))?.reason, "binary");
  assert.equal((await readTextFile(write("bad", Buffer.from([0xff, 0xfe]))))?.reason, "binary");
  assert.equal((await readTextFile(write("min.js", "x".repeat(60_000))))?.reason, "long_lines");

  const big = await readTextFile(write("big.txt", "y".repeat(MAX_EDIT_BYTES + 1)));
  assert.equal(big?.reason, "too_large");
  // Over the cap is a head preview, not a blank error.
  assert.ok(big!.text.length > 0 && big!.text.length < MAX_EDIT_BYTES);
});

test("saves only against the etag it was given", async () => {
  const path = write("a.txt", "one\n");
  const etag = (await readTextFile(path))!.etag;

  const stale = await writeTextFile(path, "mine\n", { ifMatch: '"nope"', trailingNewline: true });
  assert.deepEqual({ ok: stale.ok, error: "error" in stale ? stale.error : null }, {
    ok: false,
    error: "conflict",
  });

  const ok = await writeTextFile(path, "two\n", { ifMatch: etag, trailingNewline: true });
  assert.equal(ok.ok, true);
  assert.equal(await readFile(path, "utf8"), "two\n");
});

test("creates a new file but never clobbers an existing one", async () => {
  const created = await writeTextFile(join(dir, "new.txt"), "hi\n", { trailingNewline: true });
  assert.equal(created.ok, true);

  const again = await writeTextFile(join(dir, "new.txt"), "other\n", { trailingNewline: true });
  assert.equal(again.ok, false);
  assert.equal("error" in again ? again.error : null, "exists");
});

test("round-trips CRLF and a missing trailing newline", async () => {
  const path = write("crlf.txt", "a\r\nb\r\nc");
  const file = (await readTextFile(path))!;
  assert.equal(file.eol, "crlf");
  assert.equal(file.trailingNewline, false);
  assert.equal(file.text, "a\nb\nc");

  const saved = await writeTextFile(path, file.text.replace("b", "B"), {
    ifMatch: file.etag,
    eol: file.eol,
    trailingNewline: file.trailingNewline,
  });
  assert.equal(saved.ok, true);
  assert.equal(await readFile(path, "utf8"), "a\r\nB\r\nc");
});

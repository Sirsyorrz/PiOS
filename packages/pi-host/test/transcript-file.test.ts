import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forgetTranscript, readTranscript, sliceEntries } from "../src/transcript-file.ts";

function seed(dir: string, turns: number): { file: string; manager: SessionManager } {
  const cwd = join(dir, "project");
  const manager = SessionManager.create(cwd, join(dir, "sessions", "--project--"));
  for (let i = 0; i < turns; i++) {
    manager.appendMessage({ role: "user", content: `turn ${i}`, timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `reply ${i}` }],
      timestamp: Date.now(),
      api: "anthropic-messages",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 },
      stopReason: "stop",
    } as never);
  }
  return { file: manager.getSessionFile()!, manager };
}

test("a transcript is read from the file, with no agent running", () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-transcript-"));
  try {
    const { file, manager } = seed(dir, 3);
    forgetTranscript();

    const transcript = readTranscript(file);
    assert.ok(transcript);
    assert.equal(transcript.entries.length, 6);
    assert.equal(transcript.leafId, manager.getLeafId());
    assert.equal(transcript.cwd, join(dir, "project"));

    assert.equal(readTranscript(join(dir, "nope.jsonl")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that grew is re-read rather than served from the cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-transcript-"));
  try {
    const { file, manager } = seed(dir, 1);
    forgetTranscript();
    assert.equal(readTranscript(file)?.entries.length, 2);

    manager.appendMessage({ role: "user", content: "and another", timestamp: Date.now() });
    const after = readTranscript(file);
    assert.equal(after?.entries.length, 3);
    assert.equal(after?.leafId, manager.getLeafId());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tail is paged backwards, and a delta is taken by entry id", () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-transcript-"));
  try {
    const { file } = seed(dir, 5);
    forgetTranscript();
    const { entries, leafId } = readTranscript(file)!;
    assert.equal(entries.length, 10);

    const tail = sliceEntries(entries, leafId, { limit: 4 });
    assert.deepEqual(
      tail.entries.map((entry) => entry.id),
      entries.slice(6).map((entry) => entry.id),
    );
    assert.equal(tail.offset, 6);
    assert.equal(tail.total, 10);

    const older = sliceEntries(entries, leafId, { limit: 4, before: tail.offset });
    assert.equal(older.offset, 2);
    assert.equal(older.entries.at(-1)?.id, entries[5]?.id);

    const delta = sliceEntries(entries, leafId, { since: entries[7]!.id });
    assert.equal(delta.entries.length, 2);
    assert.equal(delta.reset, false);

    const unknown = sliceEntries(entries, leafId, { since: "not-an-entry" });
    assert.equal(unknown.reset, true);
    assert.equal(unknown.entries.length, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

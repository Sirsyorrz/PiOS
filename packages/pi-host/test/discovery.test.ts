import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSessionLister } from "../src/discovery.ts";
import { SessionIndex } from "../src/session-index.ts";

/**
 * pi stores sessions one directory per project under the root, and its own
 * `sessionDir` argument names the project directory, not the root. Listing the
 * root directly finds nothing, which is the bug this pins.
 */
function seed(root: string, cwd: string, text: string): void {
  const safe = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
  const manager = SessionManager.create(cwd, join(root, safe));
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  // pi holds the file back until a turn produces an assistant message, so a
  // user prompt alone leaves nothing on disk to find.
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    timestamp: Date.now(),
    api: "anthropic-messages",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 },
    stopReason: "stop",
  } as never);
}

test("sessions are found under a session root, not just a project directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-discovery-"));
  try {
    const root = join(dir, "sessions");
    seed(root, join(dir, "alpha"), "from the TUI");
    seed(root, join(dir, "beta"), "another project");

    const lister = createSessionLister({ sessionDir: root });

    const all = await lister({});
    assert.equal(all.length, 2);
    assert.ok(all.every((session) => session.path.endsWith(".jsonl")));

    const alpha = await lister({ cwd: join(dir, "alpha") });
    assert.equal(alpha.length, 1);
    assert.equal(alpha[0]?.preview, "from the TUI");
    assert.equal(alpha[0]?.cwd, join(dir, "alpha"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the index pages, filters, and seeds itself across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-index-"));
  try {
    const root = join(dir, "sessions");
    seed(root, join(dir, "alpha"), "needle in here");
    seed(root, join(dir, "beta"), "something else");
    const cacheFile = join(dir, "session-index.json");

    const index = new SessionIndex({ sessionDir: root, cacheFile });
    const first = await index.list({ limit: 1 });
    assert.equal(first.sessions.length, 1);
    assert.equal(first.total, 2);
    assert.equal(first.hasMore, true);

    const second = await index.list({ limit: 1, offset: 1 });
    assert.equal(second.hasMore, false);
    assert.notEqual(second.sessions[0]?.id, first.sessions[0]?.id);

    const hit = await index.list({ query: "NEEDLE" });
    assert.equal(hit.sessions.length, 1);
    assert.equal(hit.sessions[0]?.preview, "needle in here");
    assert.equal(index.fileFor(hit.sessions[0]!.id), hit.sessions[0]!.path);

    // A fresh index must answer from the seed file alone, without a rescan.
    await new Promise((done) => setTimeout(done, 50));
    const restarted = new SessionIndex({ sessionDir: join(dir, "gone"), cacheFile });
    assert.equal(restarted.fileFor(hit.sessions[0]!.id), undefined);
    await restarted.list({});
    assert.equal(restarted.fileFor(hit.sessions[0]!.id), hit.sessions[0]!.path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

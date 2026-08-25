import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSessionLister } from "../src/discovery.ts";

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

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionDirName } from "@pios/pi-host";
import { startHarness, hello, type Harness } from "./helpers.ts";

/**
 * A session created outside PiOS, i.e. by the pi TUI.
 *
 * The daemon has never run it, so everything here is answered from the file on
 * disk: it is listed, and its transcript is readable, without any process
 * being started for it.
 */
let harness: Harness;
let sessionId: string;
let cwd: string;

before(async () => {
  harness = await startHarness();
  cwd = join(harness.dir, "tui-project");
  mkdirSync(cwd, { recursive: true });
  const manager = SessionManager.create(
    cwd,
    join(harness.dir, "sessions", sessionDirName(cwd)),
  );
  manager.appendMessage({ role: "user", content: "from the TUI", timestamp: Date.now() });
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
  sessionId = manager.getSessionId();
});
after(async () => {
  await harness.close();
});

test("a session started in the pi TUI is listed cold and read from its file", async () => {
  const client = await hello(harness);

  const listed = await client.waitForCommand(client.send({ type: "list_sessions" }));
  assert.ok(listed.type === "sessions", JSON.stringify(listed));
  const row = listed.sessions.find((session) => session.sessionId === sessionId);
  assert.ok(row, "the TUI session is in the list");
  assert.equal(row.status, "cold", "no process, and none needed to list it");
  assert.equal(row.cwd, cwd);
  assert.equal(row.preview, "from the TUI");

  // Reading a session must not start one: the transcript is on disk.
  const entries = await client.waitForCommand(
    client.send({ type: "get_entries", sessionId }),
  );
  assert.ok(entries.type === "entries");
  assert.equal(entries.entries.length, 2);
  assert.equal(harness.server.registry.get(sessionId), undefined);

  client.close();
});

test("the list is searched and paged on the daemon", async () => {
  const client = await hello(harness);

  const hit = await client.waitForCommand(
    client.send({ type: "list_sessions", query: "from the tui" }),
  );
  assert.ok(hit.type === "sessions");
  assert.deepEqual(
    hit.sessions.map((session) => session.sessionId),
    [sessionId],
  );

  const miss = await client.waitForCommand(
    client.send({ type: "list_sessions", query: "nothing matches this" }),
  );
  assert.ok(miss.type === "sessions");
  assert.equal(miss.sessions.length, 0);

  client.close();
});

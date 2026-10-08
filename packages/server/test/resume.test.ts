import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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

test("a cold session woken by one device streams to another already watching it", async () => {
  const watcher = await hello(harness);
  const sender = await hello(harness);

  await watcher.waitForCommand(watcher.send({ type: "subscribe", sessionId }));
  assert.equal(harness.server.registry.get(sessionId), undefined, "subscribing does not wake it");
  const cold = await watcher.waitFor((f) => f.type === "session_state" && f.sessionId === sessionId);
  assert.ok(cold.type === "session_state");
  assert.equal(cold.summary.status, "cold", "it is described even though no list page held it");

  const prompt = sender.send({
    type: "prompt",
    sessionId,
    messageId: "wake-1",
    text: "wake up",
    images: [],
  });
  await sender.waitForCommand(prompt);

  const state = await watcher.waitFor(
    (f) => f.type === "session_state" && f.sessionId === sessionId && f.summary.status !== "cold",
  );
  assert.ok(state.type === "session_state");
  await watcher.waitFor((f) => f.type === "agent_event" && f.event.type === "agent_settled");

  watcher.close();
  sender.close();
});

test("a cold session's files are served without starting pi for it", async () => {
  const fresh = await startHarness();
  try {
    const project = join(fresh.dir, "cold-files");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "shot.png"), "png bytes");
    const manager = SessionManager.create(project, join(fresh.dir, "sessions", sessionDirName(project)));
    manager.appendMessage({ role: "user", content: "look", timestamp: Date.now() });
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
    const id = manager.getSessionId();
    const bearer = { authorization: `Bearer ${fresh.deviceToken}` };

    const image = await fetch(`${fresh.baseUrl}/file?session=${id}&path=shot.png`, { headers: bearer });
    assert.equal(image.status, 200);
    assert.equal(await image.text(), "png bytes");
    const search = await fetch(`${fresh.baseUrl}/files?session=${id}&q=shot`, { headers: bearer });
    assert.deepEqual(((await search.json()) as { files: string[] }).files, ["shot.png"]);
    assert.equal(fresh.server.registry.get(id), undefined, "nothing was woken");

    const unknown = await fetch(`${fresh.baseUrl}/file?session=nope&path=shot.png`, { headers: bearer });
    assert.equal(unknown.status, 404);
  } finally {
    await fresh.close();
  }
});

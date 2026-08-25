import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResumableSession } from "@pios/pi-host";
import { startHarness, hello, type Harness } from "./helpers.ts";

/**
 * A session created outside PiOS, i.e. by the pi TUI. The daemon has never
 * seen it, so it exists only as a file the lister reports.
 */
let harness: Harness;
let external: ResumableSession;

before(async () => {
  harness = await startHarness(async () => [external]);
  const cwd = join(harness.dir, "tui-project");
  mkdirSync(cwd, { recursive: true });
  const path = join(harness.dir, "sessions", "from-tui.json");
  mkdirSync(join(harness.dir, "sessions"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify([
      { id: "e1", parentId: null, type: "message", message: { role: "user", content: "from tui" } },
    ]),
  );
  external = {
    path,
    id: "from-tui",
    cwd,
    createdAt: 1,
    modifiedAt: 2,
    messageCount: 1,
    preview: "from tui",
  };
});
after(async () => {
  await harness.close();
});

test("sessions started in the pi TUI are listed and resumable", async () => {
  const client = await hello(harness);

  const listId = client.send({ type: "list_resumable" });
  const listed = await client.waitForCommand(listId);
  assert.equal(listed.type, "resumable_sessions");
  assert.ok(listed.type === "resumable_sessions");
  assert.equal(listed.sessions[0]?.path, external.path);
  assert.equal(listed.sessions[0]?.live, false);

  const createId = client.send({
    type: "create_session",
    cwd: external.cwd,
    trustProject: false,
    resumeFrom: external.path,
  });
  const created = await client.waitForCommand(createId);
  assert.ok(created.type === "session_state", JSON.stringify(created));

  // The transcript came from the file, not from an empty session.
  const entriesId = client.send({ type: "get_entries", sessionId: created.sessionId });
  const entries = await client.waitForCommand(entriesId);
  assert.ok(entries.type === "entries");
  assert.equal(entries.entries.length, 1);

  // Second resume of the same file attaches instead of opening a rival writer.
  const againId = client.send({
    type: "create_session",
    cwd: external.cwd,
    trustProject: false,
    resumeFrom: external.path,
  });
  const again = await client.waitForCommand(againId);
  assert.ok(again.type === "session_state");
  assert.equal(again.sessionId, created.sessionId);

  const relistId = client.send({ type: "list_resumable" });
  const relisted = await client.waitForCommand(relistId);
  assert.ok(relisted.type === "resumable_sessions");
  assert.equal(relisted.sessions[0]?.live, true);

  client.close();
});

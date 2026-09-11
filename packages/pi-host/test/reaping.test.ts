import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionRegistry, subprocessHost } from "../src/registry.ts";
import { SubprocessSession } from "../src/subprocess.ts";
import type { BufferedEvent, SessionStatus } from "../src/types.ts";

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((done) => setTimeout(done, 10));
  }
}

const FAKE_PI = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));

function host(dir: string) {
  return subprocessHost({
    command: process.execPath,
    argsPrefix: [FAKE_PI],
    sessionDir: dir,
    requestTimeoutMs: 10_000,
  });
}

function statuses(session: { subscribe(l: (e: BufferedEvent) => void): () => void }): SessionStatus[] {
  const seen: SessionStatus[] = [];
  session.subscribe((buffered) => {
    if (buffered.event.type === "status") seen.push(buffered.event.status);
  });
  return seen;
}

test("a sleeping session wakes on the next command, same id and transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-reap-"));
  const registry = new SessionRegistry(host(dir), { idleMs: 0 });
  try {
    const session = (await registry.create({ id: "s", cwd: dir })) as SubprocessSession;
    const seen = statuses(session);
    const recovered: string[] = [];
    session.subscribe((buffered) => {
      if (buffered.event.type === "session_recovered") recovered.push(buffered.event.reason);
    });

    await session.sleep();
    assert.equal(session.awake, false);
    assert.equal(session.info.status, "cold");

    // Nothing announces the wake but the command itself: asking for anything
    // is enough to bring the process back.
    const commands = await session.listCommands();
    assert.ok(Array.isArray(commands));
    assert.equal(session.awake, true);
    assert.equal(session.id, "s");
    assert.deepEqual(seen.slice(-3), ["cold", "starting", "idle"]);
    assert.deepEqual(recovered, ["session resumed"]);
  } finally {
    await registry.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the sweep reaps an idle session and leaves a working one alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-reap-"));
  // Real time, short idle: the activity clock lives on the session, so a fake
  // clock here would only be testing the registry against itself.
  const idleMs = 50;
  const registry = new SessionRegistry(host(dir), {
    idleMs,
    // No timer: the test drives the sweep, so it cannot race a real interval.
    sweepIntervalMs: 24 * 3600_000,
  });
  const goIdle = () => new Promise((done) => setTimeout(done, idleMs * 2));
  try {
    const idle = (await registry.create({ id: "idle", cwd: dir })) as SubprocessSession;
    const busy = (await registry.create({ id: "busy", cwd: dir })) as SubprocessSession;

    // SLOW_TOOL stops on a dialog, so this session is both mid-turn and
    // waiting on a human: the two states the sweep must never touch.
    await busy.prompt("SLOW_TOOL");
    await waitFor(() => busy.pendingDialogs.length > 0);
    assert.equal(busy.info.status, "running");

    await goIdle();
    await registry.sweep();

    assert.equal(idle.awake, false, "an idle session is reaped");
    assert.equal(busy.awake, true, "a session mid-turn on a dialog is never reaped");

    // Waking for a probe must not buy the process another idle window.
    await idle.listCommands();
    assert.equal(idle.awake, true);
    await goIdle();
    await registry.sweep();
    assert.equal(idle.awake, false, "a probe alone does not keep a process alive");
  } finally {
    await registry.disposeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

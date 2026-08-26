import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SubprocessSession } from "../src/subprocess.ts";
import type { BufferedEvent } from "../src/types.ts";

const FAKE_PI = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));

function start(dir: string, dialogTimeoutMs: number) {
  return SubprocessSession.start(
    { id: "dialog-1", cwd: dir },
    {
      command: process.execPath,
      argsPrefix: [FAKE_PI],
      sessionDir: dir,
      requestTimeoutMs: 10_000,
      dialogTimeoutMs,
    },
  );
}

function waitFor(
  session: { subscribe: (fn: (e: BufferedEvent) => void) => () => void },
  match: (event: BufferedEvent) => boolean,
): Promise<BufferedEvent> {
  return new Promise((resolve) => {
    const off = session.subscribe((event) => {
      if (!match(event)) return;
      off();
      resolve(event);
    });
  });
}

const settled = (e: BufferedEvent) =>
  e.event.type === "agent_event" && e.event.event.type === "agent_settled";

test("an unanswered dialog is cancelled instead of blocking the session forever", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-dialog-"));
  const session = await start(dir, 50);
  try {
    const done = waitFor(session, settled);
    await session.prompt("ASK_DIALOG");
    await done;

    const page = await session.getEntries();
    const last = JSON.stringify(page.entries.at(-1));
    assert.match(last, /cancelled.{0,4}:true/);
  } finally {
    await session.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an answered dialog is forwarded and cancels its deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-dialog-"));
  // Short enough that a leaked timer would overtake the real answer.
  const session = await start(dir, 100);
  try {
    const asked = waitFor(session, (e) => e.event.type === "extension_ui_request");
    const done = waitFor(session, settled);
    await session.prompt("ASK_DIALOG");
    const request = await asked;
    assert.equal(request.event.type, "extension_ui_request");
    const id = request.event.type === "extension_ui_request" ? request.event.request.id : "";
    session.answerDialog({ type: "extension_ui_response", id, confirmed: true });
    await done;

    const page = await session.getEntries();
    const last = JSON.stringify(page.entries.at(-1));
    assert.match(last, /confirmed.{0,4}:true/);
    assert.doesNotMatch(last, /cancelled/);
  } finally {
    await session.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

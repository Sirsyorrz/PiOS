import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex } from "@pios/pi-host";
import { ExternalTurnNotifier } from "../src/external-turns.ts";
import type { Notification } from "../src/notifier.ts";

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify({ timestamp: new Date().toISOString(), parentId: null, ...record })}\n`;
}

const user = (id: string, text: string) =>
  line({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } });
const answer = (id: string, text: string, stopReason = "stop", errorMessage?: string) =>
  line({
    type: "message",
    id,
    message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, errorMessage },
  });

function setup(live = new Set<string>()) {
  const dir = mkdtempSync(join(tmpdir(), "pios-external-"));
  const project = join(dir, "--work--");
  mkdirSync(project, { recursive: true });
  const file = join(project, "tui.jsonl");
  writeFileSync(file, line({ type: "session", version: 3, id: "tui", cwd: "/work/tui" }));
  const sent: Notification[] = [];
  const notifier = new ExternalTurnNotifier({
    index: new SessionIndex({ sessionDir: dir }),
    isLive: (id) => live.has(id),
    watchers: () => new Set(["watching-device"]),
    send: (notification) => {
      sent.push(notification);
    },
    quietMs: 5,
    failureQuietMs: 40,
  });
  const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
  return { dir, file, sent, notifier, settle, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a turn that ended in the TUI is pushed once, with what the agent said", async () => {
  const { file, sent, notifier, settle, close } = setup();
  try {
    appendFileSync(file, user("u1", "rename the module"));
    appendFileSync(file, answer("a1", "", "toolUse"));
    notifier.changed([file]);
    await settle();
    assert.equal(sent.length, 0, "a tool call is a turn still in progress");

    appendFileSync(file, answer("a2", "Renamed it to `core`."));
    notifier.changed([file]);
    notifier.changed([file]);
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.sessionId, "tui");
    assert.equal(sent[0]!.message.body, "Renamed it to core.");
    assert.equal(sent[0]!.message.title, "rename the module");
    assert.deepEqual([...sent[0]!.skipDeviceIds], ["watching-device"]);

    notifier.changed([file]);
    await settle();
    assert.equal(sent.length, 1, "the same answer is not announced twice");
  } finally {
    notifier.stop();
    close();
  }
});

test("a session this daemon runs is left to its own notifier", async () => {
  const { file, sent, notifier, settle, close } = setup(new Set(["tui"]));
  try {
    appendFileSync(file, user("u1", "hi"));
    appendFileSync(file, answer("a1", "hello"));
    notifier.changed([file]);
    await settle();
    assert.equal(sent.length, 0);
  } finally {
    notifier.stop();
    close();
  }
});

test("a failure waits out pi's retry before it is reported", async () => {
  const { file, sent, notifier, settle, close } = setup();
  try {
    appendFileSync(file, user("u1", "hi"));
    appendFileSync(file, answer("a1", "", "error", "429 rate limited"));
    notifier.changed([file]);
    await settle(15);
    assert.equal(sent.length, 0, "pi may still retry it");
    await settle(60);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.message.body, /^Failed: /);
  } finally {
    notifier.stop();
    close();
  }
});

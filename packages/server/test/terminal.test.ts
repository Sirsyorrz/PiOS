import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrame } from "@pios/protocol";
import { TerminalHost, type TerminalListener } from "../src/terminals.ts";
import { startHarness, hello, type Harness, type TestClient } from "./helpers.ts";

// A bare shell with a fixed prompt: the developer's rc files are not the subject.
const SHELL = { shell: "/bin/sh", args: [], env: { PS1: "$ ", ENV: "" } };

let harness: Harness;
let cwd: string;

before(async () => {
  harness = await startHarness(undefined, { terminals: SHELL });
  cwd = mkdtempSync(join(tmpdir(), "pios-term-"));
});
after(async () => {
  await harness.close();
  rmSync(cwd, { recursive: true, force: true });
});

type Output = Extract<ServerFrame, { type: "terminal_output" }>;
type Attached = Extract<ServerFrame, { type: "terminal_attached" }>;

function outputOf(client: TestClient, terminalId: string): string {
  return client.received
    .filter((f): f is Output => f.type === "terminal_output" && f.terminalId === terminalId)
    .map((f) => f.data)
    .join("");
}

function waitForText(client: TestClient, terminalId: string, text: string) {
  return client.waitFor(() => outputOf(client, terminalId).includes(text));
}

async function open(client: TestClient, terminalId: string, extra: Record<string, unknown> = {}) {
  const commandId = client.send({ type: "terminal_open", terminalId, cwd, cols: 80, rows: 24, ...extra } as never);
  return (await client.waitForCommand(commandId)) as Attached;
}

test("a shell runs in the requested directory and reports how it ended", async () => {
  const client = await hello(harness);
  const attached = await open(client, "t-basic");
  assert.equal(attached.type, "terminal_attached");
  assert.equal(attached.reset, true);

  client.send({ type: "terminal_input", terminalId: "t-basic", data: "pwd; echo done-$((1+2))\n" });
  await waitForText(client, "t-basic", "done-3");
  assert.ok(outputOf(client, "t-basic").includes(cwd));

  client.send({ type: "terminal_input", terminalId: "t-basic", data: "exit 7\n" });
  const exit = await client.waitFor((f) => f.type === "terminal_exit" && f.terminalId === "t-basic");
  assert.equal(exit.type === "terminal_exit" && exit.exitCode, 7);
  client.close();
});

test("a reconnect with a cursor gets only what it missed", async () => {
  const first = await hello(harness);
  const attached = await open(first, "t-resume");
  first.send({ type: "terminal_input", terminalId: "t-resume", data: "echo before\n" });
  await waitForText(first, "t-resume", "before");
  // Settle, so the cursor covers the prompt that follows the echo.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const held = outputOf(first, "t-resume");
  first.close();

  const second = await hello(harness);
  const watcher = await hello(harness);
  await open(watcher, "t-resume");
  watcher.send({ type: "terminal_input", terminalId: "t-resume", data: "echo after\n" });
  await waitForText(watcher, "t-resume", "after");

  const resumed = await open(second, "t-resume", {
    since: { instance: attached.instance, offset: attached.offset + held.length },
  });
  assert.equal(resumed.reset, false);
  await waitForText(second, "t-resume", "after");
  assert.ok(!outputOf(second, "t-resume").includes("before"), "nothing held is sent twice");

  // A cursor into another shell is no cursor at all.
  const stranger = await hello(harness);
  const fresh = await open(stranger, "t-resume", { since: { instance: "other", offset: 3 } });
  assert.equal(fresh.reset, true);
  await waitForText(stranger, "t-resume", "before");

  for (const client of [second, watcher, stranger]) client.close();
  harness.server.terminals.close("t-resume");
});

test("an exited shell stays exited until a restart is asked for", async () => {
  const client = await hello(harness);
  const first = await open(client, "t-restart");
  client.send({ type: "terminal_input", terminalId: "t-restart", data: "exit 2\n" });
  await client.waitFor((f) => f.type === "terminal_exit" && f.terminalId === "t-restart");

  const again = await hello(harness);
  const reattached = await open(again, "t-restart");
  assert.equal(reattached.instance, first.instance);
  await again.waitFor((f) => f.type === "terminal_exit" && f.terminalId === "t-restart");

  const restarted = await open(again, "t-restart", { restart: true });
  assert.notEqual(restarted.instance, first.instance);
  assert.equal(restarted.reset, true);
  again.send({ type: "terminal_input", terminalId: "t-restart", data: "echo alive\n" });
  await waitForText(again, "t-restart", "alive");

  const closeId = again.send({ type: "terminal_close", terminalId: "t-restart" });
  await again.waitForCommand(closeId);
  // The first exit was the old shell's, replayed on attach; this is the new one's.
  await again.waitFor(
    () =>
      again.received.filter((f) => f.type === "terminal_exit" && f.terminalId === "t-restart")
        .length >= 2,
  );
  client.close();
  again.close();
});

test("a directory that is not there is refused", async () => {
  const client = await hello(harness);
  const commandId = client.send({
    type: "terminal_open",
    terminalId: "t-missing",
    cwd: join(cwd, "nope"),
    cols: 80,
    rows: 24,
    restart: false,
  });
  const reply = await client.waitForCommand(commandId);
  assert.equal(reply.type, "error");
  const input = client.send({ type: "terminal_input", terminalId: "t-missing", data: "x" });
  assert.equal((await client.waitForCommand(input)).type, "error");
  client.close();
});

function sink(): TerminalListener & { text: string; exited: boolean } {
  return {
    text: "",
    exited: false,
    output(data) {
      this.text += data;
    },
    exit() {
      this.exited = true;
    },
    congested: () => false,
  };
}

test("scrollback is bounded and replays from a line start", async () => {
  const host = new TerminalHost({ ...SHELL, scrollback: 4096 });
  const terminal = host.open("bounded", { cwd, cols: 80, rows: 24 });
  const live = sink();
  terminal.attach(live);
  terminal.write("i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done; exit 0\n");
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (live.exited) resolve(), clearInterval(timer);
    }, 20);
  });

  const late = terminal.attach(sink());
  assert.equal(late.reset, true);
  assert.ok(late.offset > 0, "the front was trimmed");
  assert.ok(late.data.length <= 4096);
  assert.ok(late.data.includes("line-1999"));
  assert.equal(late.offset + late.data.length, terminal.end);
  host.closeAll();
});

test("the number of live shells is capped", async () => {
  const host = new TerminalHost({ ...SHELL, maxTerminals: 2 });
  host.open("a", { cwd, cols: 80, rows: 24 });
  host.open("b", { cwd, cols: 80, rows: 24 });
  assert.throws(() => host.open("c", { cwd, cols: 80, rows: 24 }), /close one/);
  // The same id is the same shell, not a third one.
  assert.equal(host.open("a", { cwd, cols: 80, rows: 24 }), host.get("a"));
  host.closeAll();
});

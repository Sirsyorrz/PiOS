import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SubprocessSession } from "../src/subprocess.ts";
import { ToolTimer } from "../src/tool-timing.ts";
import type { BufferedEvent } from "../src/types.ts";

const FAKE_PI = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));
/** Kept in step with the `SLOW_TOOL` branch of `fake-pi.ts`. */
const TOOL_WORK_MS = 120;
/** Long enough that counting it would be unmistakable in the assertions. */
const HUMAN_THINKING_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("dialog time is excluded from a tool's duration", async () => {
  const timer = new ToolTimer();
  timer.begin("call-1");
  await sleep(60);
  timer.block();
  await sleep(120);
  timer.unblock();
  await sleep(60);
  const duration = timer.end("call-1");

  assert.ok(duration !== undefined);
  assert.ok(duration >= 100, `expected the two working spans, got ${duration}`);
  assert.ok(duration < 200, `dialog time leaked into the duration: ${duration}`);
});

test("a dialog still open when the tool ends is excluded too", async () => {
  const timer = new ToolTimer();
  timer.begin("call-1");
  timer.block();
  await sleep(120);
  const duration = timer.end("call-1");

  assert.ok(duration !== undefined && duration < 60, `got ${duration}`);
});

test("concurrent calls each lose the same dialog span", async () => {
  const timer = new ToolTimer();
  timer.begin("call-1");
  timer.begin("call-2");
  timer.block();
  await sleep(100);
  timer.unblock();

  for (const id of ["call-1", "call-2"]) {
    const duration = timer.end(id);
    assert.ok(duration !== undefined && duration < 50, `${id} got ${duration}`);
  }
});

test("a call the timer never saw reports no duration", () => {
  assert.equal(new ToolTimer().end("unknown"), undefined);
});

test("an approved tool call is timed from the approval, not from the call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-timing-"));
  const session = await SubprocessSession.start(
    { id: "timing-1", cwd: dir },
    {
      command: process.execPath,
      argsPrefix: [FAKE_PI],
      sessionDir: dir,
      requestTimeoutMs: 10_000,
      dialogTimeoutMs: 10_000,
    },
  );
  try {
    const events: BufferedEvent[] = [];
    const settled = new Promise<void>((resolve) => {
      session.subscribe((buffered) => {
        events.push(buffered);
        if (buffered.event.type === "extension_ui_request") {
          const { id } = buffered.event.request;
          // The human takes their time, exactly as they would on a phone.
          void sleep(HUMAN_THINKING_MS).then(() =>
            session.answerDialog({ type: "extension_ui_response", id, confirmed: true }),
          );
        }
        if (buffered.event.type === "agent_event" && buffered.event.event.type === "agent_settled") {
          resolve();
        }
      });
    });

    const wallStart = Date.now();
    await session.prompt("SLOW_TOOL");
    await settled;
    const wall = Date.now() - wallStart;

    const agentEvents = events.flatMap((buffered) =>
      buffered.event.type === "agent_event" ? [buffered.event.event] : [],
    );
    const start = agentEvents.find((event) => event.type === "tool_execution_start");
    const end = agentEvents.find((event) => event.type === "tool_execution_end");

    assert.ok(start && "startedAt" in start && typeof start.startedAt === "number");
    assert.ok(end && "durationMs" in end && typeof end.durationMs === "number");
    const duration = end.durationMs as number;
    assert.ok(duration >= TOOL_WORK_MS - 20, `too short to be the work: ${duration}`);
    assert.ok(
      duration < TOOL_WORK_MS + HUMAN_THINKING_MS / 2,
      `the confirmation wait was counted: ${duration} of ${wall}ms wall`,
    );
  } finally {
    await session.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

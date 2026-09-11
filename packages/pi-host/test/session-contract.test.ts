import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InProcessSession } from "../src/in-process.ts";
import { SubprocessSession } from "../src/subprocess.ts";
import type { BufferedEvent, PiSession } from "../src/types.ts";
import { fakeAgentFactory } from "./fake-agent.ts";
import { branchFakeSession } from "./fake-branch.ts";

const FAKE_PI = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));

interface Harness {
  name: string;
  start(dir: string, id: string): Promise<PiSession>;
}

const harnesses: Harness[] = [
  {
    name: "InProcessSession",
    start: async (dir, id) =>
      InProcessSession.start({ id, cwd: dir }, fakeAgentFactory(dir).factory, branchFakeSession),
  },
  {
    name: "SubprocessSession",
    start: async (dir, id) =>
      SubprocessSession.start(
        { id, cwd: dir },
        {
          command: process.execPath,
          argsPrefix: [FAKE_PI],
          sessionDir: dir,
          agentDir: join(dir, "agent"),
          branchSessionFile: branchFakeSession,
          requestTimeoutMs: 10_000,
        },
      ),
  },
];

function settled(session: PiSession): Promise<void> {
  return new Promise((resolve) => {
    const off = session.subscribe((buffered) => {
      if (isAgentEvent(buffered, "agent_settled")) {
        off();
        resolve();
      }
    });
  });
}

function isAgentEvent(buffered: BufferedEvent, type: string): boolean {
  return buffered.event.type === "agent_event" && buffered.event.event.type === type;
}

for (const harness of harnesses) {
  describe(harness.name, () => {
    let dir: string;
    let session: PiSession;

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), "pios-host-"));
      // The stub pi has no scope of its own, so the subprocess host reads one
      // from settings; a temp agentDir keeps the suite off the real ~/.pi.
      mkdirSync(join(dir, "agent"), { recursive: true });
      writeFileSync(
        join(dir, "agent", "settings.json"),
        JSON.stringify({ enabledModels: ["acme/fast-1", "acme/deep-1"] }),
      );
      session = await harness.start(dir, "s1");
    });

    after(async () => {
      await session.dispose();
      rmSync(dir, { recursive: true, force: true });
    });

    test("starts idle with an empty session", async () => {
      assert.equal(session.info.status, "idle");
      const page = await session.getEntries();
      assert.deepEqual(page.entries, []);
      assert.equal(page.leafId, null);
      assert.equal(page.reset, false);
    });

    test("a prompt streams deltas and settles", async () => {
      const events: string[] = [];
      const off = session.subscribe((b) => {
        if (b.event.type === "agent_event") events.push(b.event.event.type);
      });

      const done = settled(session);
      const result = await session.prompt("hello");
      assert.equal(result.accepted, true, result.error);
      await done;
      off();

      assert.ok(events.includes("message_update"));
      // agent_settled is the terminal signal, and it comes after agent_end.
      assert.equal(events.at(-1), "agent_settled");
      assert.ok(events.lastIndexOf("agent_end") < events.lastIndexOf("agent_settled"));
      assert.equal(session.info.status, "idle");
    });

    test("entries advance and the cursor slices them", async () => {
      const full = await session.getEntries();
      assert.equal(full.entries.length, 2);
      assert.equal(full.leafId, full.entries.at(-1)!.id);

      const caughtUp = await session.getEntries(full.leafId!);
      assert.deepEqual(caughtUp.entries, []);
      assert.equal(caughtUp.reset, false);

      const delta = await session.getEntries(full.entries[0]!.id);
      assert.equal(delta.entries.length, 1);
      assert.equal(delta.entries[0]!.id, full.leafId);
    });

    test("an unknown cursor resets instead of erroring", async () => {
      const page = await session.getEntries("no-such-entry");
      assert.equal(page.reset, true);
      assert.equal(page.entries.length, 2, "a reset carries the whole session");
    });

    test("a bare prompt during streaming is rejected", async () => {
      const done = settled(session);
      await session.prompt("first");
      const busy = await session.prompt("second");
      assert.equal(busy.accepted, false);
      assert.match(busy.error ?? "", /streamingBehavior/);
      await done;
    });

    test("models are listed and switching one updates the summary", async () => {
      const scoped = await session.listModels();
      assert.equal(scoped.all, false, "the scope is the default, not the catalogue");
      assert.deepEqual(
        scoped.models.map((model) => model.modelId),
        ["fast-1", "deep-1"],
      );

      const all = await session.listModels({ all: true });
      assert.equal(all.all, true);
      assert.equal(all.models.length, 3);
      assert.deepEqual(
        all.models.filter((model) => model.scoped).map((model) => model.modelId),
        ["fast-1", "deep-1"],
      );

      const target = all.models.find((model) => model.modelId !== session.info.model?.modelId)!;
      await session.setModel(target.provider, target.modelId);
      assert.equal(session.info.model?.modelId, target.modelId);
      assert.equal(session.info.model?.provider, target.provider);
    });

    test("slash commands are listed with their provenance", async () => {
      const commands = await session.listCommands();
      assert.deepEqual(
        commands.map((command) => [command.name, command.source]),
        [
          ["review:1", "extension"],
          ["fix-tests", "prompt"],
          ["skill:search", "skill"],
        ],
      );
      assert.equal(commands[0]?.scope, "user");
      assert.equal(commands[1]?.path, "/proj/fix-tests.md");
    });

    test("session stats report tokens, cost and context use", async () => {
      const stats = await session.getStats();
      assert.equal(stats.tokens?.total, 2400);
      assert.equal(stats.cost, 0.0125);
      assert.equal(stats.contextUsage?.contextWindow, 200_000);
    });

    test("a bash command streams, announces both ends, and is persisted", async () => {
      const local = await harness.start(dir, "sbash");
      const seen: string[] = [];
      let deltas = "";
      const off = local.subscribe((b) => {
        if (b.event.type === "bash_state") seen.push(b.event.running ? "start" : "end");
        if (b.event.type === "agent_event" && b.event.event.type === "bash_execution_update") {
          deltas += b.event.event.delta;
        }
      });

      const result = await local.runBash("echo hi");
      off();

      assert.deepEqual(seen, ["start", "end"]);
      assert.equal(result.exitCode, 0);
      assert.equal(result.cancelled, false);
      assert.equal(deltas, result.output, "the deltas add up to the result");

      const page = await local.getEntries();
      const entry = page.entries.at(-1)!;
      assert.equal(entry.message?.role, "bashExecution");
      assert.equal((entry.message as { command: string }).command, "echo hi");
      await local.dispose();
    });

    test("a !! command is recorded as excluded from context", async () => {
      const local = await harness.start(dir, "sbash2");
      await local.runBash("echo secret", { excludeFromContext: true });
      const entry = (await local.getEntries()).entries.at(-1)!;
      assert.equal((entry.message as { excludeFromContext?: boolean }).excludeFromContext, true);
      await local.dispose();
    });

    test("a running command can be cancelled, and only one runs at a time", async () => {
      const local = await harness.start(dir, "sbash3");
      const running = local.runBash("SLOW_BASH");
      await assert.rejects(() => local.runBash("echo second"), /already running/);
      await local.abortBash();
      const result = await running;
      assert.equal(result.cancelled, true);
      await local.dispose();
    });

    test("replay returns the tail after a seq and flags nothing missing", async () => {
      const before = session.replay();
      assert.equal(before.gap, false);
      const midpoint = before.events[Math.floor(before.events.length / 2)]!.seq;

      const tail = session.replay(midpoint);
      assert.equal(tail.gap, false);
      assert.ok(tail.events.every((e) => e.seq > midpoint));
      assert.equal(tail.events.length, before.events.length - before.events.findIndex((e) => e.seq === midpoint) - 1);
    });

    test("a branch is written to its own file and leaves this session alone", async () => {
      const local = await harness.start(dir, "s3");
      for (const text of ["first", "second"]) {
        const done = settled(local);
        await local.prompt(text);
        await done;
      }
      const before = await local.getEntries();
      assert.equal(before.entries.length, 4);

      const branch = await local.branch(before.entries[2]!.id);
      assert.equal(branch.text, "second");
      assert.ok(branch.sessionFile, "the surviving history is a file of its own");
      assert.notEqual(branch.sessionFile, local.info.sessionFile);

      const after = await local.getEntries();
      assert.equal(after.entries.length, 4, "the branched-from session is untouched");
      assert.equal(after.leafId, before.leafId);

      // The opening turn has nothing in front of it, so there is no file to
      // open and the caller starts empty.
      const opening = await local.branch(before.entries[0]!.id);
      assert.equal(opening.text, "first");
      assert.equal(opening.sessionFile, undefined);

      await assert.rejects(() => local.branch(before.entries[1]!.id), /user message/);
      await local.dispose();
    });

    test("status reaches disposed", async () => {
      const local = await harness.start(dir, "s2");
      await local.dispose();
      assert.equal(local.info.status, "disposed");
    });
  });
}

test("a child that cannot be spawned fails the create instead of the daemon", async () => {
  // No `error` listener would make this an unhandled event, which is fatal to
  // the process, not to the session.
  await assert.rejects(
    () =>
      SubprocessSession.start(
        { cwd: process.cwd() },
        { command: "definitely-not-a-real-binary-xyz", requestTimeoutMs: 2000 },
      ),
    /not found on PATH/,
  );
});

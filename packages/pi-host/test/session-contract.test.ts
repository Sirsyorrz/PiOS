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

const FAKE_PI = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));

interface Harness {
  name: string;
  start(dir: string, id: string): Promise<PiSession>;
}

const harnesses: Harness[] = [
  {
    name: "InProcessSession",
    start: async (dir, id) =>
      InProcessSession.start({ id, cwd: dir }, fakeAgentFactory(dir).factory),
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

    test("replay returns the tail after a seq and flags nothing missing", async () => {
      const before = session.replay();
      assert.equal(before.gap, false);
      const midpoint = before.events[Math.floor(before.events.length / 2)]!.seq;

      const tail = session.replay(midpoint);
      assert.equal(tail.gap, false);
      assert.ok(tail.events.every((e) => e.seq > midpoint));
      assert.equal(tail.events.length, before.events.length - before.events.findIndex((e) => e.seq === midpoint) - 1);
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

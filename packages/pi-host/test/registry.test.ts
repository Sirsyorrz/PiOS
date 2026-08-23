import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry, inProcessHost } from "../src/registry.ts";
import type { PiSession } from "../src/types.ts";
import { fakeAgentFactory } from "./fake-agent.ts";

function registry() {
  const dir = mkdtempSync(join(tmpdir(), "pios-registry-"));
  const { factory } = fakeAgentFactory(dir);
  return { dir, registry: new SessionRegistry(inProcessHost(factory), { restartDelayMs: 0 }) };
}

test("sessions are listed with their cwd and trust state", async () => {
  const { dir, registry: reg } = registry();
  await reg.create({ id: "a", cwd: "/tmp/a", trustProject: true });
  await reg.create({ id: "b", cwd: "/tmp/b" });

  const listed = reg.list();
  assert.deepEqual(listed.map((s) => s.id).sort(), ["a", "b"]);
  assert.equal(listed.find((s) => s.id === "a")!.trusted, true);
  // Trust is never inherited: an unspecified session is untrusted.
  assert.equal(listed.find((s) => s.id === "b")!.trusted, false);

  await reg.disposeAll();
  rmSync(dir, { recursive: true, force: true });
});

test("two sessions run concurrently without crossing streams", async () => {
  const { dir, registry: reg } = registry();
  const one = await reg.create({ id: "one", cwd: "/tmp/one" });
  const two = await reg.create({ id: "two", cwd: "/tmp/two" });

  const texts = new Map<string, string>();
  for (const session of [one, two]) {
    session.subscribe((b) => {
      if (b.event.type !== "agent_event") return;
      const event = b.event.event;
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        texts.set(session.id, (texts.get(session.id) ?? "") + event.assistantMessageEvent.delta);
      }
    });
  }

  await Promise.all([
    one.prompt("alpha").then(() => waitSettled(one)),
    two.prompt("beta").then(() => waitSettled(two)),
  ]);

  assert.equal(texts.get("one"), "echo: alpha");
  assert.equal(texts.get("two"), "echo: beta");

  await reg.disposeAll();
  rmSync(dir, { recursive: true, force: true });
});

test("dispose removes the session from the registry", async () => {
  const { dir, registry: reg } = registry();
  const session = await reg.create({ id: "x", cwd: "/tmp/x" });
  await reg.dispose(session.id);

  assert.equal(reg.get("x"), undefined);
  assert.deepEqual(reg.list(), []);
  assert.equal(session.info.status, "disposed");
  // Disposing twice is not an error; a client may retry the request.
  await reg.dispose(session.id);
  rmSync(dir, { recursive: true, force: true });
});

function waitSettled(session: PiSession): Promise<void> {
  return new Promise((resolve) => {
    const off = session.subscribe((buffered) => {
      if (buffered.event.type !== "agent_event") return;
      if (buffered.event.event.type !== "agent_settled") return;
      off();
      resolve();
    });
  });
}

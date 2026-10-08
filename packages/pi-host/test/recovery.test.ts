import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionRegistry, subprocessHost, inProcessHost } from "../src/registry.ts";
import type { BufferedEvent } from "../src/types.ts";
import { fakeAgentFactory } from "./fake-agent.ts";
import { projectSessionDir } from "../src/session-paths.ts";

const FAKE_PI = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pios-recover-"));
}

/** Minimal host, so the restart policy is tested without process timing. */
function stubHost() {
  let restarts = 0;
  const host = {
    create: async (options: { id?: string; cwd: string }) => {
      let status = "idle";
      const session = {
        id: options.id ?? "stub",
        get info() {
          return {
            id: session.id,
            cwd: options.cwd,
            trusted: false,
            status,
            leafId: null,
            updatedAt: 0,
          } as never;
        },
        prompt: async () => ({ accepted: true }),
        steer: async () => ({ accepted: true }),
        followUp: async () => ({ accepted: true }),
        getEntries: async () => ({ entries: [], leafId: null, reset: false }),
        interrupt: async () => {},
        dispose: async () => {
          status = "disposed";
        },
        subscribe: () => () => {},
        replay: () => ({ events: [], gap: false }),
        restart: async () => {
          restarts++;
          status = "crashed";
        },
      };
      return session as never;
    },
  };
  return { host, restarts: () => restarts };
}

function subprocessRegistry(dir: string, options = {}) {
  return new SessionRegistry(
    subprocessHost({
      command: process.execPath,
      argsPrefix: [FAKE_PI],
      sessionDir: dir,
      requestTimeoutMs: 5_000,
    }),
    { restartDelayMs: 1, ...options },
  );
}

function waitFor(
  session: { subscribe(l: (e: BufferedEvent) => void): () => void },
  predicate: (e: BufferedEvent) => boolean,
  timeoutMs = 5_000,
): Promise<BufferedEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for event"));
    }, timeoutMs);
    const off = session.subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      off();
      resolve(event);
    });
  });
}

test("a dead child is restarted and resumes from the persisted session", async () => {
  const dir = tempDir();
  const registry = subprocessRegistry(dir);
  const session = await registry.create({ id: "crash-1", cwd: dir });

  const settled = waitFor(
    session,
    (e) => e.event.type === "agent_event" && e.event.event.type === "agent_settled",
  );
  await session.prompt("first");
  await settled;

  const beforeCrash = await session.getEntries();
  assert.equal(beforeCrash.entries.length, 2);

  const recovered = waitFor(session, (e) => e.event.type === "session_recovered");
  await session.prompt("CRASH_NOW");
  const event = await recovered;

  assert.equal(event.event.type === "session_recovered" && event.event.reason.includes("code 7"), true);
  assert.equal(session.info.status, "idle");

  // The restart reloaded what pi had written, so the cursor still resolves.
  const afterCrash = await session.getEntries();
  assert.equal(afterCrash.entries.length, 2);
  assert.equal(afterCrash.leafId, beforeCrash.leafId);

  const delta = await session.getEntries(beforeCrash.entries[0]!.id);
  assert.equal(delta.reset, false, "the pre-crash cursor is still valid after recovery");

  await registry.disposeAll();
  rmSync(dir, { recursive: true, force: true });
});

test("trusting a session relaunches it in place, keeping id and transcript", async () => {
  const dir = tempDir();
  const registry = subprocessRegistry(dir);
  const session = await registry.create({ id: "trust-1", cwd: dir, trustProject: false });

  const settled = waitFor(
    session,
    (e) => e.event.type === "agent_event" && e.event.event.type === "agent_settled",
  );
  await session.prompt("first");
  await settled;
  const before = await session.getEntries();

  const recovered = waitFor(session, (e) => e.event.type === "session_recovered");
  await registry.setProjectTrust("trust-1", true);
  await recovered;

  const launches = readFileSync(join(projectSessionDir(dir, dir), "argv.log"), "utf8")
    .trim()
    .split("\n");
  assert.equal(launches.length, 2);
  assert.match(launches[0]!, /--session-id trust-1 .*--no-approve/);
  // The relaunch resumes the exact file, so it cannot land on an empty
  // session when the project lookup by id misses.
  assert.match(launches[1]!, /--session \S+trust-1\.jsonl .*--approve/);

  assert.equal(registry.list().length, 1, "trusting must not fork a second session");
  assert.equal(session.info.trusted, true);
  assert.equal(session.info.status, "idle");

  const after = await session.getEntries();
  assert.equal(after.leafId, before.leafId);
  assert.equal(after.entries.length, before.entries.length);

  await registry.disposeAll();
  rmSync(dir, { recursive: true, force: true });
});

test("a crash mid-stream rewinds to the last durable entry", async () => {
  const dir = tempDir();
  const registry = subprocessRegistry(dir);
  const session = await registry.create({ id: "crash-2", cwd: dir });

  const recovered = waitFor(session, (e) => e.event.type === "session_recovered");
  await session.prompt("CRASH_MIDSTREAM");
  await recovered;

  // The user prompt was persisted; the half-streamed assistant reply was not.
  const page = await session.getEntries();
  assert.equal(page.entries.length, 1);
  assert.equal((page.entries[0]!.message as { role: string }).role, "user");

  await registry.disposeAll();
  rmSync(dir, { recursive: true, force: true });
});

test("the status stream reports crashed before recovered", async () => {
  const dir = tempDir();
  const registry = subprocessRegistry(dir);
  const session = await registry.create({ id: "crash-3", cwd: dir });

  const seen: string[] = [];
  session.subscribe((e) => {
    if (e.event.type === "status") seen.push(e.event.status);
    if (e.event.type === "session_recovered") seen.push("recovered");
  });

  const recovered = waitFor(session, (e) => e.event.type === "session_recovered");
  await session.prompt("CRASH_NOW");
  await recovered;

  assert.ok(seen.includes("crashed"), `expected crashed in ${seen.join(",")}`);
  assert.ok(seen.indexOf("crashed") < seen.indexOf("recovered"));

  await registry.disposeAll();
  rmSync(dir, { recursive: true, force: true });
});

test("a crash loop stops after the restart budget", async () => {
  const stub = stubHost();
  const registry = new SessionRegistry(stub.host, { maxRestarts: 2, restartDelayMs: 0 });
  const session = await registry.create({ id: "loop", cwd: "/tmp" });

  assert.equal(await registry.recover(session.id, "boom"), true);
  assert.equal(await registry.recover(session.id, "boom"), true);
  assert.equal(await registry.recover(session.id, "boom"), false, "budget spent");
  assert.equal(stub.restarts(), 2);
  assert.equal(session.info.status, "crashed");
});

test("a session that stayed up long enough gets a fresh budget", async () => {
  const stub = stubHost();
  let now = 1_000;
  const registry = new SessionRegistry(stub.host, {
    maxRestarts: 1,
    restartDelayMs: 0,
    now: () => now,
    sleep: async () => {},
  });
  const session = await registry.create({ id: "uptime", cwd: "/tmp" });

  assert.equal(await registry.recover(session.id, "boom"), true);
  assert.equal(await registry.recover(session.id, "boom"), false, "immediate second crash is a loop");

  // An hour of healthy uptime is a bad day, not a crash loop.
  now += 3_600_000;
  assert.equal(await registry.recover(session.id, "boom"), true);
});

test("a disposed session is not recovered", async () => {
  const stub = stubHost();
  const registry = new SessionRegistry(stub.host, { restartDelayMs: 0 });
  const session = await registry.create({ id: "gone", cwd: "/tmp" });
  await registry.dispose(session.id);
  assert.equal(await registry.recover(session.id, "boom"), false);
  assert.equal(stub.restarts(), 0);
});

test("disposing during a crash does not resurrect the session", async () => {
  const dir = tempDir();
  const registry = subprocessRegistry(dir, { restartDelayMs: 30 });
  const session = await registry.create({ id: "crash-5", cwd: dir });

  await session.prompt("CRASH_NOW");
  await registry.dispose(session.id);
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(session.info.status, "disposed");
  assert.equal(registry.get(session.id), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("the in-process host reattaches from the session file on restart", async () => {
  const dir = tempDir();
  const { factory, created } = fakeAgentFactory(dir);
  const registry = new SessionRegistry(inProcessHost(factory), { restartDelayMs: 1 });
  const session = await registry.create({ id: "inproc-1", cwd: dir });

  const settled = waitFor(
    session,
    (e) => e.event.type === "agent_event" && e.event.event.type === "agent_settled",
  );
  await session.prompt("hello");
  await settled;

  const recovered = waitFor(session, (e) => e.event.type === "session_recovered");
  await registry.recover(session.id, "simulated fault");
  const event = await recovered;

  assert.equal(created.length, 2, "a fresh agent was built");
  assert.equal(created[0]!.disposed, true, "the broken agent was released");
  assert.equal(event.event.type === "session_recovered" && event.event.leafId, session.info.leafId);

  const page = await session.getEntries();
  assert.equal(page.entries.length, 2, "state came back from the session file");

  await registry.disposeAll();
  rmSync(dir, { recursive: true, force: true });
});

test("an event this build does not understand is dropped, not forwarded", async () => {
  const dir = tempDir();
  const { factory, created } = fakeAgentFactory(dir);
  const registry = new SessionRegistry(inProcessHost(factory), { restartDelayMs: 1 });
  const session = await registry.create({ id: "inproc-2", cwd: dir });

  const before = session.replay().events.length;
  created[0]!.emitUnknownEvent();
  assert.equal(session.replay().events.length, before);

  await registry.disposeAll();
  rmSync(dir, { recursive: true, force: true });
});

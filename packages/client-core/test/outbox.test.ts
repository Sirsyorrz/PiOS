import { test } from "node:test";
import assert from "node:assert/strict";
import { ThreadOutbox, OUTBOX_SCHEMA_VERSION, type OutboxEntry } from "../src/outbox.ts";
import { MemoryStorage } from "../src/storage.ts";
import { FakeScheduler } from "../src/scheduler.ts";

function setup(options: { online?: boolean } = {}) {
  const scheduler = new FakeScheduler();
  const storage = new MemoryStorage();
  const state = { online: options.online ?? true, sent: [] as OutboxEntry[] };
  const outbox = new ThreadOutbox({
    storage,
    scheduler,
    backoff: { baseMs: 1000, capMs: 16_000, factor: 2 },
    send: (entry) => {
      if (!state.online) return false;
      state.sent.push(entry);
      return true;
    },
  });
  return { scheduler, storage, state, outbox };
}

function compose(overrides: Partial<OutboxEntry> = {}) {
  return {
    messageId: "m1",
    commandId: "c1",
    sessionId: "s1",
    text: "hello",
    images: [],
    ...overrides,
  };
}

test("a queued prompt is sent and cleared on ack", () => {
  const { outbox, state } = setup();
  outbox.enqueue(compose());
  assert.equal(state.sent.length, 1);
  assert.equal(outbox.pendingCount, 1, "still pending until acknowledged");

  outbox.acknowledge("c1");
  assert.equal(outbox.pendingCount, 0);
  assert.deepEqual(outbox.list(), []);
});

test("a prompt composed offline waits, then drains on reconnect", async () => {
  const { outbox, state, scheduler } = setup({ online: false });
  outbox.enqueue(compose());

  assert.equal(state.sent.length, 0);
  assert.equal(outbox.list()[0]!.status, "queued");

  // Retries on its own ladder while there is no socket.
  await scheduler.runNext();
  assert.equal(state.sent.length, 0);

  state.online = true;
  outbox.drain();
  assert.equal(state.sent.length, 1);
});

test("the outbox retry ladder is also capped at 16s", async () => {
  const { outbox, scheduler } = setup({ online: false });
  outbox.enqueue(compose());

  const delays: number[] = [];
  for (let i = 0; i < 7; i++) delays.push((await scheduler.runNext())!);
  assert.deepEqual(delays.slice(0, 5), [1000, 2000, 4000, 8000, 16_000]);
  assert.ok(delays.slice(5).every((d) => d === 16_000));
});

test("a queued prompt survives an app restart", () => {
  const { outbox, storage, scheduler } = setup({ online: false });
  outbox.enqueue(compose({ text: "written on the train" }));

  // The app is killed; only what reached storage exists.
  const restarted = new ThreadOutbox({
    storage: storage.clone(),
    scheduler,
    send: () => true,
  });

  const entries = restarted.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.text, "written on the train");
  assert.equal(entries[0]!.commandId, "c1", "the idempotency key survives too");
});

test("an entry that was mid-flight at the crash is queued again, not lost", () => {
  const storage = new MemoryStorage();
  storage.set(
    "pios.outbox",
    JSON.stringify({
      version: OUTBOX_SCHEMA_VERSION,
      data: [{ ...compose(), attempts: 1, status: "sending", createdAt: 0 }],
    }),
  );

  const sent: OutboxEntry[] = [];
  const outbox = new ThreadOutbox({
    storage,
    send: (entry) => {
      sent.push(entry);
      return true;
    },
  });
  assert.equal(outbox.list()[0]!.status, "queued");

  // Redelivery is safe: the daemon dedupes on commandId.
  outbox.drain();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.commandId, "c1");
});

test("a cache written by a future schema version is not silently replayed", () => {
  const storage = new MemoryStorage();
  storage.set(
    "pios.outbox",
    JSON.stringify({ version: OUTBOX_SCHEMA_VERSION + 1, data: [compose()] }),
  );
  const outbox = new ThreadOutbox({ storage, send: () => true });
  assert.deepEqual(outbox.list(), []);
});

test("enqueueing the same commandId twice queues one entry", () => {
  const { outbox, state } = setup();
  outbox.enqueue(compose());
  outbox.enqueue(compose());
  assert.equal(outbox.list().length, 1);
  assert.equal(state.sent.length, 1);
});

test("a rejected prompt is kept and marked failed, never dropped", () => {
  const { outbox } = setup();
  outbox.enqueue(compose());
  outbox.reject("c1", "Specify streamingBehavior");

  const entry = outbox.list()[0]!;
  assert.equal(entry.status, "failed");
  assert.match(entry.lastError!, /streamingBehavior/);
  assert.equal(outbox.pendingCount, 0, "a failed entry does not block the queue");
});

test("a failed prompt can be fixed and requeued", () => {
  const { outbox, state } = setup();
  outbox.enqueue(compose());
  outbox.reject("c1", "Specify streamingBehavior");
  state.sent.length = 0;

  outbox.requeue("c1", { streamingBehavior: "steer" });
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0]!.streamingBehavior, "steer");
});

test("entries are drained in the order they were composed", () => {
  const { outbox, state } = setup({ online: false });
  outbox.enqueue(compose({ commandId: "c1", text: "first" }));
  outbox.enqueue(compose({ commandId: "c2", text: "second" }));
  outbox.enqueue(compose({ commandId: "c3", text: "third" }));

  state.online = true;
  outbox.drain();
  assert.deepEqual(state.sent.map((e) => e.text), ["first", "second", "third"]);
});

test("a drop mid-drain leaves the rest queued for the next attempt", () => {
  const scheduler = new FakeScheduler();
  const storage = new MemoryStorage();
  const sent: OutboxEntry[] = [];
  let allowed = 1;
  const outbox = new ThreadOutbox({
    storage,
    scheduler,
    send: (entry) => {
      if (allowed <= 0) return false;
      allowed--;
      sent.push(entry);
      return true;
    },
  });

  outbox.enqueue(compose({ commandId: "c1" }));
  outbox.enqueue(compose({ commandId: "c2" }));
  assert.deepEqual(sent.map((e) => e.commandId), ["c1"]);
  assert.equal(outbox.list().find((e) => e.commandId === "c2")!.status, "queued");
  // The failed one was not counted as an attempt against a dead socket.
  assert.equal(outbox.list().find((e) => e.commandId === "c2")!.attempts, 0);
});

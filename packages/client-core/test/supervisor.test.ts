import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionSupervisor } from "../src/supervisor.ts";
import { FakeScheduler, flush } from "../src/scheduler.ts";
import { WIRE_VERSION } from "@pios/protocol";
import { TransportFactoryStub, summary } from "./fake-transport.ts";

function setup(options: { stableAfterMs?: number } = {}) {
  const scheduler = new FakeScheduler();
  const transports = new TransportFactoryStub();
  const supervisor = new ConnectionSupervisor({
    createTransport: transports.create,
    scheduler,
    backoff: { baseMs: 1000, capMs: 16_000, factor: 2 },
    stableAfterMs: options.stableAfterMs ?? 30_000,
  });
  supervisor.setCredentials({ url: "ws://test", deviceToken: "token" });
  return { scheduler, transports, supervisor };
}

test("connected requires the hello round trip, not just an open socket", async () => {
  const { transports, supervisor } = setup();
  supervisor.start();
  await flush();

  // The socket exists and the hello has been sent, but nothing has answered.
  assert.equal(supervisor.getState().transport, "connecting");
  assert.equal(transports.last.sentOfType("hello").length, 1);

  transports.last.acceptHello([summary()]);
  assert.equal(supervisor.getState().transport, "connected");
  assert.equal(supervisor.getState().sessions.length, 1);
});

test("backoff doubles and caps at 16s, retrying forever", async () => {
  const { scheduler, transports, supervisor } = setup();
  transports.failures = 100;
  supervisor.start();
  await flush();

  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    // Each pass sits in `waiting` until its timer fires.
    assert.equal(supervisor.getState().transport, "waiting");
    delays.push((await scheduler.runNext())!);
  }

  assert.deepEqual(delays.slice(0, 5), [1000, 2000, 4000, 8000, 16_000]);
  assert.ok(delays.slice(5).every((d) => d === 16_000), "capped, and still trying");
});

test("a brief connection does not reset the ladder", async () => {
  const { scheduler, transports, supervisor } = setup({ stableAfterMs: 30_000 });
  transports.failures = 2;
  supervisor.start();
  await flush();
  assert.equal(await scheduler.runNext(), 1000);
  assert.equal(await scheduler.runNext(), 2000);

  transports.last.acceptHello();
  assert.equal(supervisor.getState().transport, "connected");

  // Dies after two seconds, well short of the stability window.
  await scheduler.advance(2000);
  transports.last.drop();
  assert.equal(supervisor.getState().transport, "waiting");

  assert.equal(await scheduler.runNext(), 4000, "ladder continued from where it was");
});

test("thirty seconds of stability resets the ladder", async () => {
  const { scheduler, transports, supervisor } = setup({ stableAfterMs: 30_000 });
  transports.failures = 3;
  supervisor.start();
  await flush();
  for (let i = 0; i < 3; i++) await scheduler.runNext();

  transports.last.acceptHello();
  await scheduler.advance(30_000);
  assert.equal(supervisor.getState().attempts, 0);

  transports.last.drop();
  assert.equal(await scheduler.runNext(), 1000, "back to the bottom of the ladder");
});

test("offline releases the connection and arms no timers", async () => {
  const { scheduler, transports, supervisor } = setup();
  supervisor.start();
  await flush();
  transports.last.acceptHello();

  supervisor.setOnline(false);
  assert.equal(supervisor.getState().transport, "offline");
  assert.equal(transports.last.closed, true);
  // The whole point: a radio that is off must not consume the ladder.
  assert.equal(scheduler.pending, 0, "no retry timer while offline");

  const attemptsBefore = transports.created.length;
  await scheduler.advance(120_000);
  assert.equal(transports.created.length, attemptsBefore, "nothing was attempted");

  supervisor.setOnline(true);
  await flush();
  assert.equal(supervisor.getState().transport, "connecting");
});

test("an auth failure blocks permanently until the inputs change", async () => {
  const { scheduler, transports, supervisor } = setup();
  supervisor.start();
  await flush();
  transports.last.drop(4401, "unauthorized");

  assert.equal(supervisor.getState().transport, "blocked");
  assert.equal(supervisor.getState().blockedReason, "unauthorized");
  assert.equal(scheduler.pending, 0, "a bad token is not a network problem");

  const attempts = transports.created.length;
  await scheduler.advance(600_000);
  assert.equal(transports.created.length, attempts, "no retries against a rejected token");

  // Waking does not help either; only new inputs do.
  supervisor.wake("foreground");
  await flush();
  assert.equal(transports.created.length, attempts);

  supervisor.setCredentials({ url: "ws://test", deviceToken: "fresh" });
  await flush();
  assert.equal(supervisor.getState().transport, "connecting");
  assert.equal(transports.created.length, attempts + 1);
});

test("an unauthorized error frame blocks as hard as a close does", async () => {
  const { transports, supervisor } = setup();
  supervisor.start();
  await flush();
  transports.last.acceptHello();
  transports.last.emit({
    v: WIRE_VERSION,
    type: "error",
    code: "unauthorized",
    message: "token revoked",
  });
  assert.equal(supervisor.getState().transport, "blocked");
});

test("missing credentials block instead of spinning", async () => {
  const scheduler = new FakeScheduler();
  const transports = new TransportFactoryStub();
  const supervisor = new ConnectionSupervisor({
    createTransport: transports.create,
    scheduler,
  });
  supervisor.start();
  await flush();

  assert.equal(supervisor.getState().transport, "blocked");
  assert.equal(scheduler.pending, 0);
  assert.equal(transports.created.length, 0);
});

test("a drop mid-stream reconnects and reports transport health honestly", async () => {
  const { scheduler, transports, supervisor } = setup();
  supervisor.start();
  await flush();
  transports.last.acceptHello([summary()]);

  transports.last.emit({
    v: WIRE_VERSION,
    type: "agent_event",
    sessionId: "s1",
    seq: 1,
    event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "par" } },
  });

  transports.last.drop();
  // Cached sessions are still on screen, but the socket is gone and the state
  // says so rather than inferring health from the data.
  assert.equal(supervisor.getState().transport, "waiting");
  assert.equal(supervisor.getState().sessions.length, 1);

  await scheduler.advance(1000);
  await flush();
  transports.last.acceptHello([summary()]);
  assert.equal(supervisor.getState().transport, "connected");
  assert.equal(transports.created.length, 2);
});

test("sync status is independent of transport health", async () => {
  const { transports, supervisor } = setup();
  supervisor.start();
  await flush();
  transports.last.acceptHello();

  supervisor.setSyncStatus("error");
  const state = supervisor.getState();
  assert.equal(state.transport, "connected", "a failed subscription is not a disconnect");
  assert.equal(state.sync, "error");
});

test("waking during an in-flight attempt replaces it exactly once", async () => {
  const { transports, supervisor } = setup();
  supervisor.start();
  await flush();
  assert.equal(transports.created.length, 1);

  supervisor.wake("application-active-reconnect");
  await flush();
  assert.equal(transports.created.length, 2);
  assert.equal(transports.created[0]!.closed, true, "the stale attempt was released");

  // The abandoned socket must not be able to report itself connected.
  transports.created[0]!.acceptHello([summary()]);
  assert.equal(supervisor.getState().transport, "connecting");
});

test("stop clears everything and does not retry", async () => {
  const { scheduler, transports, supervisor } = setup();
  supervisor.start();
  await flush();
  transports.last.acceptHello();

  supervisor.stop();
  assert.equal(supervisor.getState().transport, "idle");
  assert.equal(scheduler.pending, 0);
  await scheduler.advance(60_000);
  assert.equal(transports.created.length, 1);
});

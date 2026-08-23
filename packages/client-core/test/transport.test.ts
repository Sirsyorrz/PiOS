import { test } from "node:test";
import assert from "node:assert/strict";
import { WIRE_VERSION } from "@pios/protocol";
import { webSocketTransport, isAuthFailure, type WebSocketLike } from "../src/transport.ts";

class StubSocket implements WebSocketLike {
  readonly sent: string[] = [];
  closed = false;
  private handlers = new Map<string, ((event: never) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, handler: (event: never) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  fire(type: string, event?: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event as never);
  }
}

let latest: StubSocket;
const factory = webSocketTransport(
  class {
    constructor(_url: string) {
      latest = new StubSocket();
      return latest as unknown as StubSocket;
    }
  } as unknown as new (url: string) => WebSocketLike,
);

test("the transport resolves on open, not on construction", async () => {
  const pending = factory("ws://test");
  let resolved = false;
  void pending.then(() => (resolved = true));
  await Promise.resolve();
  assert.equal(resolved, false);

  latest.fire("open");
  const transport = await pending;
  assert.ok(transport);
});

test("frames round-trip as JSON", async () => {
  const pending = factory("ws://test");
  latest.fire("open");
  const transport = await pending;

  transport.send({ v: WIRE_VERSION, type: "list_sessions", commandId: "c1" });
  assert.deepEqual(JSON.parse(latest.sent[0]!), {
    v: WIRE_VERSION,
    type: "list_sessions",
    commandId: "c1",
  });

  const received: unknown[] = [];
  transport.onMessage((frame) => received.push(frame));
  latest.fire("message", { data: JSON.stringify({ v: WIRE_VERSION, type: "ack", commandId: "c1" }) });
  assert.equal(received.length, 1);
});

test("an unparseable frame is dropped without killing the socket", async () => {
  const pending = factory("ws://test");
  latest.fire("open");
  const transport = await pending;

  const received: unknown[] = [];
  transport.onMessage((frame) => received.push(frame));
  latest.fire("message", { data: "not json" });
  latest.fire("message", { data: JSON.stringify({ v: WIRE_VERSION, type: "ack", commandId: "c" }) });
  assert.equal(received.length, 1, "the good frame still arrived");
});

test("closing before open rejects rather than hanging", async () => {
  const pending = factory("ws://test");
  latest.fire("close", { code: 4401, reason: "unauthorized" });
  await assert.rejects(pending, /closed before open/);
});

test("auth close codes are recognised", () => {
  assert.equal(isAuthFailure(4401), true);
  assert.equal(isAuthFailure(4403), true);
  assert.equal(isAuthFailure(1006), false);
});

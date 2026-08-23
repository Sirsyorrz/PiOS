import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientFrameSchema, ServerFrameSchema, WIRE_VERSION, isWireVersionMismatch } from "../src/wire.ts";
import { RpcCommandSchema, isUnknownCursorError } from "../src/commands.ts";
import { parseWith } from "../src/parse.ts";
import { AgentEventSchema } from "../src/events.ts";

test("a prompt frame requires an idempotency key and a message id", () => {
  const ok = ClientFrameSchema.safeParse({
    v: WIRE_VERSION,
    type: "prompt",
    commandId: "c1",
    sessionId: "s1",
    messageId: "m1",
    text: "hi",
  });
  assert.ok(ok.success);
  assert.deepEqual(ok.data.type === "prompt" ? ok.data.images : null, []);

  const missing = ClientFrameSchema.safeParse({
    v: WIRE_VERSION,
    type: "prompt",
    sessionId: "s1",
    messageId: "m1",
    text: "hi",
  });
  assert.equal(missing.success, false);
});

test("a frame from another schema version is rejected, not coerced", () => {
  const frame = { v: WIRE_VERSION + 1, type: "hello", commandId: "c1" };
  assert.ok(isWireVersionMismatch(frame));
  assert.equal(ClientFrameSchema.safeParse(frame).success, false);
});

test("entries frames carry leafId and a reset flag", () => {
  const parsed = ServerFrameSchema.parse({
    v: WIRE_VERSION,
    type: "entries",
    sessionId: "s1",
    entries: [{ id: "e1", type: "message" }],
    leafId: "e1",
  });
  assert.equal(parsed.type === "entries" && parsed.reset, false);

  const nullLeaf = ServerFrameSchema.safeParse({
    v: WIRE_VERSION,
    type: "entries",
    sessionId: "s1",
    entries: [],
    leafId: null,
  });
  assert.ok(nullLeaf.success, "an empty session has a null leafId");
});

test("streamingBehavior is optional on the wire but constrained", () => {
  assert.ok(RpcCommandSchema.safeParse({ type: "prompt", message: "x" }).success);
  assert.ok(
    RpcCommandSchema.safeParse({ type: "prompt", message: "x", streamingBehavior: "steer" }).success,
  );
  assert.equal(
    RpcCommandSchema.safeParse({ type: "prompt", message: "x", streamingBehavior: "queue" }).success,
    false,
  );
});

test("an unknown cursor is identified from the failed response", () => {
  assert.ok(
    isUnknownCursorError({
      type: "response",
      command: "get_entries",
      success: false,
      error: "Entry not found: abc",
    }),
  );
  assert.equal(
    isUnknownCursorError({ type: "response", command: "get_entries", success: true }),
    false,
  );
});

test("an unrecognised event reports unknown_shape instead of throwing", () => {
  const result = parseWith(AgentEventSchema, '{"type":"telepathy_start"}');
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "unknown_shape");
});

test("unknown fields on a known event survive validation", () => {
  const result = parseWith(
    AgentEventSchema,
    '{"type":"agent_settled","futureField":{"nested":true}}',
  );
  assert.ok(result.ok);
  assert.deepEqual((result.value as Record<string, unknown>).futureField, { nested: true });
});

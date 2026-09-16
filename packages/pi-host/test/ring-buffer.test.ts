import { test } from "node:test";
import assert from "node:assert/strict";
import { EventRingBuffer } from "../src/ring-buffer.ts";
import type { HostEvent } from "../src/types.ts";

const settled: HostEvent = { type: "agent_event", event: { type: "agent_settled" } };
const delta: HostEvent = { type: "agent_event", event: { type: "agent_start" } };

test("seq starts at 1 and increases", () => {
  const buffer = new EventRingBuffer();
  assert.equal(buffer.push(settled).seq, 1);
  assert.equal(buffer.push(settled).seq, 2);
  assert.equal(buffer.lastSeq, 2);
});

test("replay from a seq returns only what follows", () => {
  const buffer = new EventRingBuffer();
  for (let i = 0; i < 5; i++) buffer.push(settled);
  const { events, gap } = buffer.replay(2);
  assert.deepEqual(events.map((e) => e.seq), [3, 4, 5]);
  assert.equal(gap, false);
});

test("a cursor at the head is caught up, not gapped", () => {
  const buffer = new EventRingBuffer();
  buffer.push(settled);
  const { events, gap } = buffer.replay(1);
  assert.deepEqual(events, []);
  assert.equal(gap, false);
});

test("evicted events are reported as a gap, not silently skipped", () => {
  const buffer = new EventRingBuffer(3);
  for (let i = 0; i < 6; i++) buffer.push(settled);
  assert.equal(buffer.size, 3);

  // seq 1..3 are gone; a client sitting at 1 has missed 2 and 3.
  const stale = buffer.replay(1);
  assert.equal(stale.gap, true);
  assert.deepEqual(stale.events.map((e) => e.seq), [4, 5, 6]);

  // A client at 3 is contiguous with what remains.
  const contiguous = buffer.replay(3);
  assert.equal(contiguous.gap, false);
  assert.deepEqual(contiguous.events.map((e) => e.seq), [4, 5, 6]);
});

test("a fresh cursor replays the in-flight turn, not the whole session", () => {
  const buffer = new EventRingBuffer();
  buffer.push(delta);
  buffer.push(settled);
  buffer.push(delta);

  for (const cursor of [undefined, 0]) {
    const { events, gap } = buffer.replay(cursor);
    assert.deepEqual(events.map((e) => e.seq), [3]);
    assert.equal(gap, false);
  }
});

test("a cursor from an earlier process is treated as fresh", () => {
  const buffer = new EventRingBuffer();
  buffer.push(settled);
  buffer.push(delta);
  const { events, gap } = buffer.replay(900);
  assert.deepEqual(events.map((e) => e.seq), [2]);
  assert.equal(gap, false);
});

test("a turn that outgrew the buffer is a gap for a fresh cursor", () => {
  const buffer = new EventRingBuffer(2);
  buffer.push(settled);
  for (let i = 0; i < 3; i++) buffer.push(delta);
  const { gap } = buffer.replay(0);
  assert.equal(gap, true);
});

test("an unsettled buffer replays everything it holds", () => {
  const buffer = new EventRingBuffer();
  buffer.push(delta);
  buffer.push(delta);
  assert.deepEqual(buffer.replay(0).events.map((e) => e.seq), [1, 2]);
});

test("capacity must be positive", () => {
  assert.throws(() => new EventRingBuffer(0));
});

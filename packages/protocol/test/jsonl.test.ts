import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonlFramer, encodeJsonl } from "../src/jsonl.ts";

test("splits on LF only", () => {
  const framer = new JsonlFramer();
  assert.deepEqual(framer.push('{"a":1}\n{"a":2}\n'), ['{"a":1}', '{"a":2}']);
});

test("does not split on U+2028 or U+2029 inside a string", () => {
  const framer = new JsonlFramer();
  const text = "line\u2028break\u2029here";
  const record = JSON.stringify({ type: "text_delta", delta: text });
  // JSON.stringify leaves these separators unescaped, which is exactly the
  // case that breaks readline.
  assert.ok(record.includes("\u2028"));

  const out = framer.push(record + "\n");
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]!).delta, text);
});

test("buffers a record split across chunks", () => {
  const framer = new JsonlFramer();
  assert.deepEqual(framer.push('{"a":'), []);
  assert.deepEqual(framer.push("1}\n"), ['{"a":1}']);
});

test("holds a multi-byte character split across chunk boundaries", () => {
  const framer = new JsonlFramer();
  const bytes = Buffer.from(JSON.stringify({ s: "\u2028\u{1F600}" }) + "\n", "utf8");
  const out: string[] = [];
  for (const byte of bytes) out.push(...framer.push(Uint8Array.of(byte)));
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]!).s, "\u2028\u{1F600}");
});

test("strips a trailing CR but keeps interior CR", () => {
  const framer = new JsonlFramer();
  assert.deepEqual(framer.push('{"a":"b\\r"}\r\n'), ['{"a":"b\\r"}']);
});

test("skips blank keepalive lines", () => {
  const framer = new JsonlFramer();
  assert.deepEqual(framer.push('\n\n{"a":1}\n'), ['{"a":1}']);
});

test("end() flushes a record with no trailing LF", () => {
  const framer = new JsonlFramer();
  assert.deepEqual(framer.push('{"a":1}'), []);
  assert.deepEqual(framer.end(), ['{"a":1}']);
});

test("drops a record that passes the guard and resyncs after its LF", () => {
  const overflows: number[] = [];
  const framer = new JsonlFramer({ maxLineBytes: 16, onOverflow: (limit) => overflows.push(limit) });
  assert.deepEqual(framer.push('{"a":1}\n' + "x".repeat(17)), ['{"a":1}']);
  assert.deepEqual(overflows, [16]);
  assert.deepEqual(framer.push("x".repeat(40)), []);
  assert.deepEqual(framer.push('xx"}\n{"b":2}\n'), ['{"b":2}']);
  assert.deepEqual(overflows, [16]);
});

test("end() discards an oversized unterminated tail", () => {
  const framer = new JsonlFramer({ maxLineBytes: 4 });
  framer.push("xxxxxxx");
  assert.deepEqual(framer.end(), []);
});

test("encodeJsonl terminates with LF", () => {
  assert.equal(encodeJsonl({ a: 1 }), '{"a":1}\n');
});

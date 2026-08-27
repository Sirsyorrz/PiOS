import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePartialJson } from "../src/partial-json.ts";

test("nothing has arrived yet", () => {
  assert.equal(parsePartialJson(""), undefined);
  assert.equal(parsePartialJson("   "), undefined);
});

test("a complete document is parsed unchanged", () => {
  assert.deepEqual(parsePartialJson('{"path":"a.txt","n":1}'), { path: "a.txt", n: 1 });
});

test("a string value that is still being typed is kept", () => {
  assert.deepEqual(parsePartialJson('{"path": "hello.tx'), { path: "hello.tx" });
});

test("a key with no value yet is dropped", () => {
  assert.deepEqual(parsePartialJson('{"path":"a.txt","con'), { path: "a.txt" });
  assert.deepEqual(parsePartialJson('{"path":"a.txt","content":'), { path: "a.txt" });
});

test("a literal that could still grow is dropped", () => {
  assert.deepEqual(parsePartialJson('{"a":1,"b":12'), { a: 1 });
  assert.deepEqual(parsePartialJson('{"a":1,"b":tr'), { a: 1 });
  assert.deepEqual(parsePartialJson('{"a":1,"b":true,'), { a: 1, b: true });
});

test("nested containers are closed", () => {
  assert.deepEqual(parsePartialJson('{"edits":[{"oldText":"x","newText":"y'), {
    edits: [{ oldText: "x", newText: "y" }],
  });
  assert.deepEqual(parsePartialJson('{"edits":[{"oldText":"x"},'), {
    edits: [{ oldText: "x" }],
  });
});

test("a half-written escape does not break the parse", () => {
  assert.deepEqual(parsePartialJson('{"s":"a\\'), { s: "a" });
  assert.deepEqual(parsePartialJson('{"s":"a\\u00'), { s: "a" });
  assert.deepEqual(parsePartialJson('{"s":"a\\n'), { s: "a\n" });
});

test("every prefix of a real argument object renders", () => {
  const full = '{"command":"ls -la","cwd":"/tmp","timeout":30}';
  for (let i = 1; i <= full.length; i += 1) {
    assert.doesNotThrow(() => parsePartialJson(full.slice(0, i)));
  }
  assert.deepEqual(parsePartialJson(full.slice(0, full.length - 1)), {
    command: "ls -la",
    cwd: "/tmp",
  });
});

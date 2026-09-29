import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base64url,
  chunks,
  decodeFrame,
  encodeFrame,
  forwardableHeaders,
  fromBase64url,
  sendableCloseCode,
  sendableCloseReason,
  type Frame,
} from "../src/codec.ts";

test("a frame round-trips with its payload intact", () => {
  const payload = new Uint8Array([0, 1, 2, 255, 10, 13]);
  const frame: Frame = { t: "ws-msg", s: 42, text: false };
  const decoded = decodeFrame(encodeFrame(frame, payload));
  assert.deepEqual(decoded.frame, frame);
  assert.deepEqual([...decoded.payload], [...payload]);
});

test("line and paragraph separators inside a header survive", () => {
  const frame: Frame = { t: "reset", s: 1, reason: "a\u2028b\u2029c\nd" };
  assert.deepEqual(decodeFrame(encodeFrame(frame)).frame, frame);
});

test("a frame decodes from a view into a larger buffer", () => {
  const encoded = encodeFrame({ t: "end", s: 7 }, new Uint8Array([9]));
  const padded = new Uint8Array(encoded.length + 8);
  padded.set(encoded, 4);
  const view = padded.subarray(4, 4 + encoded.length);
  const decoded = decodeFrame(view);
  assert.deepEqual(decoded.frame, { t: "end", s: 7 });
  assert.deepEqual([...decoded.payload], [9]);
});

test("garbage is refused rather than half-parsed", () => {
  assert.throws(() => decodeFrame(new Uint8Array([0, 0])));
  assert.throws(() => decodeFrame(new Uint8Array([0, 0, 0, 99, 1])));
  assert.throws(() => decodeFrame(encodeFrame({ t: "nope" } as unknown as Frame)));
  assert.throws(() => decodeFrame(encodeFrame({ t: "end", s: -1 })));
  assert.throws(() => decodeFrame(encodeFrame({ t: "end", s: 1.5 })));
});

test("bodies are split into bounded chunks without loss", () => {
  const body = new Uint8Array(10).map((_, i) => i);
  const pieces = [...chunks(body, 4)];
  assert.deepEqual(pieces.map((p) => p.length), [4, 4, 2]);
  assert.deepEqual(pieces.flatMap((p) => [...p]), [...body]);
  assert.equal([...chunks(new Uint8Array(0))].length, 0);
});

test("reserved close codes are never passed to close()", () => {
  assert.equal(sendableCloseCode(1000), 1000);
  assert.equal(sendableCloseCode(4401), 4401);
  assert.equal(sendableCloseCode(1006), 1000);
  assert.equal(sendableCloseCode(1005, 1011), 1011);
  assert.equal(sendableCloseCode(undefined), 1000);
  assert.ok(new TextEncoder().encode(sendableCloseReason("\u00e9".repeat(100))).length <= 123);
});

test("hop-by-hop and edge headers stay on their own leg", () => {
  const out = forwardableHeaders([
    ["Authorization", "Bearer x"],
    ["Host", "relay.example"],
    ["Connection", "keep-alive"],
    ["CF-Connecting-IP", "1.2.3.4"],
    ["X-Forwarded-For", "1.2.3.4"],
    ["Sec-WebSocket-Key", "abc"],
    ["Content-Length", "12"],
    ["If-Match", '"etag"'],
  ]);
  assert.deepEqual(out, [
    ["authorization", "Bearer x"],
    ["if-match", '"etag"'],
  ]);
});

test("base64url round-trips every byte value", () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  const text = base64url(bytes);
  assert.doesNotMatch(text, /[+/=]/);
  assert.deepEqual([...fromBase64url(text)], [...bytes]);
});

test("headers Node's http client would throw on are dropped, not forwarded", () => {
  const out = forwardableHeaders([
    ["X-Euro", "\u20ac"],
    ["X-Replacement", "\ufffd"],
    ["X-Latin1", "caf\u00e9"],
    ["X-Newline", "a\r\nb"],
    ["Bad Name", "x"],
    ["X-Ok", "fine\tvalue"],
  ]);
  assert.deepEqual(out, [
    ["x-latin1", "caf\u00e9"],
    ["x-ok", "fine\tvalue"],
  ]);
});

test("request frames with a path that could change the authority are refused", () => {
  const req = (path: string): Frame => ({ t: "req", s: 1, method: "GET", path, headers: [] });
  assert.doesNotThrow(() => decodeFrame(encodeFrame(req("/health?x=1"))));
  for (const path of ["@evil.example/", "evil", "", "/a b", "/\u00e9"]) {
    assert.throws(() => decodeFrame(encodeFrame(req(path))), /bad path/, path);
    assert.throws(
      () => decodeFrame(encodeFrame({ t: "ws-open", s: 1, path })),
      /bad path/,
      path,
    );
  }
});

test("frames missing the fields a reader dereferences are refused", () => {
  const bad = [
    { t: "req", s: 1, method: "GE T", path: "/", headers: [] },
    { t: "req", s: 1, method: "GET", path: "/", headers: "x" },
    { t: "req", s: 1, method: "GET", path: "/", headers: [["a"]] },
    { t: "req", s: 1, method: "GET", path: "/", headers: [["a", 1]] },
    { t: "res", s: 1, status: 99, headers: [] },
    { t: "res", s: 1, status: 200 },
    { t: "ws-msg", s: 1 },
    { t: "ws-close", s: 1, code: "x", reason: "" },
    { t: "challenge", v: 1 },
  ];
  for (const frame of bad) {
    assert.throws(() => decodeFrame(encodeFrame(frame as unknown as Frame)), JSON.stringify(frame));
  }
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ServerFrame } from "@pios/protocol";
import { ImageStore } from "../src/image-store.ts";
import { hello, openSession, startHarness, type Harness } from "./helpers.ts";

const scratch = mkdtempSync(join(tmpdir(), "pios-images-"));
let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness?.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A PNG header that says `width` x `height`, padded past the inline limit. */
function bigPng(width: number, height: number): string {
  const header = Buffer.alloc(24);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(64 * 1024, 7)]).toString("base64");
}

test("a large image becomes a name, a size, and bytes on disk", () => {
  const store = new ImageStore(join(scratch, "a"));
  const data = bigPng(800, 450);
  const message = { role: "toolResult", content: [{ type: "text", text: "ok" }, { type: "image", mimeType: "image/png", data }] };
  const out = store.externalize(message);

  const image = out.content[1] as unknown as { data: string; ref: string; width: number; height: number };
  assert.equal(image.data, "");
  assert.match(image.ref, /^[0-9a-f]{64}\.png$/);
  assert.equal(image.width, 800);
  assert.equal(image.height, 450);
  assert.equal(readFileSync(store.path(image.ref)!).toString("base64"), data);
  // Copy on write: the source keeps its bytes, untouched branches are shared.
  assert.equal((message.content[1] as { data: string }).data, data);
  assert.equal(out.content[0], message.content[0]);
});

test("small images and image-free values pass through as they are", () => {
  const store = new ImageStore(join(scratch, "b"));
  const tiny = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
  const plain = { role: "assistant", content: [{ type: "text", text: "hi" }] };
  assert.equal(store.externalize(tiny), tiny);
  assert.equal(store.externalize(plain), plain);
});

test("one source object is rewritten once, however often it is sent", () => {
  const store = new ImageStore(join(scratch, "c"));
  const event = { type: "message_end", message: { content: [{ type: "image", mimeType: "image/png", data: bigPng(1, 1) }] } };
  assert.equal(store.externalize(event), store.externalize(event));
});

test("only names the store mints resolve to a path", () => {
  const store = new ImageStore(join(scratch, "d"));
  for (const name of ["../auth.json", "x.png", `${"a".repeat(64)}.png/../../x`, `${"a".repeat(64)}.svg`]) {
    assert.equal(store.path(name), null, name);
  }
});

test("a turn's images reach the client by name, and the bytes by /image", async () => {
  const client = await hello(harness);
  const cwd = join(harness.dir, "images");
  mkdirSync(cwd, { recursive: true });
  const sessionId = await openSession(harness, cwd);
  await client.waitForCommand(client.send({ type: "subscribe", sessionId }));
  client.send({ type: "prompt", sessionId, messageId: "m1", text: "IMAGE_TOOLS please", images: [] });
  await client.waitFor(
    (f) => f.type === "agent_event" && f.sessionId === sessionId && f.event.type === "agent_settled",
    20_000,
  );

  // Nothing on the wire carries the bytes, live or from history.
  const entries = await client.waitForCommand(client.send({ type: "get_entries", sessionId }));
  const frames: ServerFrame[] = [...client.received.filter((f) => f.type === "agent_event"), entries];
  for (const frame of frames) assert.ok(JSON.stringify(frame).length < 16 * 1024, frame.type);

  const ref = JSON.stringify(entries).match(/"ref":"([0-9a-f]{64}\.png)"/)?.[1];
  assert.ok(ref, "an entry names its image");
  const url = `${harness.baseUrl}/image?name=${ref}`;
  assert.equal((await fetch(url)).status, 401);
  const served = await fetch(url, { headers: { authorization: `Bearer ${harness.deviceToken}` } });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await served.arrayBuffer());
  assert.deepEqual([...bytes.subarray(1, 4)], [...Buffer.from("PNG")]);
  const missing = await fetch(`${harness.baseUrl}/image?name=../auth.json`, {
    headers: { authorization: `Bearer ${harness.deviceToken}` },
  });
  assert.equal(missing.status, 404);
  client.close();
});


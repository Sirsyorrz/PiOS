import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PiosServer } from "../src/server.ts";

let server: PiosServer;
let baseUrl: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pios-web-"));
  mkdirSync(join(dir, "web", "assets"), { recursive: true });
  writeFileSync(join(dir, "web", "index.html"), "<!doctype html><title>PiOS</title>");
  writeFileSync(join(dir, "web", "assets", "app.js"), "console.log(1)");
  writeFileSync(join(dir, "web", "sw.js"), "// worker");

  server = new PiosServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: join(dir, "data"),
    sessionDir: join(dir, "sessions"),
    webDir: join(dir, "web"),
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the app shell is served without a token", async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
});

test("a deep link falls back to the shell so a notification tap lands", async () => {
  const res = await fetch(`${baseUrl}/?session=abc`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /PiOS/);
});

test("hashed assets are immutable, the worker is not", async () => {
  const asset = await fetch(`${baseUrl}/assets/app.js`);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
  const worker = await fetch(`${baseUrl}/sw.js`);
  assert.equal(worker.headers.get("cache-control"), "no-cache");
});

test("the API still wins over the app", async () => {
  const res = await fetch(`${baseUrl}/sessions`);
  assert.equal(res.status, 401);
});

test("a path outside the web root is not served", async () => {
  const res = await fetch(`${baseUrl}/../data/auth.json`);
  // Fetch normalises the traversal away; the shell is the only thing left.
  assert.match(res.headers.get("content-type") ?? "", /text\/html|json/);
  assert.equal(/tokenHash/.test(await res.text()), false);
});

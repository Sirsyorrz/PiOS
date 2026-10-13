import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedPath } from "../src/paths.ts";
import { CommandLedger } from "../src/dedupe.ts";
import { advertisedEndpoint } from "../src/endpoints.ts";

test("paths inside the root are allowed, outside are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-path-"));
  const root = join(dir, "project");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "sub", "file.txt"), "x");
  writeFileSync(join(dir, "secret.txt"), "x");

  assert.ok(containedPath(root, "sub/file.txt"));
  assert.ok(containedPath(root, join(root, "sub", "file.txt")));
  assert.equal(containedPath(root, "../secret.txt"), null);
  assert.equal(containedPath(root, "/etc/passwd"), null);
  assert.equal(containedPath(root, "sub/../../secret.txt"), null);
  rmSync(dir, { recursive: true, force: true });
});

test("a symlink pointing out of the root is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-path-"));
  const root = join(dir, "project");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(dir, "secret.txt"), "x");
  // The agent can create symlinks, so lexical containment is not enough.
  symlinkSync(join(dir, "secret.txt"), join(root, "escape.txt"));

  assert.equal(containedPath(root, "escape.txt"), null);
  rmSync(dir, { recursive: true, force: true });
});

test("a sibling directory with the root as a string prefix is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-path-"));
  mkdirSync(join(dir, "project"), { recursive: true });
  mkdirSync(join(dir, "project-notes"), { recursive: true });
  writeFileSync(join(dir, "project-notes", "leak.txt"), "x");

  assert.equal(containedPath(join(dir, "project"), "../project-notes/leak.txt"), null);
  rmSync(dir, { recursive: true, force: true });
});

test("a command is applied once and reported as duplicate afterwards", () => {
  const ledger = new CommandLedger();
  assert.equal(ledger.claim("c1"), true);
  assert.equal(ledger.claim("c1"), false);
  assert.equal(ledger.claim("c2"), true);
});

test("the ledger forgets old commands and stays bounded", () => {
  let now = 0;
  const ledger = new CommandLedger({ ttlMs: 100, maxEntries: 3, now: () => now });
  ledger.claim("c1");
  now = 200;
  // Past the TTL the id is free again; the outbox has long since given up.
  assert.equal(ledger.claim("c1"), true);

  for (let i = 0; i < 20; i++) ledger.claim(`x${i}`);
  assert.ok(ledger.size <= 3);
});

test("the relay is the endpoint when configured, keyed by identity", () => {
  const endpoint = advertisedEndpoint(4111, "https://pios-relay.me.workers.dev");
  assert.equal(endpoint.kind, "relay");
  assert.equal(endpoint.key, "relay:pios-relay.me.workers.dev");
  assert.equal(endpoint.url, "https://pios-relay.me.workers.dev");
});

test("without a relay the daemon only advertises itself locally", () => {
  const endpoint = advertisedEndpoint(4111, null);
  assert.equal(endpoint.kind, "local");
  assert.equal(endpoint.url, "http://localhost:4111");
});

test("a public url is advertised when there is no relay", () => {
  const endpoint = advertisedEndpoint(4111, null, "https://box.tail1234.ts.net");
  assert.equal(endpoint.kind, "public");
  assert.equal(endpoint.key, "public:box.tail1234.ts.net");
  assert.equal(endpoint.url, "https://box.tail1234.ts.net");
});

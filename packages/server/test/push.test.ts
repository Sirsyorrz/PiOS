import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { PushStore } from "../src/push.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pios-push-"));
  dirs.push(dir);
  return join(dir, "push.json");
}

const subscription = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
});

test("mints VAPID keys once and keeps them across restarts", () => {
  const path = storePath();
  const first = new PushStore(path);
  assert.ok(first.publicKey.length > 0);
  assert.equal(new PushStore(path).publicKey, first.publicKey);
});

test("the store is not world readable", () => {
  const path = storePath();
  new PushStore(path);
  assert.equal(statSync(path).mode & 0o077, 0);
});

test("re-subscribing the same endpoint replaces the record", () => {
  const store = new PushStore(storePath());
  store.subscribe("device-a", subscription("https://push.example/1"));
  store.subscribe("device-a", subscription("https://push.example/1"));
  store.subscribe("device-b", subscription("https://push.example/2"));
  assert.equal(store.list().length, 2);
});

test("revoking a device removes its subscriptions", () => {
  const path = storePath();
  const store = new PushStore(path);
  store.subscribe("device-a", subscription("https://push.example/1"));
  store.subscribe("device-b", subscription("https://push.example/2"));

  store.removeDevice("device-a");
  assert.deepEqual(
    new PushStore(path).list().map((s) => s.deviceId),
    ["device-b"],
  );
});

test("unsubscribe reports whether anything was held", () => {
  const store = new PushStore(storePath());
  store.subscribe("device-a", subscription("https://push.example/1"));
  assert.equal(store.unsubscribe("https://push.example/1"), true);
  assert.equal(store.unsubscribe("https://push.example/1"), false);
});

test("a dead endpoint is dropped rather than retried forever", async () => {
  const store = new PushStore(storePath());
  // Not a real push service: every send fails with a DNS error, which is
  // transient as far as the store knows.
  store.subscribe("device-a", subscription("https://push.invalid/1"));
  for (let i = 0; i < 5; i += 1) {
    await store.send({ title: "t", body: "b", url: "/", tag: "x" });
  }
  assert.equal(store.list().length, 0);
});

test("the VAPID subject is an address a push service will accept", () => {
  // Apple rejects a mailto at an unresolvable domain with BadJwtToken, and it
  // fails every send identically, so the default is checked here.
  const fallback = defaultConfig({ publicUrl: null }).pushSubject;
  assert.match(fallback, /^https:\/\//);
  assert.equal(
    defaultConfig({ publicUrl: "https://box.ts.net" }).pushSubject,
    "https://box.ts.net",
  );
});

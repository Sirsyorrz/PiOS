import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, bearerToken } from "../src/auth.ts";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "pios-auth-"));
  return { dir, auth: new AuthStore(join(dir, "auth.json")), path: join(dir, "auth.json") };
}

test("a pairing token is exchanged for a device token exactly once", () => {
  const { dir, auth } = store();
  const { token } = auth.createPairing();

  const first = auth.redeemPairing(token, "phone");
  assert.ok(first);
  assert.ok(auth.verify(first.deviceToken));

  // Replaying the pairing URL must not mint a second device.
  assert.equal(auth.redeemPairing(token, "attacker"), null);
  assert.equal(auth.listDevices().length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("an expired pairing token is refused", () => {
  const { dir, auth } = store();
  const now = Date.now();
  const { token } = auth.createPairing(now);
  assert.equal(auth.redeemPairing(token, "late", now + 11 * 60 * 1000), null);
  rmSync(dir, { recursive: true, force: true });
});

test("no token is ever written in the clear", () => {
  const { dir, auth, path } = store();
  const { token, code } = auth.createPairing();
  const paired = auth.redeemPairing(token, "phone")!;

  const contents = readFileSync(path, "utf8");
  assert.ok(!contents.includes(paired.deviceToken), "device token is stored hashed");
  assert.ok(!contents.includes(token), "pairing token is stored hashed");
  assert.ok(code.length === 6);
  // The store is a shell for whoever reads it.
  assert.equal(statSync(path).mode & 0o777, 0o600);
  rmSync(dir, { recursive: true, force: true });
});

test("verification survives a restart and rejects garbage", () => {
  const { dir, auth, path } = store();
  const { token } = auth.createPairing();
  const paired = auth.redeemPairing(token, "phone")!;

  const reopened = new AuthStore(path);
  assert.equal(reopened.verify(paired.deviceToken)?.id, paired.device.id);
  assert.equal(reopened.verify("not-a-token"), null);
  assert.equal(reopened.verify(undefined), null);
  assert.equal(reopened.verify(""), null);
  rmSync(dir, { recursive: true, force: true });
});

test("revoking a device invalidates its token immediately", () => {
  const { dir, auth } = store();
  const { token } = auth.createPairing();
  const paired = auth.redeemPairing(token, "phone")!;

  assert.equal(auth.revoke(paired.device.id), true);
  assert.equal(auth.verify(paired.deviceToken), null);
  assert.equal(auth.revoke(paired.device.id), false);
  rmSync(dir, { recursive: true, force: true });
});

test("bearerToken parses only a well-formed header", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer abc"), undefined);
  assert.equal(bearerToken("abc"), undefined);
  assert.equal(bearerToken(undefined), undefined);
});

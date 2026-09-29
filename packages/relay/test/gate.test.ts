import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { base64url, RELAY_PROTOCOL_VERSION } from "../src/codec.ts";
import {
  challengeMessage,
  decideHost,
  newNonce,
  parseHostRecord,
  type HostRecord,
} from "../src/gate.ts";

const SECRET = "s".repeat(40);
const ROTATED = "r".repeat(40);

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "jwk" }).x!;
  return {
    publicKey: pub,
    hello(nonce: string, enrollSecret?: string) {
      return {
        t: "hello" as const,
        v: RELAY_PROTOCOL_VERSION,
        publicKey: pub,
        signature: base64url(sign(null, challengeMessage(nonce), privateKey)),
        ...(enrollSecret === undefined ? {} : { enrollSecret }),
      };
    },
  };
}

async function enroll(key: ReturnType<typeof makeKey>, secret = SECRET, record: HostRecord | null = null) {
  const nonce = newNonce();
  const decision = await decideHost({ record, enrollSecret: secret, hello: key.hello(nonce, secret), nonce });
  assert.equal(decision.kind, "enroll");
  return (decision as { record: HostRecord }).record;
}

test("first enrollment binds the key and stores only a hash of the secret", async () => {
  const key = makeKey();
  const record = await enroll(key);
  assert.equal(record.publicKey, key.publicKey);
  assert.doesNotMatch(record.enrolledSecretHash, new RegExp(SECRET));
  assert.equal(record.enrolledSecretHash.length, 64);
});

test("an enrolled key gets in by signature alone", async () => {
  const key = makeKey();
  const record = await enroll(key);
  const nonce = newNonce();
  const decision = await decideHost({ record, enrollSecret: SECRET, hello: key.hello(nonce), nonce });
  assert.deepEqual(decision, { kind: "accept" });
});

test("a signature over another nonce is refused", async () => {
  const key = makeKey();
  const record = await enroll(key);
  const decision = await decideHost({
    record,
    enrollSecret: SECRET,
    hello: key.hello(newNonce()),
    nonce: newNonce(),
  });
  assert.deepEqual(decision, { kind: "reject", reason: "bad_signature" });
});

test("a signature by another key over the claimed public key is refused", async () => {
  const owner = makeKey();
  const thief = makeKey();
  const record = await enroll(owner);
  const nonce = newNonce();
  const forged = { ...thief.hello(nonce), publicKey: owner.publicKey };
  const decision = await decideHost({ record, enrollSecret: SECRET, hello: forged, nonce });
  assert.deepEqual(decision, { kind: "reject", reason: "bad_signature" });
});

test("a different key without the secret cannot take the slot", async () => {
  const record = await enroll(makeKey());
  const other = makeKey();
  const nonce = newNonce();
  const decision = await decideHost({ record, enrollSecret: SECRET, hello: other.hello(nonce), nonce });
  assert.deepEqual(decision, { kind: "reject", reason: "key_mismatch" });
});

test("a spent secret cannot enroll a second key", async () => {
  const record = await enroll(makeKey());
  const other = makeKey();
  const nonce = newNonce();
  const decision = await decideHost({
    record,
    enrollSecret: SECRET,
    hello: other.hello(nonce, SECRET),
    nonce,
  });
  assert.deepEqual(decision, { kind: "reject", reason: "enroll_closed" });
});

test("re-enrolling the same key with the spent secret is harmless", async () => {
  const key = makeKey();
  const record = await enroll(key);
  const again = await enroll(key, SECRET, record);
  assert.deepEqual(again, record);
});

test("rotating the secret lets a new key in and replaces the old one", async () => {
  const first = makeKey();
  const record = await enroll(first);
  const second = makeKey();
  const next = await enroll(second, ROTATED, record);
  assert.equal(next.publicKey, second.publicKey);

  const nonce = newNonce();
  const old = await decideHost({ record: next, enrollSecret: ROTATED, hello: first.hello(nonce), nonce });
  assert.deepEqual(old, { kind: "reject", reason: "key_mismatch" });
});

test("rotation alone does not lock out the enrolled key", async () => {
  const key = makeKey();
  const record = await enroll(key);
  const nonce = newNonce();
  const decision = await decideHost({ record, enrollSecret: ROTATED, hello: key.hello(nonce), nonce });
  assert.deepEqual(decision, { kind: "accept" });
});

test("a wrong secret, a short secret, or none configured never enrolls", async () => {
  const key = makeKey();
  const cases: [string | undefined, string, string][] = [
    [SECRET, ROTATED, "enroll_secret_invalid"],
    ["short", "short", "enroll_closed"],
    [undefined, SECRET, "enroll_closed"],
    ["", "", "enroll_closed"],
  ];
  for (const [configured, presented, reason] of cases) {
    const nonce = newNonce();
    const decision = await decideHost({
      record: null,
      enrollSecret: configured,
      hello: key.hello(nonce, presented),
      nonce,
    });
    assert.deepEqual(decision, { kind: "reject", reason }, `${configured} / ${presented}`);
  }
});

test("nothing gets in before enrollment", async () => {
  const key = makeKey();
  const nonce = newNonce();
  const decision = await decideHost({ record: null, enrollSecret: SECRET, hello: key.hello(nonce), nonce });
  assert.deepEqual(decision, { kind: "reject", reason: "not_enrolled" });
});

test("another protocol version is refused before anything else", async () => {
  const key = makeKey();
  const record = await enroll(key);
  const nonce = newNonce();
  const hello = { ...key.hello(nonce), v: RELAY_PROTOCOL_VERSION + 1 };
  const decision = await decideHost({ record, enrollSecret: SECRET, hello, nonce });
  assert.deepEqual(decision, { kind: "reject", reason: "version_mismatch" });
});

test("malformed keys and signatures are refused, not thrown", async () => {
  const nonce = newNonce();
  for (const hello of [
    { t: "hello" as const, v: RELAY_PROTOCOL_VERSION, publicKey: "!!", signature: "??" },
    { t: "hello" as const, v: RELAY_PROTOCOL_VERSION, publicKey: base64url(new Uint8Array(5)), signature: "" },
  ]) {
    const decision = await decideHost({ record: null, enrollSecret: SECRET, hello, nonce });
    assert.equal(decision.kind, "reject");
  }
});

test("stored records of an unknown version are not trusted", () => {
  assert.equal(parseHostRecord(null), null);
  assert.equal(parseHostRecord({ version: 99, publicKey: "x", enrolledSecretHash: "y" }), null);
  assert.ok(parseHostRecord({ version: 1, publicKey: "x", enrolledSecretHash: "y", enrolledAt: 1 }));
});

import { base64url, fromBase64url, RELAY_PROTOCOL_VERSION, type Frame, type RejectReason } from "./codec.ts";

/**
 * Who may hold the relay's host slot.
 *
 * The host receives every phone request, device tokens included, so holding
 * the slot is as good as holding a shell. A shared secret alone would make
 * one leak permanent. Instead the enrollment secret is spent on binding an
 * Ed25519 key, and from then on only a signature over a fresh nonce gets in.
 *
 * A new host needs a new secret: enrollment reopens only when the configured
 * secret differs from the one that enrolled the current key.
 *
 * Platform-free: WebCrypto only, so the Worker and the tests run the same code.
 */

export const HOST_RECORD_VERSION = 1;

/** Short secrets are refused outright; this one guards a shell. */
export const MIN_ENROLL_SECRET_LENGTH = 32;

export interface HostRecord {
  version: number;
  /** Raw Ed25519 public key, base64url. */
  publicKey: string;
  /** SHA-256 of the secret that enrolled this key, hex. */
  enrolledSecretHash: string;
  enrolledAt: number;
}

export type HostDecision =
  | { kind: "accept" }
  | { kind: "enroll"; record: HostRecord }
  | { kind: "reject"; reason: RejectReason };

type Hello = Extract<Frame, { t: "hello" }>;

export function newNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Domain-separated so a signature made here means nothing anywhere else. */
export function challengeMessage(nonce: string): Uint8Array {
  return new TextEncoder().encode(`pios-relay-host:v${RELAY_PROTOCOL_VERSION}:${nonce}`);
}

export async function decideHost(input: {
  record: HostRecord | null;
  /** The Worker's configured `ENROLL_SECRET`, if any. */
  enrollSecret: string | undefined;
  hello: Hello;
  nonce: string;
  now?: number;
}): Promise<HostDecision> {
  const { record, hello } = input;
  if (hello.v !== RELAY_PROTOCOL_VERSION) return reject("version_mismatch");
  if (typeof hello.publicKey !== "string" || typeof hello.signature !== "string") {
    return reject("malformed");
  }
  if (!(await verify(hello.publicKey, hello.signature, challengeMessage(input.nonce)))) {
    return reject("bad_signature");
  }

  if (hello.enrollSecret === undefined) {
    if (!record) return reject("not_enrolled");
    return record.publicKey === hello.publicKey ? { kind: "accept" } : reject("key_mismatch");
  }

  const configured = input.enrollSecret ?? "";
  if (configured.length < MIN_ENROLL_SECRET_LENGTH) return reject("enroll_closed");
  const configuredHash = await sha256Hex(configured);
  if (!constantTimeEqual(await sha256Hex(String(hello.enrollSecret)), configuredHash)) {
    return reject("enroll_secret_invalid");
  }
  if (record && constantTimeEqual(record.enrolledSecretHash, configuredHash)) {
    // The secret is spent. Re-running enroll with the same key is harmless
    // and idempotent; anything else needs a rotated secret.
    return record.publicKey === hello.publicKey ? { kind: "enroll", record } : reject("enroll_closed");
  }
  return {
    kind: "enroll",
    record: {
      version: HOST_RECORD_VERSION,
      publicKey: hello.publicKey,
      enrolledSecretHash: configuredHash,
      enrolledAt: input.now ?? Date.now(),
    },
  };
}

/** Reads a stored record, dropping anything this version cannot vouch for. */
export function parseHostRecord(value: unknown): HostRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<HostRecord>;
  if (record.version !== HOST_RECORD_VERSION) return null;
  if (typeof record.publicKey !== "string" || typeof record.enrolledSecretHash !== "string") {
    return null;
  }
  return record as HostRecord;
}

function reject(reason: RejectReason): HostDecision {
  return { kind: "reject", reason };
}

async function verify(publicKey: string, signature: string, message: Uint8Array): Promise<boolean> {
  try {
    const raw = fromBase64url(publicKey);
    if (raw.length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64url(signature), message);
  } catch {
    return false;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

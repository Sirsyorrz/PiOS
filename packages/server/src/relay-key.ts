import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { dirname } from "node:path";
import { challengeMessage } from "@pios/relay/gate";
import { base64url } from "@pios/relay/codec";

/**
 * The daemon's identity at the relay.
 *
 * Whoever holds this key holds the relay's host slot, and with it every
 * phone request, so it is treated like the auth store: 0600, never logged.
 */

const KEY_FILE_VERSION = 1;

interface KeyFile {
  version: number;
  /** Raw Ed25519 public key, base64url. */
  publicKey: string;
  /** PKCS#8 DER, base64url. */
  privateKey: string;
  /**
   * When the relay last accepted this key. Separates "never enrolled" from
   * "was enrolled and got replaced", which is the case worth an alarm.
   */
  acceptedAt: number | null;
}

export class RelayKey {
  private readonly path: string;
  private data: KeyFile;
  private readonly privateKey: KeyObject;

  private constructor(path: string, data: KeyFile) {
    this.path = path;
    this.data = data;
    this.privateKey = createPrivateKey({
      key: Buffer.from(data.privateKey, "base64url"),
      format: "der",
      type: "pkcs8",
    });
  }

  static loadOrCreate(path: string): RelayKey {
    const existing = load(path);
    if (existing) return new RelayKey(path, existing);

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" });
    if (!jwk.x) throw new Error("ed25519 key export produced no public key");
    const key = new RelayKey(path, {
      version: KEY_FILE_VERSION,
      publicKey: jwk.x,
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
      acceptedAt: null,
    });
    key.persist();
    return key;
  }

  get publicKey(): string {
    return this.data.publicKey;
  }

  get acceptedAt(): number | null {
    return this.data.acceptedAt;
  }

  signChallenge(nonce: string): string {
    return base64url(sign(null, challengeMessage(nonce), this.privateKey));
  }

  markAccepted(now = Date.now()): void {
    this.data = { ...this.data, acceptedAt: now };
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

function load(path: string): KeyFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as KeyFile;
  // Never silently regenerated: a new key would lock this daemon out of a
  // relay it is enrolled at, and the user would not know why.
  if (parsed.version !== KEY_FILE_VERSION) {
    throw new Error(`unsupported relay key version ${parsed.version} in ${path}`);
  }
  return parsed;
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { writePrivateJson } from "./private-file.ts";

/**
 * Token store for the daemon.
 *
 * The daemon runs arbitrary code as the user, so a leaked token is a shell.
 * Tokens are therefore only ever held hashed on disk, compared in constant
 * time, and pairing tokens are single-use with a short life.
 */

export const DEVICE_TOKEN_BYTES = 32;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const STORE_VERSION = 1;

export interface DeviceRecord {
  id: string;
  label: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
}

interface PairingRecord {
  tokenHash: string;
  /** Shown on both ends so the user can confirm they paired with this machine. */
  code: string;
  expiresAt: number;
}

interface StoreFile {
  version: number;
  devices: DeviceRecord[];
  pairings: PairingRecord[];
}

export class AuthStore {
  private readonly path: string;
  private data: StoreFile;
  private mtimeMs = 0;

  constructor(path: string) {
    this.path = path;
    this.data = load(path);
    this.mtimeMs = mtimeOf(path);
  }

  /**
   * Picks up changes written by another process.
   *
   * `pios-server pair` and `revoke` run as separate short-lived processes
   * while the daemon holds the file open. Without this, a pairing minted by
   * the CLI would be invisible to the running daemon, and a revoked token
   * would keep working until a restart.
   */
  private refresh(): void {
    const mtime = mtimeOf(this.path);
    if (mtime === this.mtimeMs) return;
    this.data = load(this.path);
    this.mtimeMs = mtime;
  }

  /** Mints a pairing token. Returned in clear once; only the hash is kept. */
  createPairing(now = Date.now()): { token: string; code: string; expiresAt: number } {
    this.refresh();
    const token = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
    const code = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, "0");
    const expiresAt = now + PAIRING_TTL_MS;
    this.data.pairings = this.data.pairings.filter((p) => p.expiresAt > now);
    this.data.pairings.push({ tokenHash: hash(token), code, expiresAt });
    this.persist();
    return { token, code, expiresAt };
  }

  /**
   * Trades a pairing token for a long-lived device token.
   *
   * Single use: the pairing record is consumed whether or not the caller ever
   * stores the result, so a replayed URL cannot mint a second device.
   */
  redeemPairing(
    token: string,
    label: string,
    now = Date.now(),
  ): { deviceToken: string; device: DeviceRecord } | null {
    this.refresh();
    const tokenHash = hash(token);
    const index = this.data.pairings.findIndex(
      (p) => p.expiresAt > now && constantTimeEqual(p.tokenHash, tokenHash),
    );
    if (index === -1) return null;
    this.data.pairings.splice(index, 1);

    const deviceToken = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
    const device: DeviceRecord = {
      id: randomBytes(8).toString("hex"),
      label,
      tokenHash: hash(deviceToken),
      createdAt: now,
      lastSeenAt: now,
    };
    this.data.devices.push(device);
    this.persist();
    return { deviceToken, device };
  }

  /** Returns the device a token belongs to, or null. Never throws on garbage. */
  verify(token: string | undefined, now = Date.now()): DeviceRecord | null {
    if (!token) return null;
    this.refresh();
    const tokenHash = hash(token);
    const device = this.data.devices.find((d) => constantTimeEqual(d.tokenHash, tokenHash));
    if (!device) return null;
    device.lastSeenAt = now;
    this.persist();
    return device;
  }

  revoke(deviceId: string): boolean {
    this.refresh();
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== deviceId);
    if (this.data.devices.length === before) return false;
    this.persist();
    return true;
  }

  /**
   * Revokes every device and drops unredeemed pairings.
   *
   * Pairings go too: a pending pairing URL is a pending device, so leaving one
   * alive would defeat the point of a full lockout.
   */
  revokeAll(): string[] {
    this.refresh();
    const ids = this.data.devices.map((d) => d.id);
    this.data.devices = [];
    this.data.pairings = [];
    this.persist();
    return ids;
  }

  listDevices(): Omit<DeviceRecord, "tokenHash">[] {
    this.refresh();
    return this.data.devices.map(({ tokenHash: _hash, ...rest }) => rest);
  }

  pendingPairings(now = Date.now()): number {
    return this.data.pairings.filter((p) => p.expiresAt > now).length;
  }

  private persist(): void {
    writePrivateJson(this.path, this.data);
    this.mtimeMs = mtimeOf(this.path);
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function load(path: string): StoreFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoreFile;
    if (parsed.version !== STORE_VERSION) {
      throw new Error(`unsupported auth store version ${parsed.version}`);
    }
    return { version: STORE_VERSION, devices: parsed.devices ?? [], pairings: parsed.pairings ?? [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, devices: [], pairings: [] };
    }
    if (error instanceof SyntaxError) {
      return { version: STORE_VERSION, devices: [], pairings: [] };
    }
    throw error;
  }
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Reads a bearer token from a request header. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1];
}

/**
 * Wire format between the relay and the daemon's connector.
 *
 * One WebSocket carries every phone request and phone socket as numbered
 * streams. Each message is binary: a 4-byte big-endian header length, a JSON
 * header, then raw payload bytes. Bodies stay binary so an image is never
 * base64-inflated, and the header stays JSON so a new field needs no codec
 * change.
 *
 * Keepalive is the text message "ping", answered with "pong". It is the only
 * text on the socket, which is what lets the relay answer it without waking.
 *
 * Platform-free: runs in the Worker and in Node.
 */

export const RELAY_PROTOCOL_VERSION = 1;

/** Where the daemon dials in. Never forwarded to the daemon. */
export const HOST_PATH = "/_pios/host";

/**
 * Close code for phone sockets while no daemon is connected. Not an auth
 * code, so the client's supervisor treats it as transient and backs off.
 */
export const HOST_OFFLINE_CLOSE_CODE = 4503;
export const HOST_OFFLINE_HEADER = "x-pios-relay";

export const PING = "ping";
export const PONG = "pong";

/**
 * Payload bytes per message. Workers cap WebSocket messages, and small chunks
 * keep one large download from starving every other stream.
 */
export const MAX_CHUNK = 256 * 1024;

export type RejectReason =
  | "version_mismatch"
  | "malformed"
  | "bad_signature"
  | "not_enrolled"
  | "key_mismatch"
  | "enroll_closed"
  | "enroll_secret_invalid";

export type Frame =
  | { t: "challenge"; v: number; nonce: string }
  | { t: "hello"; v: number; publicKey: string; signature: string; enrollSecret?: string }
  | { t: "ready" }
  | { t: "enrolled" }
  | { t: "rejected"; reason: RejectReason }
  | { t: "req"; s: number; method: string; path: string; headers: [string, string][] }
  | { t: "res"; s: number; status: number; headers: [string, string][] }
  | { t: "data"; s: number }
  | { t: "end"; s: number }
  | { t: "reset"; s: number; reason?: string }
  | { t: "ws-open"; s: number; path: string }
  | { t: "ws-msg"; s: number; text: boolean }
  | { t: "ws-close"; s: number; code: number; reason: string };

export interface Decoded {
  frame: Frame;
  payload: Uint8Array;
}

const FRAME_TYPES = new Set<Frame["t"]>([
  "challenge",
  "hello",
  "ready",
  "enrolled",
  "rejected",
  "req",
  "res",
  "data",
  "end",
  "reset",
  "ws-open",
  "ws-msg",
  "ws-close",
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

export function encodeFrame(frame: Frame, payload: Uint8Array = EMPTY): Uint8Array {
  const header = encoder.encode(JSON.stringify(frame));
  const out = new Uint8Array(4 + header.length + payload.length);
  new DataView(out.buffer).setUint32(0, header.length);
  out.set(header, 4);
  out.set(payload, 4 + header.length);
  return out;
}

/** Throws on anything malformed: a peer that sends garbage gets dropped. */
export function decodeFrame(message: ArrayBuffer | Uint8Array): Decoded {
  const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
  if (bytes.length < 4) throw new Error("frame too short");
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (4 + headerLength > bytes.length) throw new Error("frame header overruns message");
  const frame = JSON.parse(decoder.decode(bytes.subarray(4, 4 + headerLength))) as Frame;
  if (!frame || typeof frame !== "object" || !FRAME_TYPES.has(frame.t)) {
    throw new Error("unknown frame type");
  }
  if ("s" in frame && (!Number.isInteger(frame.s) || frame.s < 0)) {
    throw new Error("bad stream id");
  }
  return { frame, payload: bytes.subarray(4 + headerLength) };
}

/** Splits a body into payload-sized pieces without copying. */
export function* chunks(bytes: Uint8Array, size = MAX_CHUNK): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

/**
 * Close codes a peer may actually send. 1005 and 1006 are reserved for
 * "no code" and "abnormal", and passing one to `close()` throws.
 */
export function sendableCloseCode(code: number | undefined, fallback = 1000): number {
  if (code === 1000 || (code !== undefined && code >= 3000 && code <= 4999)) return code;
  return fallback;
}

/** Close reasons are capped at 123 bytes by the WebSocket spec. */
export function sendableCloseReason(reason: string | undefined): string {
  if (!reason) return "";
  let out = reason;
  while (encoder.encode(out).length > 123) out = out.slice(0, -1);
  return out;
}

/**
 * Hop-by-hop and edge headers. They describe one leg of the trip, so passing
 * them on would describe the wrong leg, or let a phone spoof the relay's own.
 */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "x-real-ip",
]);

export function forwardableHeaders(headers: Iterable<[string, string]>): [string, string][] {
  const out: [string, string][] = [];
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (HOP_HEADERS.has(name)) continue;
    if (name.startsWith("cf-") || name.startsWith("x-forwarded-")) continue;
    if (name.startsWith("sec-websocket-")) continue;
    out.push([name, value]);
  }
  return out;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

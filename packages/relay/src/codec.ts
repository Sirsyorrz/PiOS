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

/**
 * Largest request body the relay carries. Above the daemon's default upload
 * limit, and far enough below the Durable Object's memory that a few
 * concurrent bodies cannot take it down.
 */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

export type RejectReason =
  | "version_mismatch"
  | "malformed"
  | "bad_signature"
  | "not_enrolled"
  | "key_mismatch"
  | "enroll_closed"
  | "enroll_secret_invalid"
  | "host_record_unreadable";

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
  checkFields(frame);
  return { frame, payload: bytes.subarray(4 + headerLength) };
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Header values Node's http client accepts; anything else throws there. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
/**
 * Origin-relative and printable ASCII, which is all a parsed URL yields. A
 * path not starting with "/" would change the authority once the connector
 * prefixes it with its own host.
 */
const REQUEST_PATH = /^\/[\x21-\x7e]*$/;

/**
 * The fields each side dereferences. Whoever feeds the other end, a throw
 * here drops one frame instead of crashing the process that reads it.
 */
function checkFields(frame: Frame): void {
  switch (frame.t) {
    case "req":
      if (typeof frame.method !== "string" || !TOKEN.test(frame.method)) throw new Error("bad method");
      checkPath(frame.path);
      checkHeaderList(frame.headers);
      return;
    case "res":
      if (!Number.isInteger(frame.status) || frame.status < 100 || frame.status > 599) {
        throw new Error("bad status");
      }
      checkHeaderList(frame.headers);
      return;
    case "ws-open":
      checkPath(frame.path);
      return;
    case "ws-msg":
      if (typeof frame.text !== "boolean") throw new Error("bad ws-msg");
      return;
    case "ws-close":
      if (typeof frame.code !== "number" || typeof frame.reason !== "string") {
        throw new Error("bad ws-close");
      }
      return;
    case "challenge":
      if (typeof frame.nonce !== "string") throw new Error("bad challenge");
      return;
    default:
      return;
  }
}

function checkPath(path: unknown): void {
  if (typeof path !== "string" || !REQUEST_PATH.test(path)) throw new Error("bad path");
}

function checkHeaderList(headers: unknown): void {
  const ok =
    Array.isArray(headers) &&
    headers.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string",
    );
  if (!ok) throw new Error("bad headers");
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

/**
 * Also drops any header Node would refuse to send: the edge accepts bytes
 * Node's http client throws on, and one such header must not cost the stream.
 */
export function forwardableHeaders(headers: Iterable<[string, string]>): [string, string][] {
  const out: [string, string][] = [];
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (!TOKEN.test(name) || !HEADER_VALUE.test(value)) continue;
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

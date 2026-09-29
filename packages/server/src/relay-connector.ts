import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { WebSocket, type RawData } from "ws";
import {
  chunks,
  decodeFrame,
  encodeFrame,
  forwardableHeaders,
  HOST_PATH,
  PING,
  RELAY_PROTOCOL_VERSION,
  sendableCloseCode,
  sendableCloseReason,
  type Frame,
  type RejectReason,
} from "@pios/relay/codec";
import type { RelayKey } from "./relay-key.ts";

/**
 * The daemon's outbound leg to the relay.
 *
 * Holds one WebSocket to the relay and replays every framed phone request
 * against the daemon's own loopback listener. The server never learns the
 * relay exists: its routes, its auth and its `/ws` are the only code path,
 * whether a request came from the relay or from a local browser.
 */

export type RelayState = "connecting" | "online" | "offline" | "rejected";

export interface RelayConnectorOptions {
  relayUrl: string;
  key: RelayKey;
  /** Where the daemon itself listens. */
  local: { host: string; port: number };
  /**
   * The relay refused a key it had accepted before: someone enrolled another
   * one. Called once per process, since every retry would say the same thing.
   */
  onKeyReplaced?: () => void;
  log?: (message: string) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Rejections repeat until a human acts, so they retry slowly. */
  rejectedRetryMs?: number;
  pingIntervalMs?: number;
}

/** Response bytes allowed to queue on the relay socket before a body pauses. */
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Phone messages held while the local socket opens; a burst beyond is abuse. */
const MAX_QUEUED_MESSAGES = 256;

interface HttpStream {
  req: ClientRequest;
  res?: IncomingMessage;
}

interface LocalSocket {
  ws: WebSocket;
  queue: { data: Buffer | string }[];
}

export class RelayConnector {
  state: RelayState = "offline";
  private readonly options: Required<Omit<RelayConnectorOptions, "onKeyReplaced">> &
    Pick<RelayConnectorOptions, "onKeyReplaced">;
  private socket: WebSocket | null = null;
  private stopped = true;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;
  private alarmed = false;
  private readonly http = new Map<number, HttpStream>();
  private readonly sockets = new Map<number, LocalSocket>();
  private readonly listeners = new Set<(state: RelayState) => void>();

  constructor(options: RelayConnectorOptions) {
    this.options = {
      log: (message) => console.log(`[pios] relay: ${message}`),
      retryBaseMs: 1_000,
      retryMaxMs: 16_000,
      rejectedRetryMs: 60_000,
      pingIntervalMs: 30_000,
      ...options,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.pingTimer = setInterval(() => this.ping(), this.options.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.dropStreams();
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close(1001, "daemon stopping");
        setTimeout(() => {
          socket.terminate();
          resolve();
        }, 1_000).unref?.();
      });
    }
    this.setState("offline");
  }

  onState(listener: (state: RelayState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: RelayState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    const ws = new WebSocket(hostSocketUrl(this.options.relayUrl), { maxPayload: MAX_MESSAGE_BYTES });
    this.socket = ws;
    this.lastHeard = Date.now();
    let authed = false;
    let rejected: RejectReason | null = null;

    ws.on("message", (data, isBinary) => {
      this.lastHeard = Date.now();
      // The only text on this socket is the relay's keepalive answer.
      if (!isBinary) return;
      let decoded;
      try {
        decoded = decodeFrame(toBuffer(data));
      } catch {
        ws.terminate();
        return;
      }
      const { frame, payload } = decoded;
      if (authed) {
        // Frames carry what strangers sent the relay. Whatever one of them
        // trips over costs that stream, never the daemon process.
        try {
          this.onFrame(frame, payload);
        } catch (error) {
          this.options.log(`dropped a ${frame.t} frame: ${(error as Error).message}`);
          if ("s" in frame) this.abandon(frame.s);
        }
        return;
      }

      if (frame.t === "challenge") {
        if (frame.v !== RELAY_PROTOCOL_VERSION) {
          this.options.log(
            `relay speaks protocol v${frame.v}, this daemon v${RELAY_PROTOCOL_VERSION}; redeploy one of them`,
          );
          rejected = "version_mismatch";
          ws.close(1000);
          return;
        }
        this.sendOn(ws, {
          t: "hello",
          v: RELAY_PROTOCOL_VERSION,
          publicKey: this.options.key.publicKey,
          signature: this.options.key.signChallenge(frame.nonce),
        });
      } else if (frame.t === "ready") {
        authed = true;
        this.attempts = 0;
        this.options.key.markAccepted();
        this.options.log(`online at ${this.options.relayUrl}`);
        this.setState("online");
      } else if (frame.t === "rejected") {
        rejected = frame.reason;
        this.onRejected(frame.reason);
      }
    });

    ws.on("close", (code, reason) => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.dropStreams();
      if (this.stopped) return;
      if (rejected) {
        this.setState("rejected");
        return this.scheduleReconnect(this.options.rejectedRetryMs);
      }
      if (authed) this.options.log(`disconnected (${code}${reason.length ? ` ${reason}` : ""})`);
      this.setState("offline");
      this.scheduleReconnect(this.nextDelay());
    });

    ws.on("error", (error) => {
      // A close always follows; only the first failure in a run is worth a line.
      if (this.attempts === 0) this.options.log(`connection failed: ${error.message}`);
    });
  }

  private onRejected(reason: RejectReason): void {
    if (reason === "key_mismatch" && this.options.key.acceptedAt !== null) {
      this.options.log(
        "REFUSED: the relay now trusts a different host key. If you did not run " +
          "`pios-server relay enroll` on another machine, rotate ENROLL_SECRET and re-enroll now.",
      );
      if (!this.alarmed) {
        this.alarmed = true;
        this.options.onKeyReplaced?.();
      }
      return;
    }
    if (reason === "not_enrolled" || reason === "key_mismatch") {
      this.options.log("this daemon is not enrolled; run `pios-server relay enroll`");
      return;
    }
    this.options.log(`rejected by relay: ${reason}`);
  }

  private nextDelay(): number {
    const delay = Math.min(this.options.retryMaxMs, this.options.retryBaseMs * 2 ** this.attempts);
    this.attempts += 1;
    return delay;
  }

  private scheduleReconnect(delay: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  /**
   * Keepalive, and the only way to notice a half-open socket: a laptop that
   * slept keeps a socket that looks open and carries nothing.
   */
  private ping(): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastHeard > this.options.pingIntervalMs * 2.5) {
      this.options.log("relay went silent; reconnecting");
      ws.terminate();
      return;
    }
    ws.send(PING);
  }

  private onFrame(frame: Frame, bytes: Uint8Array): void {
    const payload = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (frame.t) {
      case "req":
        return this.startRequest(frame);
      case "data":
        this.http.get(frame.s)?.req.write(payload);
        return;
      case "end":
        this.http.get(frame.s)?.req.end();
        return;
      case "reset": {
        const stream = this.http.get(frame.s);
        this.http.delete(frame.s);
        stream?.res?.destroy();
        stream?.req.destroy();
        return;
      }
      case "ws-open":
        return this.openLocalSocket(frame.s, frame.path);
      case "ws-msg": {
        const local = this.sockets.get(frame.s);
        if (!local) return;
        const data = frame.text ? payload.toString("utf8") : Buffer.from(payload);
        if (local.ws.readyState === WebSocket.OPEN) local.ws.send(data);
        else if (local.queue.length < MAX_QUEUED_MESSAGES) local.queue.push({ data });
        else this.abandon(frame.s);
        return;
      }
      case "ws-close": {
        const local = this.sockets.get(frame.s);
        this.sockets.delete(frame.s);
        if (!local) return;
        if (local.ws.readyState === WebSocket.OPEN) {
          local.ws.close(sendableCloseCode(frame.code), sendableCloseReason(frame.reason));
        } else {
          local.ws.terminate();
        }
        return;
      }
      default:
        return;
    }
  }

  /** Ends a stream in whatever state it is, telling the relay once. */
  private abandon(s: number): void {
    const stream = this.http.get(s);
    if (stream) {
      stream.res?.destroy();
      stream.req.destroy();
      this.reset(s, "stream failed");
    }
    const local = this.sockets.get(s);
    if (local) {
      this.sockets.delete(s);
      local.ws.terminate();
      this.send({ t: "ws-close", s, code: 1011, reason: "stream failed" });
    }
    if (stream || local) return;
    // Failed before it was tracked; the relay knows which kind it opened.
    this.send({ t: "reset", s, reason: "stream failed" });
    this.send({ t: "ws-close", s, code: 1011, reason: "stream failed" });
  }

  private startRequest(frame: Extract<Frame, { t: "req" }>): void {
    const { s } = frame;
    let req: ClientRequest;
    try {
      req = httpRequest({
        host: this.options.local.host,
        port: this.options.local.port,
        method: frame.method,
        path: frame.path,
        // Node only adds Host itself for object headers, and HTTP/1.1 without
        // one is a 400.
        headers: [
          "host",
          `${this.options.local.host}:${this.options.local.port}`,
          ...forwardableHeaders(frame.headers).flat(),
        ],
      });
    } catch {
      // Node validates synchronously; the phone gets a plain refusal.
      this.send({ t: "res", s, status: 400, headers: [["content-type", "text/plain"]] });
      this.send({ t: "data", s }, Buffer.from("bad request"));
      this.send({ t: "end", s });
      return;
    }
    const stream: HttpStream = { req };
    this.http.set(s, stream);

    req.on("response", (res) => {
      if (!this.http.has(s)) return res.destroy();
      stream.res = res;
      this.send({ t: "res", s, status: res.statusCode ?? 502, headers: pairs(res.rawHeaders) });
      res.on("data", (chunk: Buffer) => {
        for (const piece of chunks(chunk)) this.send({ t: "data", s }, piece);
        this.throttle(res);
      });
      res.on("end", () => {
        if (!this.http.delete(s)) return;
        this.send({ t: "end", s });
      });
      res.on("error", () => this.reset(s, "response failed"));
    });

    req.on("error", (error) => {
      if (!this.http.has(s)) return;
      if (stream.res) return this.reset(s, "response failed");
      // The daemon behind this connector is the one thing that must answer;
      // say so plainly rather than let the relay report the host as offline.
      this.http.delete(s);
      const body = Buffer.from(JSON.stringify({ error: "daemon_unreachable", detail: error.message }));
      this.send({ t: "res", s, status: 502, headers: [["content-type", "application/json"]] });
      this.send({ t: "data", s }, body);
      this.send({ t: "end", s });
    });
  }

  private reset(s: number, reason: string): void {
    if (!this.http.delete(s)) return;
    this.send({ t: "reset", s, reason });
  }

  /** Pauses a body while the relay socket is backed up, so memory stays bounded. */
  private throttle(res: IncomingMessage): void {
    const ws = this.socket;
    if (!ws || ws.bufferedAmount < HIGH_WATER_BYTES || res.isPaused()) return;
    res.pause();
    const wait = setInterval(() => {
      if (this.socket !== ws || ws.bufferedAmount < HIGH_WATER_BYTES / 2) {
        clearInterval(wait);
        res.resume();
      }
    }, 10);
  }

  private openLocalSocket(s: number, path: string): void {
    const ws = new WebSocket(`ws://${this.options.local.host}:${this.options.local.port}${path}`, {
      maxPayload: MAX_MESSAGE_BYTES,
    });
    const local: LocalSocket = { ws, queue: [] };
    this.sockets.set(s, local);

    ws.on("open", () => {
      for (const { data } of local.queue) ws.send(data);
      local.queue = [];
    });
    ws.on("message", (data, isBinary) => {
      if (this.sockets.get(s) !== local) return;
      this.send({ t: "ws-msg", s, text: !isBinary }, toBuffer(data));
    });
    ws.on("close", (code, reason) => {
      if (this.sockets.get(s) !== local) return;
      this.sockets.delete(s);
      this.send({ t: "ws-close", s, code: sendableCloseCode(code, 1011), reason: reason.toString() });
    });
    ws.on("error", () => {
      // A close follows and carries the outcome to the phone.
    });
  }

  private dropStreams(): void {
    for (const stream of this.http.values()) {
      stream.res?.destroy();
      stream.req.destroy();
    }
    this.http.clear();
    for (const local of this.sockets.values()) local.ws.terminate();
    this.sockets.clear();
  }

  private send(frame: Frame, payload?: Uint8Array): void {
    if (this.socket) this.sendOn(this.socket, frame, payload);
  }

  private sendOn(ws: WebSocket, frame: Frame, payload?: Uint8Array): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(frame, payload));
  }
}

export class RelayRejectedError extends Error {
  readonly reason: RejectReason;
  constructor(reason: RejectReason) {
    super(`relay rejected enrollment: ${reason}`);
    this.reason = reason;
  }
}

/**
 * Binds this daemon's key at the relay, spending the enrollment secret.
 *
 * A separate short connection rather than a mode of the connector: the secret
 * is needed exactly once and should never sit in the daemon's config.
 */
export function enrollAtRelay(
  relayUrl: string,
  key: RelayKey,
  enrollSecret: string,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(hostSocketUrl(relayUrl));
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("relay did not answer")), timeoutMs);

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      let frame: Frame;
      try {
        frame = decodeFrame(toBuffer(data)).frame;
      } catch {
        return finish(new Error("relay sent a malformed frame"));
      }
      if (frame.t === "challenge") {
        if (frame.v !== RELAY_PROTOCOL_VERSION) {
          return finish(new RelayRejectedError("version_mismatch"));
        }
        ws.send(
          encodeFrame({
            t: "hello",
            v: RELAY_PROTOCOL_VERSION,
            publicKey: key.publicKey,
            signature: key.signChallenge(frame.nonce),
            enrollSecret,
          }),
        );
      } else if (frame.t === "enrolled") {
        key.markAccepted();
        finish();
      } else if (frame.t === "rejected") {
        finish(new RelayRejectedError(frame.reason));
      }
    });
    ws.on("error", (error) => finish(error));
    ws.on("close", (code) => finish(new Error(`relay closed the connection (${code})`)));
  });
}

export function hostSocketUrl(relayUrl: string): string {
  const url = new URL(HOST_PATH, relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function pairs(raw: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i]!, raw[i + 1]!]);
  return out;
}

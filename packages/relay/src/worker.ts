import {
  chunks,
  decodeFrame,
  encodeFrame,
  forwardableHeaders,
  HOST_OFFLINE_CLOSE_CODE,
  HOST_OFFLINE_HEADER,
  HOST_PATH,
  MAX_REQUEST_BYTES,
  PING,
  PONG,
  RELAY_PROTOCOL_VERSION,
  sendableCloseCode,
  sendableCloseReason,
  type Frame,
} from "./codec.ts";
import { decideHost, newNonce, parseHostRecord } from "./gate.ts";

/**
 * The relay: a dumb pipe between the phone and one daemon.
 *
 * The daemon dials out to `HOST_PATH` and proves it holds the enrolled key.
 * Every other request, the PWA included, is framed onto that one socket and
 * answered by the daemon. The relay authorizes nothing on the phone side:
 * device tokens pass through and are checked where they were issued.
 */

export interface Env {
  RELAY: DurableObjectNamespace;
  ENROLL_SECRET?: string;
}

/** One daemon per deployment for now; the name is the routing seam for more. */
const HOST_ID = "default";
const HOST_RECORD_KEY = "host";
const RESPONSE_TIMEOUT_MS = 120_000;

/*
 * Everything below is reachable without credentials, so each resource an
 * unknown caller can hold is capped per address. A global cap alone would let
 * one address crowd out the real daemon or the real phone.
 */

/** A real daemon answers the challenge within one round trip. */
const HANDSHAKE_MS = 10_000;
const MAX_PENDING_HOSTS = 32;
const MAX_PENDING_HOSTS_PER_IP = 2;
/** Several tabs and a reconnect overlap fit comfortably. */
const MAX_PHONE_SOCKETS_PER_IP = 16;
/** A transcript full of images loads in parallel. */
const MAX_REQUESTS_PER_IP = 64;

/** Close codes on the host socket, read by the connector. */
const CLOSE_REPLACED = 4000;
const CLOSE_REJECTED = 4001;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.RELAY.get(env.RELAY.idFromName(HOST_ID)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

type Attachment =
  | { role: "pending"; nonce: string; ip?: string; since?: number }
  | { role: "host" }
  | { role: "phone"; s: number };

interface PendingResponse {
  resolve: (response: Response) => void;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  readable: ReadableStream<Uint8Array>;
  timer: ReturnType<typeof setTimeout>;
  answered: boolean;
  ip: string;
}

export class RelayHost implements DurableObject {
  /**
   * HTTP exchanges in flight. In memory only: an object with an open request
   * is never hibernated, so this cannot be lost under a live exchange.
   */
  private readonly responses = new Map<number, PendingResponse>();

  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Answered by the runtime without waking the object, so keepalive is free.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    const ip = clientIp(request);
    if (url.pathname === HOST_PATH) {
      return upgrade ? this.acceptHost(ip) : new Response("expected a websocket", { status: 426 });
    }
    const host = this.host();
    if (upgrade) return this.acceptPhone(url, host, ip);
    if (!host) return hostOffline();
    return this.forward(request, url, host, ip);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return ws.close(1011, "unknown socket");
    if (attachment.role === "phone") return this.fromPhone(attachment.s, message);
    if (typeof message === "string") return;

    let frame: Frame;
    let payload: Uint8Array;
    try {
      ({ frame, payload } = decodeFrame(message));
    } catch {
      return ws.close(1002, "malformed frame");
    }
    if (attachment.role === "pending") {
      if (expired(attachment)) return ws.close(CLOSE_REJECTED, "handshake timed out");
      return this.authenticate(ws, attachment, frame);
    }
    return this.fromHost(frame, payload);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    try {
      ws.close(sendableCloseCode(code), sendableCloseReason(reason));
    } catch {
      // Already closed from this side.
    }
    if (attachment?.role === "phone") {
      this.host()?.send(
        encodeFrame({ t: "ws-close", s: attachment.s, code: sendableCloseCode(code), reason }),
      );
    }
    if (attachment?.role === "host" && !this.host(ws)) this.dropStreams("host offline");
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "socket error");
  }

  /**
   * Pending sockets expire, are capped per address, and only then globally,
   * oldest first: flooding the queue to push out the real daemon's handshake
   * takes many addresses, not one.
   */
  private acceptHost(ip: string): Response {
    let pending: WebSocket[] = [];
    for (const ws of this.state.getWebSockets("host")) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.role !== "pending") continue;
      if (expired(attachment)) closeQuietly(ws, CLOSE_REJECTED, "handshake timed out");
      else pending.push(ws);
    }
    const fromIp = pending.filter((ws) => pendingIp(ws) === ip);
    for (const stale of fromIp.slice(0, Math.max(0, fromIp.length - MAX_PENDING_HOSTS_PER_IP + 1))) {
      closeQuietly(stale, CLOSE_REJECTED, "too many pending hosts");
      pending = pending.filter((ws) => ws !== stale);
    }
    for (const stale of pending.slice(0, Math.max(0, pending.length - MAX_PENDING_HOSTS + 1))) {
      closeQuietly(stale, CLOSE_REJECTED, "too many pending hosts");
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server, ["host"]);
    const nonce = newNonce();
    server.serializeAttachment({ role: "pending", nonce, ip, since: Date.now() } satisfies Attachment);
    server.send(encodeFrame({ t: "challenge", v: RELAY_PROTOCOL_VERSION, nonce }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async authenticate(
    ws: WebSocket,
    attachment: Extract<Attachment, { role: "pending" }>,
    frame: Frame,
  ): Promise<void> {
    const { nonce } = attachment;
    if (frame.t !== "hello") return ws.close(CLOSE_REJECTED, "expected hello");
    // Spent on first use, so a captured hello can never be replayed.
    ws.serializeAttachment({ ...attachment, nonce: "" } satisfies Attachment);
    if (!nonce) return ws.close(CLOSE_REJECTED, "nonce spent");

    const record = parseHostRecord(await this.state.storage.get(HOST_RECORD_KEY));
    const decision = await decideHost({
      record,
      enrollSecret: this.env.ENROLL_SECRET,
      hello: frame,
      nonce,
    });

    if (decision.kind === "reject") {
      ws.send(encodeFrame({ t: "rejected", reason: decision.reason }));
      return ws.close(CLOSE_REJECTED, decision.reason);
    }
    if (decision.kind === "enroll") {
      await this.state.storage.put(HOST_RECORD_KEY, decision.record);
      // A host still holding the old key must learn it was replaced: that is
      // how an enrollment nobody asked for becomes visible.
      if (record && record !== "unreadable" && record.publicKey !== decision.record.publicKey) {
        this.evictHosts("key replaced");
      }
      ws.send(encodeFrame({ t: "enrolled" }));
      return ws.close(1000, "enrolled");
    }

    // The same key reconnecting means the old socket is a ghost of a daemon
    // that restarted or lost its network; its streams died with it.
    this.evictHosts("replaced by a newer connection", ws);
    ws.serializeAttachment({ role: "host" } satisfies Attachment);
    ws.send(encodeFrame({ t: "ready" }));
  }

  private evictHosts(reason: string, keep?: WebSocket): void {
    let evicted = false;
    for (const ws of this.state.getWebSockets("host")) {
      if (ws === keep) continue;
      if ((ws.deserializeAttachment() as Attachment | null)?.role !== "host") continue;
      ws.serializeAttachment({ role: "pending", nonce: "" } satisfies Attachment);
      ws.close(CLOSE_REPLACED, reason);
      evicted = true;
    }
    if (evicted) this.dropStreams("host offline");
  }

  private host(except?: WebSocket): WebSocket | null {
    const hosts = this.state.getWebSockets("host").filter(
      (ws) =>
        ws !== except && (ws.deserializeAttachment() as Attachment | null)?.role === "host",
    );
    return hosts.at(-1) ?? null;
  }

  /** Every phone stream belongs to the host connection that carried it. */
  private dropStreams(reason: string): void {
    for (const phone of this.state.getWebSockets("phone")) {
      try {
        phone.close(HOST_OFFLINE_CLOSE_CODE, reason);
      } catch {
        // Already closing.
      }
    }
    for (const [s, pending] of this.responses) this.fail(s, pending);
  }

  private acceptPhone(url: URL, host: WebSocket | null, ip: string): Response {
    // Oldest first: a phone's own reconnect must never be the one refused.
    const fromIp = this.state.getWebSockets(`ip:${ip}`);
    for (const stale of fromIp.slice(0, Math.max(0, fromIp.length - MAX_PHONE_SOCKETS_PER_IP + 1))) {
      closeQuietly(stale, 1008, "too many sockets");
    }

    const { 0: client, 1: server } = new WebSocketPair();
    const s = this.newStreamId();
    this.state.acceptWebSocket(server, ["phone", `s:${s}`, `ip:${ip}`]);
    server.serializeAttachment({ role: "phone", s } satisfies Attachment);
    // Accepted, then closed with a reason: a refused upgrade reaches the
    // browser as a bare 1006 the client cannot tell from a network drop.
    if (!host) server.close(HOST_OFFLINE_CLOSE_CODE, "host offline");
    else host.send(encodeFrame({ t: "ws-open", s, path: url.pathname + url.search }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private fromPhone(s: number, message: string | ArrayBuffer): void {
    const host = this.host();
    if (!host) return this.phone(s)?.close(HOST_OFFLINE_CLOSE_CODE, "host offline");
    const text = typeof message === "string";
    const bytes = text ? new TextEncoder().encode(message) : new Uint8Array(message);
    host.send(encodeFrame({ t: "ws-msg", s, text }, bytes));
  }

  private phone(s: number): WebSocket | undefined {
    return this.state.getWebSockets(`s:${s}`)[0];
  }

  private async fromHost(frame: Frame, payload: Uint8Array): Promise<void> {
    switch (frame.t) {
      case "res":
        return this.respond(frame.s, frame.status, frame.headers);
      case "data": {
        const pending = this.responses.get(frame.s);
        if (!pending?.writer) return;
        try {
          await pending.writer.write(payload.slice());
        } catch {
          // The phone went away mid-body; tell the daemon to stop sending.
          this.responses.delete(frame.s);
          this.host()?.send(encodeFrame({ t: "reset", s: frame.s, reason: "client gone" }));
        }
        return;
      }
      case "end": {
        const pending = this.responses.get(frame.s);
        this.responses.delete(frame.s);
        await pending?.writer?.close().catch(() => {});
        return;
      }
      case "reset": {
        const pending = this.responses.get(frame.s);
        if (pending) this.fail(frame.s, pending);
        return;
      }
      case "ws-msg": {
        const phone = this.phone(frame.s);
        if (!phone) {
          this.host()?.send(encodeFrame({ t: "ws-close", s: frame.s, code: 1001, reason: "gone" }));
          return;
        }
        phone.send(frame.text ? new TextDecoder().decode(payload) : payload.slice());
        return;
      }
      case "ws-close":
        this.phone(frame.s)?.close(sendableCloseCode(frame.code), sendableCloseReason(frame.reason));
        return;
      default:
        return;
    }
  }

  private async forward(request: Request, url: URL, host: WebSocket, ip: string): Promise<Response> {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
      return new Response("request body too large", { status: 413 });
    }
    let inFlight = 0;
    for (const pending of this.responses.values()) if (pending.ip === ip) inFlight += 1;
    if (inFlight >= MAX_REQUESTS_PER_IP) {
      return new Response("too many requests", { status: 429, headers: { "retry-after": "1" } });
    }

    const s = this.newStreamId();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const response = new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.responses.get(s);
        if (pending && !pending.answered) this.fail(s, pending, 504);
      }, RESPONSE_TIMEOUT_MS);
      this.responses.set(s, {
        resolve,
        writer: writable.getWriter(),
        readable,
        timer,
        answered: false,
        ip,
      });
    });

    host.send(
      encodeFrame({
        t: "req",
        s,
        method: request.method,
        path: url.pathname + url.search,
        headers: forwardableHeaders(request.headers),
      }),
    );
    try {
      let sent = 0;
      if (request.body) {
        const reader = request.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // The daemon already answered (a 401, say): the rest has nowhere to go.
          if (!this.responses.has(s)) {
            await reader.cancel().catch(() => {});
            return response;
          }
          sent += value.byteLength;
          if (sent > MAX_REQUEST_BYTES) {
            await reader.cancel().catch(() => {});
            const pending = this.responses.get(s);
            if (pending) this.fail(s, pending, 413);
            host.send(encodeFrame({ t: "reset", s, reason: "request body too large" }));
            return response;
          }
          for (const piece of chunks(value)) host.send(encodeFrame({ t: "data", s }, piece));
        }
      }
      host.send(encodeFrame({ t: "end", s }));
    } catch {
      const pending = this.responses.get(s);
      if (pending) this.fail(s, pending);
      host.send(encodeFrame({ t: "reset", s, reason: "request body failed" }));
    }
    return response;
  }

  private respond(s: number, status: number, headers: [string, string][]): void {
    const pending = this.responses.get(s);
    if (!pending || pending.answered) return;
    pending.answered = true;
    clearTimeout(pending.timer);
    const out = new Headers(forwardableHeaders(headers));
    // Null-body statuses cannot carry a stream; the daemon's `end` still
    // arrives and finds no writer to close.
    if ([101, 204, 205, 304].includes(status)) {
      void pending.writer?.abort().catch(() => {});
      pending.writer = null;
      pending.resolve(new Response(null, { status, headers: out }));
      return;
    }
    pending.resolve(new Response(pending.readable, { status, headers: out }));
  }

  private fail(s: number, pending: PendingResponse, status = 502): void {
    this.responses.delete(s);
    clearTimeout(pending.timer);
    if (!pending.answered) {
      pending.answered = true;
      pending.resolve(status === 502 ? hostOffline() : new Response(FAILURE_TEXT[status] ?? null, { status }));
    }
    void pending.writer?.abort().catch(() => {});
  }

  private newStreamId(): number {
    for (;;) {
      const s = crypto.getRandomValues(new Uint32Array(1))[0]! >>> 1;
      if (!this.responses.has(s) && !this.phone(s)) return s;
    }
  }
}

const FAILURE_TEXT: Record<number, string> = {
  413: "request body too large",
  504: "host timed out",
};

/** Set by Cloudflare's edge, which a caller cannot override. */
function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

function expired(attachment: Extract<Attachment, { role: "pending" }>): boolean {
  // Sockets from before `since` existed have no age; treat them as stale.
  return Date.now() - (attachment.since ?? 0) > HANDSHAKE_MS;
}

function pendingIp(ws: WebSocket): string | undefined {
  const attachment = ws.deserializeAttachment() as Attachment | null;
  return attachment?.role === "pending" ? attachment.ip : undefined;
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closing.
  }
}

function hostOffline(): Response {
  return new Response(JSON.stringify({ error: "host_offline" }), {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "5",
      [HOST_OFFLINE_HEADER]: "host-offline",
    },
  });
}

import { WIRE_VERSION, type ClientFrame, type ServerFrame, type SessionSummary } from "@pios/protocol";
import type { Transport } from "../src/transport.ts";

/**
 * A socket the test drives by hand.
 *
 * Nothing here talks to a real daemon: the point is to script the failures
 * that are hard to produce on purpose, like a drop in the middle of a stream
 * or an auth rejection.
 */
export class FakeTransport implements Transport {
  readonly sent: ClientFrame[] = [];
  closed = false;
  private messageHandler: ((frame: ServerFrame) => void) | null = null;
  private closeHandler: ((info: { code: number; reason: string }) => void) | null = null;
  private errorHandler: ((error: unknown) => void) | null = null;

  send(frame: ClientFrame): void {
    this.sent.push(frame);
  }
  close(): void {
    this.closed = true;
  }
  onMessage(handler: (frame: ServerFrame) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (info: { code: number; reason: string }) => void): void {
    this.closeHandler = handler;
  }
  onError(handler: (error: unknown) => void): void {
    this.errorHandler = handler;
  }

  /** Server -> client. */
  emit(frame: ServerFrame): void {
    this.messageHandler?.(frame);
  }

  drop(code = 1006, reason = "connection lost"): void {
    this.closed = true;
    this.closeHandler?.({ code, reason });
  }

  fail(error: unknown): void {
    this.errorHandler?.(error);
  }

  sentOfType<T extends ClientFrame["type"]>(type: T): Extract<ClientFrame, { type: T }>[] {
    return this.sent.filter((f): f is Extract<ClientFrame, { type: T }> => f.type === type);
  }

  /** Completes the handshake the supervisor requires before `connected`. */
  acceptHello(sessions: SessionSummary[] = []): void {
    this.emit({
      v: WIRE_VERSION,
      type: "welcome",
      serverVersion: "test",
      piVersion: "test",
      sessions,
    });
  }
}

export class TransportFactoryStub {
  readonly created: FakeTransport[] = [];
  /** Set to make the next attempts fail before a socket exists. */
  failures = 0;

  readonly create = async (_url: string): Promise<Transport> => {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("connect failed");
    }
    const transport = new FakeTransport();
    this.created.push(transport);
    return transport;
  };

  get last(): FakeTransport {
    const transport = this.created.at(-1);
    if (!transport) throw new Error("no transport created");
    return transport;
  }
}

export function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s1",
    cwd: "/work",
    status: "idle",
    trusted: false,
    leafId: null,
    lastSeq: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export function entry(id: string, parentId: string | null = null) {
  return { id, parentId, type: "message", message: { role: "user" as const, content: id } };
}

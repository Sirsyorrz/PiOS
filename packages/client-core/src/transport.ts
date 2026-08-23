import type { ClientFrame, ServerFrame } from "@pios/protocol";

/**
 * The socket, abstracted so this package stays platform-free.
 *
 * Web, React Native, and the tests all supply their own. UI code never sees
 * this type: the supervisor is the only thing allowed to open one.
 */
export interface Transport {
  send(frame: ClientFrame): void;
  close(): void;
  onMessage(handler: (frame: ServerFrame) => void): void;
  onClose(handler: (info: { code: number; reason: string }) => void): void;
  onError(handler: (error: unknown) => void): void;
}

export interface TransportFactory {
  (url: string): Promise<Transport>;
}

/** The subset of the WebSocket API this package needs. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", handler: () => void): void;
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", handler: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", handler: (event: unknown) => void): void;
}

/**
 * Builds a transport from any WebSocket implementation.
 *
 * The constructor is injected rather than reached for on `globalThis`, which
 * is what keeps this package usable from web, React Native, and Node tests
 * without a platform check.
 */
export function webSocketTransport(
  WebSocketCtor: new (url: string) => WebSocketLike,
): TransportFactory {
  return (url) =>
    new Promise<Transport>((resolve, reject) => {
      const socket = new WebSocketCtor(url);
      let messageHandler: ((frame: ServerFrame) => void) | null = null;
      let closeHandler: ((info: { code: number; reason: string }) => void) | null = null;
      let errorHandler: ((error: unknown) => void) | null = null;
      let opened = false;

      socket.addEventListener("message", (event) => {
        try {
          messageHandler?.(JSON.parse(String(event.data)) as ServerFrame);
        } catch {
          // A frame this build cannot parse is dropped, not fatal: the socket
          // is still carrying everything else.
        }
      });
      socket.addEventListener("close", (event) => {
        if (!opened) return reject(new Error(`closed before open (${event.code})`));
        closeHandler?.({ code: event.code, reason: event.reason });
      });
      socket.addEventListener("error", (event) => {
        if (!opened) return reject(new Error("socket error"));
        errorHandler?.(event);
      });
      socket.addEventListener("open", () => {
        opened = true;
        resolve({
          send: (frame) => socket.send(JSON.stringify(frame)),
          close: () => socket.close(),
          onMessage: (handler) => (messageHandler = handler),
          onClose: (handler) => (closeHandler = handler),
          onError: (handler) => (errorHandler = handler),
        });
      });
    });
}

/** Close codes the daemon uses that mean "do not retry with these inputs". */
export const AUTH_CLOSE_CODES = new Set([4401, 4403]);

export function isAuthFailure(code: number): boolean {
  return AUTH_CLOSE_CODES.has(code);
}

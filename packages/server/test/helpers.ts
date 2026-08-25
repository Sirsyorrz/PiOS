import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { subprocessHost, type SessionLister } from "@pios/pi-host";
import { WIRE_VERSION, type ClientFrame, type ServerFrame } from "@pios/protocol";
import { PiosServer } from "../src/server.ts";

const FAKE_PI = fileURLToPath(
  new URL("../../pi-host/test/fake-pi.ts", import.meta.url),
);

export interface Harness {
  server: PiosServer;
  baseUrl: string;
  dir: string;
  deviceToken: string;
  close(): Promise<void>;
}

/** A real server over the loopback, driven by the stub pi from Phase 2. */
export async function startHarness(lister?: SessionLister): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pios-server-"));
  const server = new PiosServer({
    lister_: lister,
    host: "127.0.0.1",
    port: 0,
    dataDir: join(dir, "data"),
    sessionDir: join(dir, "sessions"),
    helloTimeoutMs: 300,
    host_: subprocessHost({
      command: process.execPath,
      argsPrefix: [FAKE_PI],
      sessionDir: join(dir, "sessions"),
      requestTimeoutMs: 5_000,
    }),
    piVersion: "fake",
  });
  await server.listen();

  const { token } = server.auth.createPairing();
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const paired = await fetch(`${baseUrl}/pair`, {
    method: "POST",
    body: JSON.stringify({ pairingToken: token, label: "test" }),
  });
  const { deviceToken } = (await paired.json()) as { deviceToken: string };

  return {
    server,
    baseUrl,
    dir,
    deviceToken,
    close: async () => {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Distributive: a plain Omit over a union would collapse its members. */
type Sendable<T = ClientFrame> = T extends ClientFrame
  ? Omit<T, "v" | "commandId"> & { commandId?: string }
  : never;

let commandCounter = 0;
export function nextCommandId(): string {
  return `cmd-${++commandCounter}`;
}

/** Test client that records every frame, so assertions can look backwards. */
export class TestClient {
  private readonly socket: WebSocket;
  readonly received: ServerFrame[] = [];
  private readonly waiters: { match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame;
      this.received.push(frame);
      for (const waiter of [...this.waiters]) {
        if (!waiter.match(frame)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    });
  }

  static async connect(harness: Harness): Promise<TestClient> {
    const socket = new WebSocket(`${harness.baseUrl.replace("http", "ws")}/ws`);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new TestClient(socket);
  }

  send(frame: Sendable): string {
    const commandId = frame.commandId ?? nextCommandId();
    this.socket.send(JSON.stringify({ ...frame, v: WIRE_VERSION, commandId }));
    return commandId;
  }

  waitFor(match: (frame: ServerFrame) => boolean, timeoutMs = 5_000): Promise<ServerFrame> {
    const existing = this.received.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs);
      this.waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  waitForCommand(commandId: string, timeoutMs?: number): Promise<ServerFrame> {
    return this.waitFor((f) => f.commandId === commandId, timeoutMs);
  }

  closed(): Promise<{ code: number }> {
    return new Promise((resolve) => this.socket.once("close", (code) => resolve({ code })));
  }

  close(): void {
    this.socket.close();
  }
}

export async function hello(harness: Harness): Promise<TestClient> {
  const client = await TestClient.connect(harness);
  const id = client.send({
    type: "hello",
    deviceToken: harness.deviceToken,
    clientVersion: "test",
  });
  await client.waitForCommand(id);
  return client;
}

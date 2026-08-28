import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { WebSocketServer } from "ws";
import {
  createSessionLister,
  SessionRegistry,
  subprocessHost,
  type SessionHost,
  type SessionLister,
} from "@pios/pi-host";
import { AuthStore } from "./auth.ts";
import { CommandLedger } from "./dedupe.ts";
import { Connection } from "./connection.ts";
import { handleRequest } from "./http-routes.ts";
import { advertisedEndpoints, type Endpoint } from "./endpoints.ts";
import { SettleNotifier } from "./notifier.ts";
import { PushStore } from "./push.ts";
import { authStorePath, defaultConfig, pushStorePath, type ServerConfig } from "./config.ts";

export interface PiosServerOptions extends Partial<ServerConfig> {
  /** Overridable so tests can run without spawning real pi. */
  host_?: SessionHost;
  piVersion?: string;
  /** Overridable so tests do not touch the real session directory. */
  lister_?: SessionLister;
}

export class PiosServer {
  readonly config: ServerConfig;
  readonly auth: AuthStore;
  readonly registry: SessionRegistry;
  readonly push: PushStore;

  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly ledger = new CommandLedger();
  private readonly connections = new Set<Connection>();
  private readonly lister: SessionLister;
  private readonly notifier: SettleNotifier;

  constructor(options: PiosServerOptions = {}) {
    this.config = defaultConfig(options);
    mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.config.sessionDir, { recursive: true });

    this.auth = new AuthStore(authStorePath(this.config));
    this.lister =
      options.lister_ ?? createSessionLister({ sessionDir: this.config.sessionDir });
    this.push = new PushStore(pushStorePath(this.config), this.config.pushSubject);
    this.notifier = new SettleNotifier({
      send: async (notification) => {
        try {
          await this.push.send(notification.message, notification.skipDeviceIds);
        } catch (error) {
          console.error("[pios] push failed", error);
        }
      },
      watchers: (sessionId) => this.watchers(sessionId),
    });
    this.registry = new SessionRegistry(
      options.host_ ?? subprocessHost({ sessionDir: this.config.sessionDir }),
      {
        onCreate: (session) => this.notifier.attach(session),
        onDispose: (id) => this.notifier.release(id),
      },
    );

    this.http = createServer((req, res) =>
      void handleRequest(
        { config: this.config, auth: this.auth, registry: this.registry, push: this.push },
        req,
        res,
      ),
    );

    // No automatic upgrade handling: every socket must reach `hello` before
    // it can do anything, and that check lives in Connection.
    this.wss = new WebSocketServer({ server: this.http, path: "/ws" });
    this.wss.on("connection", (socket) => {
      const connection = new Connection(socket, {
        auth: this.auth,
        registry: this.registry,
        ledger: this.ledger,
        piVersion: options.piVersion ?? "unknown",
        helloTimeoutMs: this.config.helloTimeoutMs,
        lister: this.lister,
        announceSessions: () => this.announceSessions(),
      });
      this.connections.add(connection);
      socket.on("close", () => this.connections.delete(connection));
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.http.listen(this.config.port, this.config.host, resolve));
    return this.port;
  }

  get port(): number {
    const address = this.http.address();
    return typeof address === "object" && address ? address.port : this.config.port;
  }

  /** Devices with a client currently looking at the session. */
  private watchers(sessionId: string): Set<string> {
    const found = new Set<string>();
    for (const connection of this.connections) {
      const deviceId = connection.deviceId;
      if (deviceId && connection.watching(sessionId, this.config.activityTtlMs)) found.add(deviceId);
    }
    return found;
  }

  private announceSessions(): void {
    for (const connection of this.connections) connection.sendSessions();
  }

  endpoints(hostname?: string): Endpoint[] {
    return advertisedEndpoints(this.port, hostname, this.config.publicUrl);
  }

  async close(): Promise<void> {
    this.notifier.releaseAll();
    await this.registry.disposeAll();
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

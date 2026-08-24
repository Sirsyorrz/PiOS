import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { WebSocketServer } from "ws";
import { SessionRegistry, subprocessHost, type SessionHost } from "@pios/pi-host";
import { AuthStore } from "./auth.ts";
import { CommandLedger } from "./dedupe.ts";
import { Connection } from "./connection.ts";
import { handleRequest } from "./http-routes.ts";
import { advertisedEndpoints, type Endpoint } from "./endpoints.ts";
import { authStorePath, defaultConfig, type ServerConfig } from "./config.ts";

export interface PiosServerOptions extends Partial<ServerConfig> {
  /** Overridable so tests can run without spawning real pi. */
  host_?: SessionHost;
  piVersion?: string;
}

export class PiosServer {
  readonly config: ServerConfig;
  readonly auth: AuthStore;
  readonly registry: SessionRegistry;

  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly ledger = new CommandLedger();
  private readonly connections = new Set<Connection>();

  constructor(options: PiosServerOptions = {}) {
    this.config = defaultConfig(options);
    mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.config.sessionDir, { recursive: true });

    this.auth = new AuthStore(authStorePath(this.config));
    this.registry = new SessionRegistry(
      options.host_ ?? subprocessHost({ sessionDir: this.config.sessionDir }),
    );

    this.http = createServer((req, res) =>
      void handleRequest({ config: this.config, auth: this.auth, registry: this.registry }, req, res),
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

  private announceSessions(): void {
    for (const connection of this.connections) connection.sendSessions();
  }

  endpoints(hostname?: string): Endpoint[] {
    return advertisedEndpoints(this.port, hostname);
  }

  async close(): Promise<void> {
    await this.registry.disposeAll();
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

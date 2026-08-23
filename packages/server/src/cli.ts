#!/usr/bin/env node
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { AuthStore } from "./auth.ts";
import { authStorePath, defaultConfig } from "./config.ts";
import { pairingEndpoint } from "./endpoints.ts";
import { advertisedEndpoints } from "./endpoints.ts";
import { PiosServer } from "./server.ts";

const [command = "serve", ...rest] = process.argv.slice(2);
const port = Number(process.env.PIOS_PORT ?? 4111);

switch (command) {
  case "serve":
    await serve();
    break;
  case "pair":
    pair();
    break;
  case "devices":
    devices();
    break;
  case "revoke":
    revoke(rest[0]);
    break;
  default:
    console.error(`usage: pios-server [serve|pair|devices|revoke <deviceId>]`);
    process.exit(2);
}

async function serve(): Promise<void> {
  const server = new PiosServer({ port, piVersion: piVersion() });
  await server.listen();

  console.log(`pios-server listening on port ${server.port}`);
  for (const endpoint of server.endpoints(hostname())) {
    console.log(`  ${endpoint.key.padEnd(28)} ${endpoint.url}`);
  }

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function pair(): void {
  const config = defaultConfig({ port });
  const auth = new AuthStore(authStorePath(config));
  const { token, code, expiresAt } = auth.createPairing();

  const endpoint = pairingEndpoint(advertisedEndpoints(port, hostname()));
  const base = endpoint?.url ?? `http://localhost:${port}`;

  // The token goes in the fragment: a fragment is never sent to a server and
  // never lands in an access log or a Referer header. The client strips it
  // from history after exchanging it.
  console.log(`\nPair this device within 10 minutes:\n`);
  console.log(`  ${base}/#pt=${token}`);
  console.log(`\n  confirmation code: ${code}`);
  console.log(`  expires: ${new Date(expiresAt).toLocaleTimeString()}\n`);
  if (endpoint) console.log(`  endpoint key: ${endpoint.key}\n`);
}

function devices(): void {
  const auth = new AuthStore(authStorePath(defaultConfig({ port })));
  const list = auth.listDevices();
  if (list.length === 0) return console.log("no paired devices");
  console.table(
    list.map((d) => ({
      id: d.id,
      label: d.label,
      paired: new Date(d.createdAt).toISOString(),
      lastSeen: new Date(d.lastSeenAt).toISOString(),
    })),
  );
}

function revoke(deviceId: string | undefined): void {
  if (!deviceId) {
    console.error("usage: pios-server revoke <deviceId>");
    process.exit(2);
  }
  const auth = new AuthStore(authStorePath(defaultConfig({ port })));
  console.log(auth.revoke(deviceId) ? `revoked ${deviceId}` : `no device ${deviceId}`);
}

function piVersion(): string {
  try {
    return execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

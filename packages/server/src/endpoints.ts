import { networkInterfaces } from "node:os";

/**
 * Advertised ways to reach this daemon.
 *
 * Keyed by a stable identity rather than by URL: a LAN address changes with
 * the network, so a client that remembered `http://192.168.1.14:4111` would
 * follow it to a different machine. The key survives, the URL is a hint, and
 * only a successful connection proves anything.
 */
export interface Endpoint {
  key: string;
  url: string;
  kind: "loopback" | "lan" | "tailscale-ip" | "tailscale-magicdns";
}

export function advertisedEndpoints(port: number, hostname?: string): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const interfaces = networkInterfaces();

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4") continue;
      const url = `http://${address.address}:${port}`;

      if (address.internal) {
        endpoints.push({ key: "loopback:", url, kind: "loopback" });
        continue;
      }
      if (isTailscale(name, address.address)) {
        endpoints.push({ key: `tailscale-ip:${address.address}`, url, kind: "tailscale-ip" });
        continue;
      }
      endpoints.push({ key: `lan:${name}`, url, kind: "lan" });
    }
  }

  if (hostname) {
    endpoints.push({
      key: `tailscale-magicdns:${hostname}`,
      url: `http://${hostname}:${port}`,
      kind: "tailscale-magicdns",
    });
  }
  return endpoints;
}

/** The endpoint to print for pairing: reachable from a phone, not loopback. */
export function pairingEndpoint(endpoints: Endpoint[]): Endpoint | undefined {
  const order: Endpoint["kind"][] = ["tailscale-magicdns", "tailscale-ip", "lan", "loopback"];
  for (const kind of order) {
    const match = endpoints.find((e) => e.kind === kind);
    if (match) return match;
  }
  return undefined;
}

function isTailscale(interfaceName: string, address: string): boolean {
  if (interfaceName.startsWith("tailscale")) return true;
  // 100.64.0.0/10, the CGNAT range Tailscale uses.
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

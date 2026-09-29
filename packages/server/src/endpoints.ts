/**
 * The one way a phone reaches this daemon.
 *
 * With a relay configured, that is the relay's origin: it serves the PWA and
 * carries every route. Without one the daemon is local only, for a browser on
 * this machine, the sandbox, and development. There is no discovery of LAN or
 * VPN addresses: an https app cannot call plain-http ones anyway.
 *
 * Keyed by a stable identity rather than by URL, so a client remembers the
 * route, not an address that might one day mean another machine.
 */
export interface Endpoint {
  key: string;
  url: string;
  kind: "relay" | "local";
}

export function advertisedEndpoint(port: number, relayUrl: string | null): Endpoint {
  if (relayUrl) return { key: `relay:${new URL(relayUrl).host}`, url: relayUrl, kind: "relay" };
  const url = `http://localhost:${port}`;
  return { key: "local:", url, kind: "local" };
}

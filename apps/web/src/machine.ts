import { readVersioned, writeVersioned } from "@pios/client-core";
import { browserStorage } from "./storage.ts";

export const MACHINE_STORE_VERSION = 1;
const STORAGE_KEY = "pios.machines";

export interface Endpoint {
  /**
   * Stable identity of a route to the machine. A LAN address changes with the
   * network, so the URL is a hint and the key is what is remembered.
   */
  key: string;
  url: string;
  /**
   * Result of the last probe. Remembered so reopening the picker does not
   * pretend nothing was ever tested; it is a record of what happened, never
   * evidence that the endpoint is reachable now.
   */
  lastProbe?: { ok: boolean; at: number };
}

export interface Machine {
  id: string;
  label: string;
  deviceToken: string;
  endpoints: Endpoint[];
  /** Endpoint key last known to work. Tried first, never trusted blindly. */
  preferredKey: string | null;
}

export interface MachineStore {
  machines: Machine[];
  activeId: string | null;
}

const EMPTY: MachineStore = { machines: [], activeId: null };

export function loadMachines(): MachineStore {
  return readVersioned(browserStorage, STORAGE_KEY, MACHINE_STORE_VERSION, EMPTY);
}

export function saveMachines(store: MachineStore): void {
  writeVersioned(browserStorage, STORAGE_KEY, MACHINE_STORE_VERSION, store);
}

export function activeMachine(store: MachineStore): Machine | null {
  return store.machines.find((m) => m.id === store.activeId) ?? null;
}

/** The URL the supervisor should dial for a machine. */
export function socketUrl(machine: Machine): string | null {
  const endpoint =
    machine.endpoints.find((e) => e.key === machine.preferredKey) ?? machine.endpoints[0];
  if (!endpoint) return null;
  // A stored address can be malformed; a throw here would blank the whole app.
  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    return null;
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

export function httpBase(machine: Machine): string | null {
  const endpoint =
    machine.endpoints.find((e) => e.key === machine.preferredKey) ?? machine.endpoints[0];
  return endpoint?.url ?? null;
}

export interface PairResult {
  deviceToken: string;
  deviceId: string;
  serverVersion: string;
}

/**
 * Exchanges a one-shot pairing token for a long-lived device token.
 *
 * The pairing token arrived in the URL fragment, which browsers never send to
 * a server, so it exists only in this tab. The caller strips it from history
 * as soon as this resolves.
 */
export async function pairWithMachine(
  baseUrl: string,
  pairingToken: string,
  label: string,
): Promise<PairResult> {
  const response = await fetch(new URL("/pair", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingToken, label }),
  });
  if (!response.ok) throw new Error(`pairing rejected (${response.status})`);
  return (await response.json()) as PairResult;
}

/** Probes an endpoint. Only a successful response proves it is reachable. */
export async function probeEndpoint(url: string, timeoutMs = 3000): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("/health", url), { signal: abort.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

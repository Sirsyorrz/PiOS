import { readVersioned, writeVersioned } from "@pios/client-core";
import { browserStorage } from "./storage.ts";

export const MACHINE_STORE_VERSION = 2;
const STORAGE_KEY = "pios.machines";

export interface Machine {
  id: string;
  label: string;
  deviceToken: string;
  /**
   * The one route to the machine: its relay, which is normally this page's
   * own origin, or the daemon itself during local development.
   */
  url: string;
}

export interface MachineStore {
  machines: Machine[];
  activeId: string | null;
}

const EMPTY: MachineStore = { machines: [], activeId: null };

export function loadMachines(): MachineStore {
  return readVersioned(browserStorage, STORAGE_KEY, MACHINE_STORE_VERSION, EMPTY, migrateMachines);
}

export function saveMachines(store: MachineStore): void {
  writeVersioned(browserStorage, STORAGE_KEY, MACHINE_STORE_VERSION, store);
}

interface MachineV1 {
  id: string;
  label: string;
  deviceToken: string;
  endpoints: { key: string; url: string }[];
  preferredKey: string | null;
}

/**
 * v1 kept several routes per machine and let the user pick. Only one survives:
 * the one last known to work, else the first. A machine with no route left is
 * dropped rather than kept as a row that can never connect.
 */
export function migrateMachines(data: unknown, fromVersion: number): MachineStore {
  if (fromVersion !== 1 || !data || typeof data !== "object") return EMPTY;
  const old = data as { machines?: MachineV1[]; activeId?: string | null };
  const machines: Machine[] = [];
  for (const machine of old.machines ?? []) {
    const endpoint =
      machine.endpoints?.find((e) => e.key === machine.preferredKey) ?? machine.endpoints?.[0];
    if (!endpoint) continue;
    machines.push({
      id: machine.id,
      label: machine.label,
      deviceToken: machine.deviceToken,
      url: endpoint.url,
    });
  }
  const activeId = machines.some((m) => m.id === old.activeId) ? (old.activeId ?? null) : null;
  return { machines, activeId };
}

export function activeMachine(store: MachineStore): Machine | null {
  return store.machines.find((m) => m.id === store.activeId) ?? null;
}

/** The URL the supervisor should dial for a machine. */
export function socketUrl(machine: Machine): string | null {
  // A stored address can be malformed; a throw here would blank the whole app.
  let url: URL;
  try {
    url = new URL(machine.url);
  } catch {
    return null;
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

/** The base URL for this machine's HTTP routes: files, pairing, push. */
export function httpBase(machine: Machine): string | null {
  return machine.url || null;
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

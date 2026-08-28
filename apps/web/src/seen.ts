import { browserStorage } from "./storage.ts";

/**
 * Which sessions the user has already looked at, per machine.
 *
 * A session that finished its turn while the app was elsewhere looks exactly
 * like one the user read and left: both are `idle`. Storing the `updatedAt`
 * the user last saw is what separates "done, unread" from "done, seen".
 */
const KEY = "pios.seen.v1";

type SeenMap = Record<string, number>;

function key(machineId: string) {
  return `${KEY}.${machineId}`;
}

export function loadSeen(machineId: string): SeenMap {
  const raw = browserStorage.get(key(machineId));
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: SeenMap = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number") out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/** Returns the updated map so callers can drive state off one value. */
export function markSeen(machineId: string, sessionId: string, updatedAt: number): SeenMap {
  const seen = loadSeen(machineId);
  if (seen[sessionId] === updatedAt) return seen;
  const next = { ...seen, [sessionId]: updatedAt };
  browserStorage.set(key(machineId), JSON.stringify(next));
  return next;
}

export function isUnseen(seen: SeenMap, sessionId: string, updatedAt: number): boolean {
  const at = seen[sessionId];
  // Never opened counts as unseen: the row is still news to the user.
  return at === undefined || at < updatedAt;
}

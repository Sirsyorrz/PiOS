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

/**
 * Records sessions this client has never heard of at their current state.
 *
 * Without this, first contact with a machine marks every session in its
 * history as unread, which is noise about work the user finished days ago.
 * "Complete" means finished since you last looked, and before the first look
 * there is nothing to have missed.
 */
export function seedSeen(
  machineId: string,
  sessions: readonly { sessionId: string; updatedAt: number }[],
): SeenMap {
  const seen = loadSeen(machineId);
  let changed = false;
  const next = { ...seen };
  for (const s of sessions) {
    if (next[s.sessionId] === undefined) {
      next[s.sessionId] = s.updatedAt;
      changed = true;
    }
  }
  if (!changed) return seen;
  browserStorage.set(key(machineId), JSON.stringify(next));
  return next;
}

export function isUnseen(seen: SeenMap, sessionId: string, updatedAt: number): boolean {
  const at = seen[sessionId];
  // Unknown means not yet seeded, not new work; treat it as read.
  return at !== undefined && at < updatedAt;
}

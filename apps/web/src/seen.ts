import { useEffect, useState } from "react";
import { browserStorage } from "./storage.ts";

/**
 * Which sessions the user has already looked at, per machine.
 *
 * A session that finished its turn while the app was elsewhere looks exactly
 * like one the user read and left: both are `idle`. Storing the `updatedAt`
 * the user last saw is what separates "done, unread" from "done, seen".
 */
const STORAGE_PREFIX = "pios.seen.v1";

type SeenMap = Record<string, number>;

function storageKey(machineId: string) {
  return `${STORAGE_PREFIX}.${machineId}`;
}

export function loadSeen(machineId: string): SeenMap {
  const raw = browserStorage.get(storageKey(machineId));
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
  browserStorage.set(storageKey(machineId), JSON.stringify(next));
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
  browserStorage.set(storageKey(machineId), JSON.stringify(next));
  return next;
}

export function isUnseen(seen: SeenMap, sessionId: string, updatedAt: number): boolean {
  const at = seen[sessionId];
  // Unknown means not yet seeded, not new work; treat it as read.
  return at !== undefined && at < updatedAt;
}

/**
 * Keeps the read marks in step with the session list.
 *
 * The open session is being read as it moves, so it is never unread; marking
 * on every update keeps the badge honest the moment the user leaves it.
 */
export function useUnreadMarks(
  machineId: string,
  sessions: readonly { sessionId: string; updatedAt: number }[],
  synced: boolean,
  activeId: string | null,
): SeenMap {
  const [seen, setSeen] = useState(() => loadSeen(machineId));

  useEffect(() => {
    if (!synced) return;
    setSeen(seedSeen(machineId, sessions));
  }, [machineId, synced, sessions]);

  useEffect(() => {
    if (!activeId) return;
    const open = sessions.find((s) => s.sessionId === activeId);
    if (open) setSeen(markSeen(machineId, activeId, open.updatedAt));
  }, [activeId, machineId, sessions]);

  return seen;
}

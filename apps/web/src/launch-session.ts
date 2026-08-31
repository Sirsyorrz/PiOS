import { useEffect, useState } from "react";
import type { SupervisorState } from "@pios/client-core";
import type { Machine } from "./machine.ts";
import { browserStorage } from "./storage.ts";

// iOS evicts a backgrounded PWA and relaunches it from scratch, so the open
// session has to be remembered somewhere durable or every app switch dumps
// the user back on the session list.
const activeSessionKey = (machineId: string) => `pios.active-session.${machineId}`;

export interface LaunchSession {
  /** The session on screen, or null for the session list. */
  activeId: string | null;
  setActiveId: (next: string | null) => void;
}

/**
 * Session a notification tap asked for.
 *
 * Consumed once and stripped from the URL, so a relaunch from the home screen
 * does not keep reopening whatever was tapped days ago.
 */
function deepLinkedSession(): string | null {
  const requested = new URL(window.location.href).searchParams.get("session");
  if (!requested) return null;
  const url = new URL(window.location.href);
  url.searchParams.delete("session");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  return requested;
}

/**
 * Decides which session a launch lands on and remembers it.
 *
 * Two things can name it: a notification deep link, or the session left open
 * before the app was evicted. Failing both, the launch lands on the session
 * list.
 */
export function useLaunchSession(machine: Machine, state: SupervisorState): LaunchSession {
  const [activeId, setActiveIdState] = useState<string | null>(() => {
    const linked = deepLinkedSession();
    // Remembered like any other opened session: iOS may relaunch this app cold
    // moments later, and the query string is already gone by then.
    if (linked) browserStorage.set(activeSessionKey(machine.id), linked);
    return linked ?? browserStorage.get(activeSessionKey(machine.id));
  });

  function setActiveId(next: string | null) {
    const key = activeSessionKey(machine.id);
    if (next) browserStorage.set(key, next);
    else browserStorage.remove(key);
    setActiveIdState(next);
  }

  // A restored session can be gone by the time the daemon answers; only a
  // live session list proves that, so nothing is dropped while offline.
  useEffect(() => {
    if (!activeId || state.sync !== "synced") return;
    const known = state.sessions.find((s) => s.sessionId === activeId);
    if (known && known.status !== "disposed") return;
    browserStorage.remove(activeSessionKey(machine.id));
    setActiveIdState(null);
  }, [activeId, machine.id, state.sync, state.sessions]);

  return { activeId, setActiveId };
}

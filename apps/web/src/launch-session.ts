import { useState } from "react";
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
 * list. A remembered id is never dropped from here: the list is paged, so its
 * absence from the page on screen proves nothing about the session.
 */
export function useLaunchSession(machine: Machine): LaunchSession {
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

  return { activeId, setActiveId };
}

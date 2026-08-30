import { useEffect, useRef, useState } from "react";
import type { PiosClient, SupervisorState } from "@pios/client-core";
import { httpBase, type Machine } from "./machine.ts";
import { browserStorage } from "./storage.ts";
import { fetchHomeDir } from "./files.ts";

// iOS evicts a backgrounded PWA and relaunches it from scratch, so the open
// session has to be remembered somewhere durable or every app switch dumps
// the user back on the session list.
const activeSessionKey = (machineId: string) => `pios.active-session.${machineId}`;
// The home directory costs an HTTP round trip to learn and never changes for
// a machine, so caching it keeps the launch chat from arriving late.
const homeDirKey = (machineId: string) => `pios.home-dir.${machineId}`;

// An unreachable daemon must not hold the splash forever: the session list
// still offers settings, pairing and the offline banners.
const splashTimeoutMs = 4000;

export interface LaunchSession {
  /** The session on screen, or null for the session list. */
  activeId: string | null;
  setActiveId: (next: string | null) => void;
  /** True while the splash should cover an empty screen. */
  opening: boolean;
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
 * Three things can name it: a notification deep link, the session left open
 * before the app was evicted, or, failing both, a session in the daemon's
 * home directory. Landing on the session list instead is a dead end, because
 * this is a chat client.
 */
export function useLaunchSession(
  machine: Machine,
  state: SupervisorState,
  client: PiosClient,
): LaunchSession {
  const [activeId, setActiveIdState] = useState<string | null>(() => {
    const linked = deepLinkedSession();
    // Remembered like any other opened session: iOS may relaunch this app cold
    // moments later, and the query string is already gone by then.
    if (linked) browserStorage.set(activeSessionKey(machine.id), linked);
    return linked ?? browserStorage.get(activeSessionKey(machine.id));
  });
  // Auto-open runs once per launch, and only while no session has been chosen.
  const autoOpened = useRef(false);
  // Nothing below the splash is worth a flash of the session list first.
  const [opening, setOpening] = useState(
    () => !browserStorage.get(activeSessionKey(machine.id)),
  );

  function setActiveId(next: string | null) {
    // Leaving a chat is a deliberate move to the session list; the launch
    // auto-open must not drag the user straight back into a chat.
    autoOpened.current = true;
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
    // Dropped rather than closed, so auto-open is free to run again.
    browserStorage.remove(activeSessionKey(machine.id));
    setActiveIdState(null);
  }, [activeId, machine.id, state.sync, state.sessions]);

  const base = httpBase(machine);
  useEffect(() => {
    if (autoOpened.current || activeId || state.transport !== "connected" || !base) return;
    autoOpened.current = true;
    let live = true;
    let opened = false;
    const open = (home: string) => {
      opened = true;
      // An existing session in the same directory is the one the user means;
      // a fresh one per launch would pile up empty transcripts.
      const existing = state.sessions.find((s) => s.status !== "disposed" && s.cwd === home);
      if (existing) return setActiveId(existing.sessionId);
      client.createSession({ cwd: home, trustProject: true }, setActiveId);
    };

    const cached = browserStorage.get(homeDirKey(machine.id));
    if (cached) open(cached);
    void (async () => {
      const home = await fetchHomeDir(base, machine.deviceToken);
      if (home) browserStorage.set(homeDirKey(machine.id), home);
      if (!live) return;
      if (home && !cached) open(home);
      setOpening(false);
    })();
    return () => {
      live = false;
      // A run torn down before it opened anything (a remount, or StrictMode's
      // double invoke) must not consume the one auto-open of this launch.
      if (!opened) autoOpened.current = false;
    };
  }, [activeId, state.transport, base, client, machine.deviceToken, machine.id]);

  useEffect(() => {
    if (!opening) return;
    const timer = setTimeout(() => setOpening(false), splashTimeoutMs);
    return () => clearTimeout(timer);
  }, [opening]);

  return { activeId, setActiveId, opening };
}

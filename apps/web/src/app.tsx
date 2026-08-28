import { useEffect, useMemo, useRef, useState } from "react";
import { ClientProvider, useClient, useSupervisorState } from "./client-provider.tsx";
import {
  activeMachine,
  httpBase,
  loadMachines,
  saveMachines,
  socketUrl,
  type Machine,
  type MachineStore,
} from "./machine.ts";
import { Banners } from "./components/banners.tsx";
import { ChatView } from "./components/chat-view.tsx";
import { DirectoryPicker } from "./components/directory-picker.tsx";
import { PairingScreen } from "./components/pairing-screen.tsx";
import { ResumePicker } from "./components/resume-picker.tsx";
import { SettingsIcon } from "./components/icons.tsx";
import { SessionList } from "./components/session-list.tsx";
import { SettingsView } from "./components/settings-view.tsx";
import { loadSettings, saveSettings, SettingsProvider, type Settings } from "./settings.ts";
import { loadSeen, markSeen, seedSeen } from "./seen.ts";
import { browserStorage } from "./storage.ts";
import { fetchHomeDir } from "./files.ts";

// iOS evicts a backgrounded PWA and relaunches it from scratch, so the open
// session has to be remembered somewhere durable or every app switch dumps
// the user back on the session list.
const activeSessionKey = (machineId: string) => `pios.active-session.${machineId}`;
// The home directory costs an HTTP round trip to learn and never changes for
// a machine, so caching it keeps the launch chat from arriving late.
const homeDirKey = (machineId: string) => `pios.home-dir.${machineId}`;

export function App() {
  const [store, setStore] = useState<MachineStore>(loadMachines);
  const [settings, setSettingsState] = useState<Settings>(loadSettings);

  function update(next: MachineStore) {
    saveMachines(next);
    setStore(next);
  }

  function setSettings(next: Settings) {
    saveSettings(next);
    setSettingsState(next);
  }

  const machine = activeMachine(store);
  if (!machine) {
    return (
      <PairingScreen
        onPaired={(paired) =>
          update({ machines: [...store.machines, paired], activeId: paired.id })
        }
      />
    );
  }

  return (
    <ClientProvider url={socketUrl(machine)} token={machine.deviceToken}>
      <SettingsProvider value={settings}>
      <Workspace
        machine={machine}
        settings={settings}
        onSettingsChange={setSettings}
        onMachineChange={(next) =>
          update({
            machines: store.machines.map((m) => (m.id === next.id ? next : m)),
            activeId: store.activeId,
          })
        }
        onForget={() =>
          update({
            machines: store.machines.filter((m) => m.id !== machine.id),
            activeId: null,
          })
        }
      />
      </SettingsProvider>
    </ClientProvider>
  );
}

function Workspace({ machine, settings, onSettingsChange, onMachineChange, onForget }: {
  machine: Machine;
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  onMachineChange: (machine: Machine) => void;
  onForget: () => void;
}) {
  const client = useClient();
  const state = useSupervisorState();
  const [activeId, setActiveIdState] = useState<string | null>(() =>
    browserStorage.get(activeSessionKey(machine.id)),
  );
  // Launching into the session list is a dead end: the app is a chat client,
  // so a launch that is not resuming a session opens one in the home
  // directory instead. Once per launch only.
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

  /** Drops a session the user did not close, leaving auto-open free to run. */
  function clearActive() {
    browserStorage.remove(activeSessionKey(machine.id));
    setActiveIdState(null);
  }
  const [seen, setSeen] = useState(() => loadSeen(machine.id));
  // Sessions this client has never seen start out read, so first contact with
  // a machine does not flag its whole history as freshly finished work.
  useEffect(() => {
    if (state.sync !== "synced") return;
    setSeen(seedSeen(machine.id, state.sessions));
  }, [machine.id, state.sync, state.sessions]);

  // An open session is being read as it moves, so it is never unread. Marking
  // on every update keeps the badge honest the moment the user leaves.
  useEffect(() => {
    if (!activeId) return;
    const open = state.sessions.find((s) => s.sessionId === activeId);
    if (open) setSeen(markSeen(machine.id, activeId, open.updatedAt));
  }, [activeId, machine.id, state.sessions]);

  // Null means "not picking"; a string is the directory to open the picker in.
  const [picking, setPicking] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Session commands are not queued, so a dropped one has to be said out loud.
  const [notice, setNotice] = useState<string | null>(null);

  // A restored session can be gone by the time the daemon answers; only a
  // live session list proves that, so nothing is dropped while offline.
  useEffect(() => {
    if (!activeId || state.sync !== "synced") return;
    const known = state.sessions.find((s) => s.sessionId === activeId);
    if (!known || known.status === "disposed") clearActive();
  }, [activeId, state.sync, state.sessions]);

  const session = useMemo(
    () => state.sessions.find((s) => s.sessionId === activeId) ?? null,
    [state.sessions, activeId],
  );
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

  // An unreachable daemon must not hold the splash forever: the session list
  // still offers settings, pairing and the offline banners.
  useEffect(() => {
    if (!opening) return;
    const timer = setTimeout(() => setOpening(false), 4000);
    return () => clearTimeout(timer);
  }, [opening]);

  // A rejected session command has no other place to appear: it is not queued
  // and it does not make the transcript stale.
  useEffect(
    () => client.onCommandError((error) => setNotice(`Rejected by the daemon: ${error.message}`)),
    [client],
  );

  // Connecting is the slow part of a launch, and the splash covers it. Below
  // every hook: an early return above one changes the hook order.
  if (opening && !activeId) {
    return (
      <div className="splash">
        <span className="spinner" />
      </div>
    );
  }

  if (showSettings) {
    return (
      <SettingsView
        settings={settings}
        machine={machine}
        onChange={onSettingsChange}
        onMachineChange={onMachineChange}
        onForget={onForget}
        onClose={() => setShowSettings(false)}
      />
    );
  }

  if (resuming) {
    return (
      <ResumePicker
        onCancel={() => setResuming(false)}
        onResume={(session) => {
          // Same call as a new session: the daemon decides whether this is an
          // attach to something already open or a fresh load of the file.
          const sent = client.createSession(
            { cwd: session.cwd, name: session.name, trustProject: true, resumeFrom: session.path },
            setActiveId,
          );
          setNotice(sent ? null : "Not connected: the session was not resumed.");
          setResuming(false);
        }}
      />
    );
  }

  if (picking !== null && base) {
    return (
      <DirectoryPicker
        baseUrl={base}
        token={machine.deviceToken}
        startPath={picking || null}
        onCancel={() => setPicking(null)}
        onPick={(cwd, trustProject) => {
          // Opened as soon as the daemon names it: starting a session and
          // being left on the list is not what the tap asked for.
          const sent = client.createSession({ cwd, trustProject }, setActiveId);
          setNotice(sent ? null : "Not connected: the session was not started.");
          setPicking(null);
        }}
      />
    );
  }

  return (
    <div className={`workspace ${activeId ? "chatting" : ""}`}>
      <aside className="sidebar">
        {/* Machine and link state are one subject, so they are one control;
            it opens the same screen the gear does. */}
        <header className="row">
          <button
            type="button"
            className="ghost machine"
            onClick={() => setShowSettings(true)}
          >
            <span className={`dot ${state.transport}`} title={state.transport} />
            <span className="line">{machine.label}</span>
          </button>
          <button
            type="button"
            className="ghost icon"
            aria-label="settings"
            onClick={() => setShowSettings(true)}
          >
            <SettingsIcon />
          </button>
        </header>

        {notice ? (
          <p className="banner error" onClick={() => setNotice(null)}>
            {notice}
          </p>
        ) : null}


        <SessionList
          sessions={state.sessions.filter((s) => s.status !== "disposed")}
          activeId={activeId}
          seen={seen}
          onSelect={setActiveId}
          onCreate={() => setPicking("")}
          onResume={() => setResuming(true)}
          onDispose={(sessionId) => {
            client.disposeSession(sessionId);
            if (sessionId === activeId) setActiveId(null);
          }}
        />
      </aside>

      {activeId ? (
        <ChatView
          sessionId={activeId}
          session={session}
          state={state}
          baseUrl={base}
          deviceToken={machine.deviceToken}
          onBack={() => setActiveId(null)}
          onNewSession={() => setPicking(session?.cwd ?? "")}
          // pi reads trust at launch, so the daemon relaunches this session in
          // place. Same id, same transcript, nothing to switch to.
          onTrust={() => {
            if (!session) return;
            const sent = client.setSessionTrust(session.sessionId, true);
            setNotice(sent ? null : "Not connected: the directory was not trusted.");
          }}
        />
      ) : (
        <section className="empty">
          <Banners
            state={state}
            view={null}
            session={null}
            onTrust={() => {}}
            onDismissNotice={() => {}}
          />
        </section>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
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
import { EndpointPicker } from "./components/endpoint-picker.tsx";
import { PairingScreen } from "./components/pairing-screen.tsx";
import { ResumePicker } from "./components/resume-picker.tsx";
import { ChevronDownIcon } from "./components/icons.tsx";
import { SessionList } from "./components/session-list.tsx";
import { browserStorage } from "./storage.ts";

// iOS evicts a backgrounded PWA and relaunches it from scratch, so the open
// session has to be remembered somewhere durable or every app switch dumps
// the user back on the session list.
const activeSessionKey = (machineId: string) => `pios.active-session.${machineId}`;

export function App() {
  const [store, setStore] = useState<MachineStore>(loadMachines);

  function update(next: MachineStore) {
    saveMachines(next);
    setStore(next);
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
      <Workspace
        machine={machine}
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
    </ClientProvider>
  );
}

function Workspace({ machine, onMachineChange, onForget }: {
  machine: Machine;
  onMachineChange: (machine: Machine) => void;
  onForget: () => void;
}) {
  const client = useClient();
  const state = useSupervisorState();
  const [activeId, setActiveIdState] = useState<string | null>(() =>
    browserStorage.get(activeSessionKey(machine.id)),
  );

  function setActiveId(next: string | null) {
    const key = activeSessionKey(machine.id);
    if (next) browserStorage.set(key, next);
    else browserStorage.remove(key);
    setActiveIdState(next);
  }
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
    if (!known || known.status === "disposed") setActiveId(null);
  }, [activeId, state.sync, state.sessions]);

  const session = useMemo(
    () => state.sessions.find((s) => s.sessionId === activeId) ?? null,
    [state.sessions, activeId],
  );

  // A rejected session command has no other place to appear: it is not queued
  // and it does not make the transcript stale.
  useEffect(
    () => client.onCommandError((error) => setNotice(`Rejected by the daemon: ${error.message}`)),
    [client],
  );
  const base = httpBase(machine);

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
        {/* Machine, link state and the disclosure are one control: they are
            all the same subject, and three of them in a row read as three
            unrelated things to press. */}
        <header>
          <button
            type="button"
            className="ghost machine"
            aria-expanded={showSettings}
            onClick={() => setShowSettings(!showSettings)}
          >
            <span className={`dot ${state.transport}`} title={state.transport} />
            <span className="line">{machine.label}</span>
            <ChevronDownIcon className={`caret ${showSettings ? "flip" : ""}`} />
          </button>
        </header>

        {notice ? (
          <p className="banner error" onClick={() => setNotice(null)}>
            {notice}
          </p>
        ) : null}

        {showSettings ? (
          <EndpointPicker machine={machine} onChange={onMachineChange} onForget={onForget} />
        ) : null}

        <SessionList
          sessions={state.sessions.filter((s) => s.status !== "disposed")}
          activeId={activeId}
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

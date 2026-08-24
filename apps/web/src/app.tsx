import { useMemo, useState } from "react";
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
import { SessionList } from "./components/session-list.tsx";

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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Session commands are not queued, so a dropped one has to be said out loud.
  const [notice, setNotice] = useState<string | null>(null);

  const session = useMemo(
    () => state.sessions.find((s) => s.sessionId === activeId) ?? null,
    [state.sessions, activeId],
  );
  const base = httpBase(machine);

  if (picking && base) {
    return (
      <DirectoryPicker
        baseUrl={base}
        token={machine.deviceToken}
        onCancel={() => setPicking(false)}
        onPick={(cwd, trustProject) => {
          // Opened as soon as the daemon names it: starting a session and
          // being left on the list is not what the tap asked for.
          const sent = client.createSession({ cwd, trustProject }, setActiveId);
          setNotice(sent ? null : "Not connected: the session was not started.");
          setPicking(false);
        }}
      />
    );
  }

  return (
    <div className={`workspace ${activeId ? "chatting" : ""}`}>
      <aside className="sidebar">
        <header className="row spread">
          <button type="button" onClick={() => setShowSettings(!showSettings)}>
            {machine.label}
          </button>
          <span className={`dot ${state.transport}`} title={state.transport} />
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
          onCreate={() => setPicking(true)}
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
          onBack={() => setActiveId(null)}
          // Trust is decided when a session starts, so this starts a trusted
          // one in the same directory and switches to it.
          onTrust={() => {
            if (!session) return;
            const sent = client.createSession(
              { cwd: session.cwd, trustProject: true },
              setActiveId,
            );
            setNotice(sent ? null : "Not connected: the session was not started.");
          }}
        />
      ) : (
        <section className="empty">
          <Banners state={state} view={null} session={null} onTrust={() => {}} />
        </section>
      )}
    </div>
  );
}

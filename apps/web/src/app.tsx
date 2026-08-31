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
import { PairingScreen } from "./components/pairing-screen.tsx";
import { ResumePicker } from "./components/resume-picker.tsx";
import { SettingsIcon } from "./components/icons.tsx";
import type { NativeCommand } from "./components/native-commands.ts";
import { SessionList } from "./components/session-list.tsx";
import { SettingsView } from "./components/settings-view.tsx";
import { loadSettings, saveSettings, SettingsProvider, type Settings } from "./settings.ts";
import { useUnreadMarks } from "./seen.ts";
import { useAttentionReport } from "./attention.ts";
import { useLaunchSession } from "./launch-session.ts";
import { useKeepPushRegistered } from "./push.ts";

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
  const { activeId, setActiveId } = useLaunchSession(machine, state);
  const seen = useUnreadMarks(machine.id, state.sessions, state.sync === "synced", activeId);

  // The directory the picker opens in; null closes it, empty lets the daemon
  // choose where to start.
  const [pickerStart, setPickerStart] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Session commands are not queued, so a dropped one has to be said out loud.
  const [notice, setNotice] = useState<string | null>(null);

  const session = useMemo(
    () => state.sessions.find((s) => s.sessionId === activeId) ?? null,
    [state.sessions, activeId],
  );
  const base = httpBase(machine);

  /** pi reads trust at launch, so the daemon relaunches this session in
   *  place. Same id, same transcript, nothing to switch to. */
  function trustActive() {
    if (!session) return;
    const sent = client.setSessionTrust(session.sessionId, true);
    setNotice(sent ? null : "Not connected: the directory was not trusted.");
  }

  /**
   * pi's terminal commands that map to a screen this app already has, named
   * as pi names them so what is learned there works here.
   */
  function screenCommands(): NativeCommand[] {
    const commands: NativeCommand[] = [
      {
        name: "new",
        description: "Start a new session",
        run: () => setPickerStart(session?.cwd ?? ""),
      },
      { name: "resume", description: "Pick from previous sessions", run: () => setResuming(true) },
      { name: "sessions", description: "Back to the session list", run: () => setActiveId(null) },
      {
        name: "settings",
        description: "Machine, notifications, delivery",
        run: () => setShowSettings(true),
      },
    ];
    if (session && !session.trusted) {
      commands.push({ name: "trust", description: "Trust this directory", run: trustActive });
    }
    return commands;
  }

  useAttentionReport(client, activeId, state.transport);
  useKeepPushRegistered(base, machine.deviceToken);

  // A rejected session command has no other place to appear: it is not queued
  // and it does not make the transcript stale.
  useEffect(
    () => client.onCommandError((error) => setNotice(`Rejected by the daemon: ${error.message}`)),
    [client],
  );

  // Below every hook: an early return above one changes the hook order.
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

  if (pickerStart !== null && base) {
    return (
      <DirectoryPicker
        baseUrl={base}
        token={machine.deviceToken}
        startPath={pickerStart || null}
        onCancel={() => setPickerStart(null)}
        onPick={(cwd, trustProject) => {
          // Opened as soon as the daemon names it: starting a session and
          // being left on the list is not what the tap asked for.
          const sent = client.createSession({ cwd, trustProject }, setActiveId);
          setNotice(sent ? null : "Not connected: the session was not started.");
          setPickerStart(null);
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
          onCreate={() => setPickerStart("")}
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
          onNewSession={() => setPickerStart(session?.cwd ?? "")}
          nativeCommands={screenCommands()}
          onTrust={trustActive}
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

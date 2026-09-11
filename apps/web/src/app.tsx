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
import { SettingsIcon } from "./components/icons.tsx";
import type { NativeCommand } from "./components/native-commands.ts";
import { SessionList } from "./components/session-list.tsx";
import { SettingsView } from "./components/settings-view.tsx";
import { loadSettings, saveSettings, SettingsProvider, type Settings } from "./settings.ts";
import { adoptSandboxMachine } from "./sandbox.ts";
import { loadDrafts, saveDrafts, type Draft } from "./drafts.ts";
import { useUnreadMarks } from "./seen.ts";
import { useAttentionReport } from "./attention.ts";
import { useLaunchSession } from "./launch-session.ts";
import { useKeepPushRegistered } from "./push.ts";

export function App() {
  const [store, setStore] = useState<MachineStore>(() => adoptSandboxMachine() ?? loadMachines());
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
  const { activeId, setActiveId } = useLaunchSession(machine);
  const seen = useUnreadMarks(machine.id, state.sessions, state.sync === "synced", activeId);

  // The directory the picker opens in; null closes it, empty lets the daemon
  // choose where to start.
  const [pickerStart, setPickerStart] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>(() => loadDrafts(machine.id));
  // Narrow viewports show the list over the chat rather than instead of it,
  // so the open session keeps its scroll position and its composer draft.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  // Session commands are not queued, so a dropped one has to be said out loud.
  const [notice, setNotice] = useState<string | null>(null);

  const session = useMemo(
    () => state.sessions.find((s) => s.sessionId === activeId) ?? null,
    [state.sessions, activeId],
  );
  const draft = useMemo(
    () => drafts.find((d) => d.id === activeId) ?? null,
    [drafts, activeId],
  );
  const base = httpBase(machine);

  function updateDrafts(next: Draft[]) {
    saveDrafts(machine.id, next);
    setDrafts(next);
  }

  // The daemon owns the search: rows past the first page are not here to be
  // filtered. Debounced, so typing does not scan the store per keystroke.
  useEffect(() => {
    const timer = setTimeout(
      () => client.listSessions({ query: search.trim() || undefined }),
      search ? 200 : 0,
    );
    return () => clearTimeout(timer);
  }, [client, search, state.transport]);

  // The store changed on disk, e.g. the TUI started a session. The nudge
  // carries nothing: this client knows which page it is looking at.
  useEffect(() => client.onSessionsChanged(() => client.refreshSessions()), [client]);

  // A draft stops being a draft the moment its session exists.
  useEffect(() => {
    const live = new Set(state.sessions.map((s) => s.sessionId));
    const kept = drafts.filter((d) => !live.has(d.id));
    if (kept.length !== drafts.length) updateDrafts(kept);
  }, [state.sessions, drafts]);

  // A rewind branches into a session of its own, so the app follows it there
  // and leaves the conversation it came from in the list, intact.
  useEffect(() => client.onRewound((branchSessionId) => setActiveId(branchSessionId)), [
    client,
    setActiveId,
  ]);

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

  if (pickerStart !== null && base) {
    return (
      <DirectoryPicker
        baseUrl={base}
        token={machine.deviceToken}
        startPath={pickerStart || null}
        onCancel={() => setPickerStart(null)}
        onPick={(cwd, trustProject) => {
          // No daemon round trip: the session begins when the first prompt is
          // sent, under the id composed against here.
          const draft: Draft = {
            id: client.newSessionId(),
            cwd,
            trustProject,
            createdAt: Date.now(),
          };
          updateDrafts([draft, ...drafts]);
          setActiveId(draft.id);
          setDrawerOpen(false);
          setPickerStart(null);
        }}
      />
    );
  }

  return (
    <div className={`workspace ${activeId ? "chatting" : ""} ${drawerOpen ? "drawer" : ""}`}>
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
          sessions={state.sessions}
          drafts={drafts}
          activeId={activeId}
          seen={seen}
          query={search}
          loading={state.transport === "connected" && state.sessions.length === 0}
          hasMore={state.hasMoreSessions}
          onQuery={setSearch}
          onSelect={(id) => {
            setActiveId(id);
            setDrawerOpen(false);
          }}
          onCreate={() => setPickerStart("")}
          onLoadMore={() =>
            client.listSessions({ query: search || undefined, offset: state.sessions.length })
          }
        />
      </aside>

      {/* Dismisses the drawer without acting on whatever is behind it. */}
      {drawerOpen ? (
        <button
          type="button"
          className="scrim"
          aria-label="close the session list"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      {activeId ? (
        <ChatView
          sessionId={activeId}
          session={session}
          draft={draft}
          state={state}
          baseUrl={base}
          deviceToken={machine.deviceToken}
          onBack={() => setDrawerOpen(true)}
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

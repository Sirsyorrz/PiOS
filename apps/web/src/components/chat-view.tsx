import type { ImageContent, SessionSummary, StreamingBehavior } from "@pios/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useClient, useSessionView } from "../client-provider.tsx";
import { useEdgeSwipe } from "../edge-swipe.ts";
import { FileAccessContext } from "../files.ts";
import { basename, isolate, sessionTitle } from "../format.ts";
import { useStickToBottom } from "../scroll.ts";
import type { SessionView, SupervisorState } from "@pios/client-core";
import { Banners } from "./banners.tsx";
import { Composer } from "./composer.tsx";
import type { NativeCommand } from "./native-commands.ts";
import { sessionState } from "../session-status.ts";
import { DialogSheet } from "./dialog-sheet.tsx";
import { GitControl } from "./git-view.tsx";
import { FileView } from "./file-view.tsx";
import { recallOpenFile, rememberOpenFile } from "../file-edit.ts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  FileIcon,
  PauseIcon,
  PlusIcon,
  WarningIcon,
} from "./icons.tsx";
import type { SessionState } from "../session-status.ts";
import { BashCard, MessageBubble, StreamingBubble } from "./message.tsx";
import { SessionStatsFooter } from "./session-stats.tsx";
import { useSettings } from "../settings.ts";
import type { Draft } from "../drafts.ts";

/**
 * The session's state as a glyph, or nothing at all when it is idle.
 *
 * Idle is the default and restating it costs a quarter of the row; the states
 * that change what you do next are told apart by shape, since a single dot
 * cannot distinguish "waiting on you" from "broken". The word survives in the
 * session list and in the label here.
 */
function StatusMark({ state }: { state: SessionState }) {
  if (state.tone === "idle" || state.tone === "cold" || state.tone === "complete") return null;
  return (
    <span className={`status-mark ${state.tone}`} role="img" aria-label={state.label} title={state.label}>
      {state.tone === "running" ? <span className="spinner" /> : null}
      {state.tone === "waiting" ? <PauseIcon /> : null}
      {state.tone === "crashed" || state.tone === "untrusted" ? <WarningIcon /> : null}
    </span>
  );
}

/** Extension widgets for one slot. pi defaults an unplaced widget above. */
function widgets(view: SessionView | null, placement: "aboveEditor" | "belowEditor") {
  const items = (view?.presentation.widgets ?? []).filter(
    (widget) => (widget.placement ?? "aboveEditor") === placement,
  );
  if (items.length === 0) return null;
  return (
    <div className="ext-widgets">
      {items.map((widget) => (
        <div key={widget.key} className="ext-widget">
          {widget.lines.map((line, index) => (
            <div key={index} className="line">
              {line}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ChatView({
  sessionId,
  session,
  draft,
  state,
  baseUrl,
  deviceToken,
  onTrust,
  onBack,
  onNewSession,
  nativeCommands,
}: {
  sessionId: string;
  session: SessionSummary | null;
  /** Set while this is a composer with no session behind it yet. */
  draft: Draft | null;
  state: SupervisorState;
  /** Daemon HTTP origin, for files and uploads. */
  baseUrl: string | null;
  deviceToken: string;
  onTrust: () => void;
  onBack: () => void;
  onNewSession: () => void;
  /** Commands this client runs itself, offered beside pi's own. */
  nativeCommands: NativeCommand[];
}) {
  const client = useClient();
  const view = useSessionView(sessionId);
  const settings = useSettings();
  const pane = useRef<HTMLElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const transcript = useStickToBottom(view);
  // Typing collapses the chrome around the field, so the keyboard leaves as
  // much transcript on screen as possible.
  const [composing, setComposing] = useState(false);
  // Same destination as the back button, for the gesture that replaces it.
  const edgeSwipe = useEdgeSwipe(onBack);

  // The dock floats over the transcript, so the transcript has to reserve
  // exactly as much room as the dock currently takes. That reservation is
  // padding, so it changes scrollHeight without resizing the scroller: the
  // pane cannot observe it and has to be told.
  useEffect(() => {
    const box = dock.current;
    if (!box) return;
    const measure = new ResizeObserver(() => {
      pane.current?.style.setProperty("--dock-height", `${box.offsetHeight}px`);
      transcript.settle();
    });
    measure.observe(box);
    return () => measure.disconnect();
  }, [transcript.settle]);

  // A draft has no session behind it yet, so everything a session would answer
  // for comes from the draft: its directory, and what it takes to start it.
  const create = useMemo(
    () =>
      draft
        ? {
            cwd: draft.cwd,
            // Named for the directory at birth, so the list never shows a
            // session whose name is the id it was given.
            name: basename(draft.cwd),
            trustProject: draft.trustProject,
          }
        : undefined,
    [draft],
  );
  const cwd = session?.cwd ?? draft?.cwd;
  const title = view?.presentation.title
    ? { text: view.presentation.title, path: false }
    : sessionTitle(session?.name, cwd);

  function send(text: string, images: ImageContent[], behavior?: StreamingBehavior) {
    client.prompt({
      sessionId,
      text,
      images,
      streamingBehavior: behavior,
      // The first prompt of a draft is what creates the session, so the
      // directory travels with it rather than ahead of it.
      create,
    });
  }

  // A branched session opens with the turn it was cut before already typed.
  // Claimed on mount, because the branch was created while another session
  // was on screen. Stamped, so the same text twice still reaches the composer.
  const [rewound, setRewound] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => {
    const text = client.takeRewoundText(sessionId);
    setRewound(text === undefined ? null : { text, at: Date.now() });
  }, [client, sessionId]);

  // One at a time, oldest first: an extension chains its questions, and a
  // stack of sheets makes it unclear which one is being answered.
  const dialog = view?.dialogs[0];
  const rowState = sessionState(session ?? undefined, {
    running: view?.running,
    interrupting: view?.interrupting,
    // The local dialog leads the summary that announces it, and this client is
    // the one being asked.
    blocked: Boolean(dialog),
  });

  const files = useMemo(
    () => ({ baseUrl, deviceToken, sessionId }),
    [baseUrl, deviceToken, sessionId],
  );

  // The open file survives the app being backgrounded, so coming back lands
  // where the work was, and the header icon reopens it in one tap.
  const [openPath, setOpenPath] = useState<string | null>(() => recallOpenFile(sessionId));
  const [showFiles, setShowFiles] = useState(false);
  useEffect(() => {
    setOpenPath(recallOpenFile(sessionId));
    setShowFiles(false);
  }, [sessionId]);

  if (showFiles && baseUrl && cwd) {
    return (
      <FileAccessContext.Provider value={files}>
        {/* The same object the context carries: a fresh one on every
            streaming re-render would remount the editor. */}
        <FileView
          access={files}
          cwd={cwd}
          path={openPath}
          onOpen={(path) => {
            setOpenPath(path);
            rememberOpenFile(sessionId, path);
          }}
          onClose={() => setShowFiles(false)}
        />
      </FileAccessContext.Provider>
    );
  }

  return (
    <FileAccessContext.Provider value={files}>
    <section className={`chat${composing ? " composing" : ""}`} ref={pane} {...edgeSwipe}>
      <header className="chat-header">
        <button type="button" className="back icon ghost" onClick={onBack} aria-label="back to sessions">
          <ChevronLeftIcon />
        </button>
        {/* A path falls back to the directory it names, and is cut at the
            front: the end of a path is what tells two of them apart. */}
        <span className={`title line${title.path ? " tail" : ""}`}>
          {title.path ? isolate(title.text) : title.text}
        </span>
        <StatusMark state={rowState} />
        <button
          type="button"
          className="icon ghost"
          onClick={() => setShowFiles(true)}
          aria-label={openPath ? `open ${openPath}` : "browse files"}
        >
          <FileIcon />
        </button>
        {/* Starts from this session's cwd: a second agent on the same project
            is the common case, and it is one tap away. */}
        <button type="button" className="icon ghost" onClick={onNewSession} aria-label="new session">
          <PlusIcon />
        </button>
      </header>

      {/* Over the transcript rather than in the header: it is state of the
          directory, not a control of the session, and giving it a row of its
          own costs height on every screen that never looks at it.
          A draft has no session yet, so git is addressed by directory. */}
      <div className="git-float">
        <GitControl running={view?.running ?? false} cwd={session ? null : cwd} />
      </div>

      <div className="transcript scroll-y" ref={transcript.ref} onScroll={transcript.onScroll}>
        {/* The tail is loaded first, because a chat is read from the bottom;
            the rest is fetched only if someone goes looking for it. */}
        {view?.hasOlder ? (
          <button
            type="button"
            className="ghost older"
            onClick={() => client.loadOlderEntries(sessionId)}
          >
            Load earlier messages
          </button>
        ) : null}
        {view?.items.map((item) => {
          if (item.kind === "message") {
            return (
              <MessageBubble
                key={item.key}
                message={item.message}
                tools={view.tools}
                cwd={session?.cwd}
                blocked={view.dialogs.length > 0}
                // Only a persisted turn has an entry id to rewind to.
                onRewind={
                  item.entryId ? () => client.rewind(sessionId, item.entryId!) : undefined
                }
              />
            );
          }
          if (item.kind === "streaming") {
            return <StreamingBubble key={item.key} partial={item.partial} tools={view.tools} cwd={session?.cwd} blocked={view.dialogs.length > 0} />;
          }
          return (
            <div key={item.key} className={`bubble user pending ${item.entry.status}`}>
              {item.entry.text}
              <span className="muted">
                {item.entry.status === "failed" ? (item.entry.lastError ?? "failed") : "queued"}
              </span>
              {item.entry.status === "failed" ? (
                <span className="row">
                  <button type="button" onClick={() => client.outbox.requeue(item.entry.commandId)}>
                    Retry
                  </button>
                  <button type="button" onClick={() => client.outbox.discard(item.entry.commandId)}>
                    Discard
                  </button>
                </span>
              ) : null}
            </div>
          );
        })}
        {/* Held until pi's own entry for the run arrives, so the output does
            not blink out between the last delta and the transcript. */}
        {view?.bash ? (
          <BashCard
            command={view.bash.command}
            output={view.bash.output}
            exitCode={view.bash.result?.exitCode ?? undefined}
            cancelled={view.bash.result?.cancelled}
            excludeFromContext={view.bash.excludeFromContext}
            running={view.bash.running}
            onAbort={() => client.abortBash(sessionId)}
          />
        ) : null}
        {/* Not for a draft: there is nothing accounted for yet, and asking
            would be a question about a session that does not exist. */}
        {settings.showSessionStats && !draft ? (

          <SessionStatsFooter
            sessionId={sessionId}
            running={view?.running ?? false}
            onResize={transcript.settle}
          />
        ) : null}
      </div>

      <div className="dock" ref={dock}>
      {/* Only while the reader is away from the tail: at the bottom it would
          be a button that does nothing. */}
      {transcript.atBottom ? null : (
        <button
          type="button"
          className="scroll-bottom icon"
          onClick={transcript.scrollToBottom}
          aria-label="scroll to latest"
        >
          <ChevronDownIcon />
        </button>
      )}
      {view && view.presentation.status.length > 0 ? (
        <div className="ext-status row">
          {view.presentation.status.map((item) => (
            <span key={item.key} className="chip line">
              {item.text}
            </span>
          ))}
        </div>
      ) : null}
      {widgets(view, "aboveEditor")}

      {view && (view.queue.steering.length > 0 || view.queue.followUp.length > 0) ? (
        // The daemon's own queue, distinct from the outbox: these were
        // delivered and are waiting on the agent, not on the network.
        <div className="queue">
          {view.queue.steering.map((text, index) => (
            <div key={`s${index}`} className="queued steer">
              steering: {text}
            </div>
          ))}
          {view.queue.followUp.map((text, index) => (
            <div key={`f${index}`} className="queued follow">
              follow-up: {text}
            </div>
          ))}
        </div>
      ) : null}

      {/* Above the composer, not above the transcript: status belongs where
          the eye already is, next to what you are about to type. */}
      <Banners
        state={state}
        view={view}
        session={session}
        onTrust={onTrust}
        onDismissNotice={(id) => client.sessions.dismissNotice(sessionId, id)}
      />

      {/* The dialog takes the composer's place: the agent is blocked on it, so
          typing a prompt is not the next action, and the transcript it is
          asking about stays visible. */}
      {dialog ? (
        <DialogSheet
          key={dialog.id}
          request={dialog}
          onAnswer={(answer) => client.answerDialog(sessionId, dialog.id, answer)}
        />
      ) : (
        <Composer
          sessionId={sessionId}
          create={create}
          model={session?.model}
          thinkingLevel={session?.thinkingLevel}
          thinkingLevels={session?.thinkingLevels}
          running={view?.running ?? false}
          interrupting={view?.interrupting ?? false}
          editorText={rewound?.text ?? view?.presentation.editorText}
          editorTextKey={rewound?.at}
          nativeCommands={nativeCommands}
          onSend={send}
          onBash={(command, excludeFromContext) =>
            client.runBash(sessionId, command, excludeFromContext)
          }
          onInterrupt={() => client.interrupt(sessionId)}
          onComposingChange={setComposing}
        />
      )}
      {widgets(view, "belowEditor")}
      </div>
    </section>
    </FileAccessContext.Provider>
  );
}

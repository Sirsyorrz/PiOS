import type { ImageContent, SessionSummary, StreamingBehavior } from "@pios/protocol";
import { useEffect, useRef } from "react";
import { useClient, useSessionView } from "../client-provider.tsx";
import { useStickToBottom } from "../scroll.ts";
import type { SessionView, SupervisorState } from "@pios/client-core";
import { Banners } from "./banners.tsx";
import { Composer } from "./composer.tsx";
import { DialogSheet } from "./dialog-sheet.tsx";
import { ChevronLeftIcon } from "./icons.tsx";
import { MessageBubble, StreamingBubble } from "./message.tsx";

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

export function ChatView({ sessionId, session, state, onTrust, onBack }: {
  sessionId: string;
  session: SessionSummary | null;
  state: SupervisorState;
  onTrust: () => void;
  onBack: () => void;
}) {
  const client = useClient();
  const view = useSessionView(sessionId);
  const pane = useRef<HTMLElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const transcript = useStickToBottom(view);

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

  function send(text: string, images: ImageContent[], behavior?: StreamingBehavior) {
    client.prompt({ sessionId, text, images, streamingBehavior: behavior });
  }

  // One at a time, oldest first: an extension chains its questions, and a
  // stack of sheets makes it unclear which one is being answered.
  const dialog = view?.dialogs[0];

  return (
    <section className="chat" ref={pane}>
      <header className="chat-header">
        <button type="button" className="back icon ghost" onClick={onBack} aria-label="back to sessions">
          <ChevronLeftIcon />
        </button>
        <span className="title line">
          {view?.presentation.title ?? session?.name ?? session?.cwd ?? sessionId}
        </span>
        <span className={`status ${view?.running ? "running" : (session?.status ?? "idle")}`}>
          {view?.running ? <span className="spinner" /> : null}
          {view?.interrupting ? "stopping" : view?.running ? "running" : (session?.status ?? "")}
        </span>
      </header>

      <div className="transcript scroll-y" ref={transcript.ref} onScroll={transcript.onScroll}>
        {view?.items.map((item) => {
          if (item.kind === "message") {
            return <MessageBubble key={item.key} message={item.message} tools={view.tools} />;
          }
          if (item.kind === "streaming") {
            return <StreamingBubble key={item.key} partial={item.partial} tools={view.tools} />;
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
      </div>

      <div className="dock" ref={dock}>
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

      <Composer
        sessionId={sessionId}
        model={session?.model}
        running={view?.running ?? false}
        interrupting={view?.interrupting ?? false}
        editorText={view?.presentation.editorText}
        onSend={send}
        onInterrupt={() => client.interrupt(sessionId)}
      />
      {widgets(view, "belowEditor")}
      </div>

      {dialog ? (
        <DialogSheet
          key={dialog.id}
          request={dialog}
          onAnswer={(answer) => client.answerDialog(sessionId, dialog.id, answer)}
        />
      ) : null}
    </section>
  );
}

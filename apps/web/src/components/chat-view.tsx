import type { ImageContent, SessionSummary, StreamingBehavior } from "@pios/protocol";
import { useEffect, useRef } from "react";
import { useClient, useSessionView } from "../client-provider.tsx";
import type { SupervisorState } from "@pios/client-core";
import { Banners } from "./banners.tsx";
import { Composer } from "./composer.tsx";
import { MessageBubble, StreamingBubble } from "./message.tsx";

export function ChatView({ sessionId, session, state, onTrust, onBack }: {
  sessionId: string;
  session: SessionSummary | null;
  state: SupervisorState;
  onTrust: () => void;
  onBack: () => void;
}) {
  const client = useClient();
  const view = useSessionView(sessionId);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [view]);

  function send(text: string, images: ImageContent[], behavior?: StreamingBehavior) {
    client.prompt({ sessionId, text, images, streamingBehavior: behavior });
  }

  return (
    <section className="chat">
      <header className="chat-header">
        <button type="button" className="back icon" onClick={onBack} aria-label="back to sessions">
          &lsaquo;
        </button>
        <span className="title">{session?.name ?? session?.cwd ?? sessionId}</span>
        <span className={`status ${view?.running ? "running" : (session?.status ?? "idle")}`}>
          {view?.running ? "running" : (session?.status ?? "")}
        </span>
      </header>

      <div className="transcript">
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
        <div ref={bottom} />
      </div>

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
      <Banners state={state} view={view} session={session} onTrust={onTrust} />

      <Composer
        sessionId={sessionId}
        running={view?.running ?? false}
        onSend={send}
        onInterrupt={() => client.interrupt(sessionId)}
      />
    </section>
  );
}

import type { SessionSummary } from "@pios/protocol";
import { basename, shortenPath } from "../format.ts";
import { ListRowButton } from "./ui.tsx";

export function SessionList({ sessions, activeId, onSelect, onCreate, onResume, onDispose }: {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onResume: () => void;
  onDispose: (sessionId: string) => void;
}) {
  const ordered = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <nav className="sessions">
      <div className="row spread section-head">
        <h2>Sessions</h2>
        <span className="row">
          {/* Sessions started in the pi TUI live in the same directory, so
              they are reachable from here too. */}
          <button type="button" onClick={onResume}>
            Resume
          </button>
          <button type="button" onClick={onCreate}>
            New
          </button>
        </span>
      </div>
      {/* No empty list element: it would still take a gap and push the empty
          state away from its heading. */}
      {ordered.length === 0 ? (
        <p className="muted">No sessions yet.</p>
      ) : (
        <ul>
          {ordered.map((session) => (
            <li key={session.sessionId} className={session.sessionId === activeId ? "active" : ""}>
              <ListRowButton
                className="session"
                onClick={() => onSelect(session.sessionId)}
              >
                <span className="name line">{session.name ?? basename(session.cwd)}</span>
                <span className="muted line">{shortenPath(session.cwd)}</span>
                <span className="tags">
                  <span className={`status ${session.status}`}>{session.status}</span>
                  {session.trusted ? null : <span className="status untrusted">untrusted</span>}
                </span>
              </ListRowButton>
              {/* Inside the card, over its top corner: a sibling column made
                  every row wider than the sidebar could afford. */}
              <button
                type="button"
                className="icon danger dispose"
                aria-label={`dispose ${session.name ?? session.cwd}`}
                onClick={() => onDispose(session.sessionId)}
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

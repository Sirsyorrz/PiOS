import type { SessionSummary } from "@pios/protocol";

export function SessionList({ sessions, activeId, onSelect, onCreate, onDispose }: {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onDispose: (sessionId: string) => void;
}) {
  const ordered = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <nav className="sessions">
      <div className="row spread section-head">
        <h2>Sessions</h2>
        <button type="button" onClick={onCreate}>
          New
        </button>
      </div>
      {/* No empty list element: it would still take a gap and push the empty
          state away from its heading. */}
      {ordered.length === 0 ? (
        <p className="muted">No sessions yet.</p>
      ) : (
        <ul>
          {ordered.map((session) => (
            <li key={session.sessionId} className={session.sessionId === activeId ? "active" : ""}>
              <button type="button" onClick={() => onSelect(session.sessionId)}>
                <span className="name">{session.name ?? basename(session.cwd)}</span>
                <span className="muted">{shortenPath(session.cwd)}</span>
                <span className="tags">
                  <span className={`status ${session.status}`}>{session.status}</span>
                  {session.trusted ? null : <span className="status untrusted">untrusted</span>}
                </span>
              </button>
              <button
                type="button"
                className="icon danger"
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

/** The directory name alone; the full path is shown under it. */
function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `.../${parts.slice(-2).join("/")}`;
}

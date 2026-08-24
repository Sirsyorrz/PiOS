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
      <div className="row spread">
        <h2>Sessions</h2>
        <button type="button" onClick={onCreate}>
          New
        </button>
      </div>
      <ul>
        {ordered.map((session) => (
          <li key={session.sessionId} className={session.sessionId === activeId ? "active" : ""}>
            <button type="button" onClick={() => onSelect(session.sessionId)}>
              <span className="name">{session.name ?? shortenPath(session.cwd)}</span>
              <span className="muted">{shortenPath(session.cwd)}</span>
              <span className={`status ${session.status}`}>{session.status}</span>
              {session.trusted ? null : <span className="status untrusted">untrusted</span>}
            </button>
            <button
              type="button"
              className="danger"
              aria-label="dispose session"
              onClick={() => onDispose(session.sessionId)}
            >
              x
            </button>
          </li>
        ))}
      </ul>
      {ordered.length === 0 ? <p className="muted">No sessions yet.</p> : null}
    </nav>
  );
}

function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `.../${parts.slice(-2).join("/")}`;
}

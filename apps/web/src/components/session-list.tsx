import type { SessionSummary } from "@pios/protocol";
import { shortenPath } from "../format.ts";
import { isUnseen } from "../seen.ts";
import { sessionState } from "../session-status.ts";
import { HistoryIcon, PlusIcon, TrashIcon } from "./icons.tsx";
import { ListRowButton } from "./ui.tsx";

/**
 * The row's state, worded and coloured exactly as the open session's header
 * does it: a session waiting on a dialog has to be findable from the list.
 */
function SessionBadge({ session, unseen }: { session: SessionSummary; unseen: boolean }) {
  const state = sessionState(session, { unseen });
  return <span className={`badge ${state.tone}`}>{state.label}</span>;
}

export function SessionList({ sessions, activeId, seen, onSelect, onCreate, onResume, onDispose }: {
  sessions: SessionSummary[];
  activeId: string | null;
  /** Last `updatedAt` the user saw, by session id. */
  seen: Record<string, number>;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onResume: () => void;
  onDispose: (sessionId: string) => void;
}) {
  const ordered = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  // The opening message identifies a session far better than its directory,
  // which every session in a project shares.
  const sessionLabel = (session: SessionSummary) =>
    session.name ?? session.preview ?? shortenPath(session.cwd);

  return (
    <nav className="sessions">
      <div className="row spread section-head">
        <h2>Sessions</h2>
        <span className="row">
          {/* Sessions started in the pi TUI live in the same directory, so
              they are reachable from here too. */}
          <button type="button" className="ghost icon" aria-label="resume a session" onClick={onResume}>
            <HistoryIcon />
          </button>
          <button type="button" className="ghost icon" aria-label="new session" onClick={onCreate}>
            <PlusIcon />
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
                <span className="name line">{sessionLabel(session)}</span>
                <span className="muted line">{shortenPath(session.cwd)}</span>
                {/* Two lines, fixed: the row is a list entry, so state rides
                    in the corner rather than adding a third line to some
                    rows and not others. */}
                <SessionBadge
                  session={session}
                  unseen={isUnseen(seen, session.sessionId, session.updatedAt)}
                />
              </ListRowButton>
              {/* Over the row, not beside it: a sibling column made every row
                  wider than the sidebar could afford. */}
              <button
                type="button"
                className="icon ghost dispose"
                aria-label={`dispose ${sessionLabel(session)}`}
                onClick={() => onDispose(session.sessionId)}
              >
                <TrashIcon width={16} height={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

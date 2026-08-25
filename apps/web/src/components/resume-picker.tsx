import type { ResumableSessionWire } from "@pios/protocol";
import { useEffect, useState } from "react";
import { useClient } from "../client-provider.tsx";

/**
 * Sessions that exist on disk, including ones started in the pi TUI.
 *
 * The daemon and the TUI share one session directory, so this list is the
 * bridge between them: picking a row continues that transcript here.
 */
export function ResumePicker({ onResume, onCancel }: {
  onResume: (session: ResumableSessionWire) => void;
  onCancel: () => void;
}) {
  const client = useClient();
  const [sessions, setSessions] = useState<ResumableSessionWire[]>(() => client.getResumable());
  const [filter, setFilter] = useState("");
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    const off = client.onResumable(setSessions);
    setAsked(client.listResumable({ limit: 100 }));
    return off;
  }, [client]);

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? sessions.filter((s) =>
        `${s.cwd} ${s.name ?? ""} ${s.preview}`.toLowerCase().includes(needle),
      )
    : sessions;

  return (
    <section className="picker">
      <header className="row spread">
        <h2>Resume a session</h2>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </header>

      <input
        value={filter}
        placeholder="Filter by path or text"
        onChange={(e) => setFilter(e.target.value)}
      />

      {!asked ? <p className="banner error">Not connected: the list may be stale.</p> : null}

      {shown.length === 0 ? (
        <p className="muted">Nothing to resume.</p>
      ) : (
        <ul className="resumable">
          {shown.map((session) => (
            <li key={session.path}>
              <button type="button" className="session" onClick={() => onResume(session)}>
                <span className="name">{session.name ?? basename(session.cwd)}</span>
                <span className="muted">{session.cwd}</span>
                <span className="preview">{session.preview}</span>
                <span className="tags">
                  <span className="muted">{when(session.modifiedAt)}</span>
                  <span className="muted">{session.messageCount} msgs</span>
                  {/* Already open here: resuming attaches rather than forking. */}
                  {session.live ? <span className="status running">open</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function when(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days === 0) return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

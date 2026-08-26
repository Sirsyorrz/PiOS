import type { ResumableSessionWire } from "@pios/protocol";
import { useEffect, useState } from "react";
import { useClient } from "../client-provider.tsx";
import { basename, relativeTime } from "../format.ts";
import { ClockIcon, MessageIcon } from "./icons.tsx";
import { ListRowButton, ModalCard, PickerHeader, SearchField } from "./ui.tsx";

/**
 * Sessions that exist on disk, including ones started in the pi TUI.
 *
 * The daemon and the TUI share one session directory, so this list is the
 * bridge between them: picking a row continues that transcript here.
 */
export function ResumePicker({
  onResume,
  onCancel,
}: {
  onResume: (session: ResumableSessionWire) => void;
  onCancel: () => void;
}) {
  const client = useClient();
  const [sessions, setSessions] = useState<ResumableSessionWire[]>(() =>
    client.getResumable(),
  );
  const [filter, setFilter] = useState("");
  const [asked, setAsked] = useState(false);
  // Scanning every session file takes seconds on a large history, so the
  // empty state must not claim there is nothing before the answer arrives.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const off = client.onResumable((found) => {
      setSessions(found);
      setLoading(false);
    });
    const sent = client.listResumable({ limit: 100 });
    setAsked(sent);
    setLoading(sent);
    return off;
  }, [client]);

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? sessions.filter((s) =>
        `${s.cwd} ${s.name ?? ""} ${s.preview}`.toLowerCase().includes(needle),
      )
    : sessions;

  return (
    // Wider than the other steps: these rows carry a path and a preview
    // line, not a single directory name.
    <ModalCard className="picker resume">
      <PickerHeader title="Resume a session" onCancel={onCancel} />

      <SearchField
        value={filter}
        placeholder="Filter by path or text"
        onChange={setFilter}
      />

      {!asked ? (
        <p className="banner error">Not connected: the list may be stale.</p>
      ) : null}

      {loading ? (
        <p className="muted loading">Reading sessions…</p>
      ) : shown.length === 0 ? (
        <p className="muted">Nothing to resume.</p>
      ) : (
        <ul className="resumable scroll-y">
          {shown.map((session) => (
            <li key={session.path}>
              <ListRowButton
                className="session"
                onClick={() => onResume(session)}
              >
                {/* The opening message identifies a session far better than
                    its directory, which its whole project shares. Promoted to
                    the heading rather than repeated below it. */}
                <span className="name line">
                  {session.name ?? (session.preview || basename(session.cwd))}
                </span>
                <span className="muted line">{session.cwd}</span>
                {session.name ? (
                  <span className="preview line">{session.preview}</span>
                ) : null}
                <span className="tags">
                  <span className="muted tag">
                    <ClockIcon width={13} height={13} />
                    {relativeTime(session.modifiedAt)}
                  </span>
                  <span className="muted tag">
                    <MessageIcon width={13} height={13} />
                    {session.messageCount}
                  </span>
                  {/* Already open here: resuming attaches rather than forking. */}
                  {session.live ? (
                    <span className="status running">open</span>
                  ) : null}
                </span>
              </ListRowButton>
            </li>
          ))}
        </ul>
      )}
    </ModalCard>
  );
}

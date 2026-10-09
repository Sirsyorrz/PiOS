import { useEffect, useState } from "react";
import type { GitStash } from "@pios/protocol";
import { stashTitle, type Git } from "../../git.ts";
import { relativeTime } from "../../format.ts";
import type { GitRun } from "../git-view.tsx";
import { ArchiveIcon, TrashIcon, UploadIcon } from "../icons.tsx";
import { Empty, IconButton } from "./parts.tsx";

/**
 * Stashes, newest first, and a way to make one with a name.
 *
 * A row opens the stash's patch; pop and drop sit on the row because they are
 * what a stash is for, and apply, the rarer keep-it-too variant, is on the
 * patch screen.
 */
export function StashesTab({ git, run, onOpenStash }: {
  git: Git;
  run: GitRun;
  onOpenStash: (stash: GitStash) => void;
}) {
  const { status, stashes: read } = git;
  const [list, setList] = useState<GitStash[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  // Every action answers with a new status, and any of them can have moved
  // the stash list, so that is what the read is keyed on.
  useEffect(() => {
    let cancelled = false;
    read()
      .then((next) => !cancelled && setList(next))
      .catch((cause: unknown) => !cancelled && setError(String((cause as Error)?.message ?? cause)));
    return () => {
      cancelled = true;
    };
  }, [read, status]);

  if (!status) return null;
  const dirty = status.staged + status.unstaged + status.untracked > 0;

  async function stash() {
    if (await run({ type: "stash", message: message.trim() || undefined })) setMessage("");
  }

  return (
    <>
      <div className="field">
        <input
          value={message}
          placeholder="Stash message (optional)"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && dirty && !status.operation) void stash();
          }}
        />
        <IconButton
          label="stash changes"
          // Git refuses to stash mid-merge; offering it would only produce an
          // error the user cannot act on.
          disabled={git.busy || !dirty || Boolean(status.operation)}
          onClick={() => void stash()}
        >
          <ArchiveIcon />
        </IconButton>
      </div>

      {error ? <p className="banner error">{error}</p> : null}
      <div className="scroll-y">
        {list === null ? <Empty>Reading…</Empty> : null}
        {list?.length === 0 ? <Empty>No stashes.</Empty> : null}
        {list?.map((entry) => (
          <div className="git-row" key={`${entry.ref}:${entry.at}`}>
            <button type="button" className="list-row iconic" onClick={() => onOpenStash(entry)}>
              <span className="row-icon">
                <ArchiveIcon />
              </span>
              <span className="row-main">
                <span className="line">{stashTitle(entry)}</span>
                <span className="row-sub">
                  {entry.ref}
                  {entry.branch ? ` · ${entry.branch}` : ""} · {relativeTime(entry.at)}
                </span>
              </span>
            </button>
            <IconButton
              label={`drop ${entry.ref}`}
              danger
              disabled={git.busy}
              onClick={() => void run({ type: "stash_drop", ref: entry.ref })}
            >
              <TrashIcon />
            </IconButton>
            <IconButton
              label={`pop ${entry.ref}`}
              disabled={git.busy}
              onClick={() => void run({ type: "stash_pop", ref: entry.ref })}
            >
              <UploadIcon />
            </IconButton>
          </div>
        ))}
      </div>
    </>
  );
}

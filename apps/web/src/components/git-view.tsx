import { useEffect, useState, type ReactNode } from "react";
import {
  fileMark,
  needsConfirmation,
  patchLines,
  statusChip,
  useGitStatus,
  type Git,
  type GitAction,
  type GitFile,
} from "../git.ts";
import { ChevronLeftIcon, PlusIcon, TrashIcon } from "./icons.tsx";
import { ModalCard, PickerHeader } from "./ui.tsx";

interface Selection {
  path: string;
  staged: boolean;
}

/**
 * The chat header's git affordance.
 *
 * Absent entirely when the session cwd is not a repository, which is also the
 * honest signal that the feature does not apply here. Re-reads when a turn
 * settles, because that is when the agent has stopped writing files.
 */
export function GitControl({ running }: { running: boolean }) {
  const git = useGitStatus(running);
  const [open, setOpen] = useState(false);

  if (!git.status) return null;
  return (
    <>
      <button
        type="button"
        className="chip git-chip line"
        aria-label="git status"
        onClick={() => {
          git.refresh();
          setOpen(true);
        }}
      >
        {statusChip(git.status)}
      </button>
      {open ? <GitSheet git={git} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * Working-tree state for the session's directory.
 *
 * Local operations only: nothing here contacts a remote, so no action can hang
 * on the network or need credentials the daemon does not have.
 */
export function GitSheet({ git, onClose }: { git: Git; onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  // A discard is unreviewable on a phone, so it is named before it happens.
  const [confirming, setConfirming] = useState<GitAction | null>(null);

  const status = git.status;

  async function run(action: GitAction) {
    if (needsConfirmation(action)) {
      setConfirming(action);
      return;
    }
    await git.run(action);
    if (action.type === "commit") setMessage("");
    setSelected(null);
  }

  if (selected) {
    return (
      <DiffView
        git={git}
        selection={selected}
        onBack={() => setSelected(null)}
        onClose={onClose}
      />
    );
  }

  const staged = status?.files.filter((f) => f.index !== "." && !f.unmerged) ?? [];
  const changed = status?.files.filter((f) => f.index === "." || f.unmerged) ?? [];

  return (
    <ModalCard overlay className="git-sheet">
      <PickerHeader
        title={status ? (status.branch ?? `detached at ${status.head ?? "?"}`) : "Git"}
        onCancel={onClose}
      />

      {git.error ? <p className="banner error">{git.error}</p> : null}

      {!status ? (
        <p className="muted">{git.loading ? "Reading…" : "This directory is not a git repository."}</p>
      ) : (
        <>
          <p className="muted line">
            {summary(status.staged, status.unstaged, status.untracked, status.conflicted)}
            {status.upstream
              ? ` · ${status.upstream.name} +${status.upstream.ahead}/-${status.upstream.behind}`
              : ""}
          </p>

          {confirming ? (
            <div className="banner warn">
              <span className="line">
                Stash {"paths" in confirming ? confirming.paths.join(", ") : "changes"}? The change
                is recoverable with Pop stash.
              </span>
              <button type="button" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  const action = confirming;
                  setConfirming(null);
                  await git.run(action);
                }}
              >
                Discard
              </button>
            </div>
          ) : null}

          <div className="scroll-y">
            <Section
              title="Staged"
              files={staged}
              empty="Nothing staged."
              actionLabel="unstage"
              action={<span aria-hidden>−</span>}
              onSelect={(file) => setSelected({ path: file.path, staged: true })}
              onAction={(file) => run({ type: "unstage", paths: [file.path] })}
              busy={git.busy}
            />
            <Section
              title="Changes"
              files={changed}
              empty="Working tree clean."
              actionLabel="stage"
              action={<PlusIcon />}
              secondaryLabel="discard"
              secondary={<TrashIcon />}
              onSelect={(file) => setSelected({ path: file.path, staged: false })}
              onAction={(file) => run({ type: "stage", paths: [file.path] })}
              onSecondary={(file) => run({ type: "discard", paths: [file.path] })}
              busy={git.busy}
            />
            {status.truncated ? (
              <p className="muted">Too many changes to list; counts above are exact.</p>
            ) : null}
          </div>

          <div className="field">
            <input
              value={message}
              placeholder="Commit message"
              onChange={(event) => setMessage(event.target.value)}
            />
          </div>

          <div className="row spread">
            <button type="button" disabled={git.busy} onClick={() => run({ type: "stage_all" })}>
              Stage all
            </button>
            <button type="button" disabled={git.busy} onClick={() => run({ type: "stash_pop" })}>
              Pop stash
            </button>
            <button
              type="button"
              className="primary"
              disabled={git.busy || status.staged === 0 || message.trim().length === 0}
              onClick={() => run({ type: "commit", message })}
            >
              Commit
            </button>
          </div>
        </>
      )}
    </ModalCard>
  );
}

function summary(staged: number, unstaged: number, untracked: number, conflicted: number): string {
  if (staged + unstaged + untracked + conflicted === 0) return "Clean";
  const parts: string[] = [];
  if (conflicted) parts.push(`${conflicted} conflicted`);
  if (staged) parts.push(`${staged} staged`);
  if (unstaged) parts.push(`${unstaged} changed`);
  if (untracked) parts.push(`${untracked} untracked`);
  return parts.join(" · ");
}

function Section({
  title,
  files,
  empty,
  action,
  actionLabel,
  secondary,
  secondaryLabel,
  onSelect,
  onAction,
  onSecondary,
  busy,
}: {
  title: string;
  files: GitFile[];
  empty: string;
  action: ReactNode;
  actionLabel: string;
  secondary?: ReactNode;
  secondaryLabel?: string;
  onSelect: (file: GitFile) => void;
  onAction: (file: GitFile) => void;
  onSecondary?: (file: GitFile) => void;
  busy: boolean;
}) {
  return (
    <>
      <h3 className="git-section">{title}</h3>
      {files.length === 0 ? <p className="muted">{empty}</p> : null}
      {files.map((file) => {
        const { mark, tone } = fileMark(file);
        return (
          // The controls are siblings of the row, not children: a button
          // inside a button is not a thing the DOM has.
          <div className="git-row" key={`${title}:${file.path}`}>
            <button type="button" className="list-row iconic" onClick={() => onSelect(file)}>
              <span className={`row-icon git-mark ${tone}`}>{mark}</span>
              <span className="row-main line">
                {file.from ? `${file.from} → ${file.path}` : file.path}
              </span>
            </button>
            {secondary && onSecondary ? (
              <button
                type="button"
                className="ghost icon"
                aria-label={`${secondaryLabel} ${file.path}`}
                disabled={busy}
                onClick={() => onSecondary(file)}
              >
                {secondary}
              </button>
            ) : null}
            <button
              type="button"
              className="ghost icon"
              aria-label={`${actionLabel} ${file.path}`}
              disabled={busy}
              onClick={() => onAction(file)}
            >
              {action}
            </button>
          </div>
        );
      })}
    </>
  );
}

function DiffView({ git, selection, onBack, onClose }: {
  git: Git;
  selection: Selection;
  onBack: () => void;
  onClose: () => void;
}) {
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { diff } = git;

  useEffect(() => {
    let cancelled = false;
    diff(selection.path, selection.staged)
      .then((text) => !cancelled && setPatch(text))
      .catch((cause) => !cancelled && setError(String(cause?.message ?? cause)));
    return () => {
      cancelled = true;
    };
  }, [diff, selection.path, selection.staged]);

  return (
    <ModalCard overlay className="git-sheet">
      <header className="picker-head">
        <button type="button" className="ghost icon" aria-label="back" onClick={onBack}>
          <ChevronLeftIcon />
        </button>
        <h2 className="line">{selection.path}</h2>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </header>

      {error ? <p className="banner error">{error}</p> : null}
      {patch === null && !error ? <p className="muted">Reading…</p> : null}
      {patch !== null && patch.trim() === "" ? <p className="muted">No changes to show.</p> : null}

      {patch ? (
        <div className="scroll-y">
          <pre className="diff">
            {patchLines(patch).map((line, index) => (
              <div key={index} className={line.kind === "meta" ? "diff-meta" : `diff-${line.kind}`}>
                {line.text || " "}
              </div>
            ))}
          </pre>
        </div>
      ) : null}
    </ModalCard>
  );
}

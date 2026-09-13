import { useState } from "react";
import {
  confirmationFor,
  confirmLabel,
  recoveryFor,
  statusChip,
  useGitStatus,
  type Git,
  type GitAction,
  type GitLogEntry,
  type GitStatus,
} from "../git.ts";
import { isolate } from "../format.ts";
import { BranchesTab } from "./git/branches.tsx";
import { ChangesTab } from "./git/changes.tsx";
import { HistoryTab } from "./git/history.tsx";
import { ConfirmBar, DiffPane } from "./git/parts.tsx";
import {
  ChevronLeftIcon,
  DownloadIcon,
  RefreshIcon,
  UploadIcon,
} from "./icons.tsx";
import { ModalCard, PickerHeader } from "./ui.tsx";

type Tab = "changes" | "history" | "branches";

/** Runs an action, or opens its confirmation. False means nothing ran. */
export type GitRun = (action: GitAction) => Promise<boolean>;

/** A patch the sheet is showing instead of a tab. */
type Detail =
  | { kind: "file"; path: string; staged: boolean }
  | { kind: "commit"; commit: GitLogEntry };

/**
 * The chat header's git affordance.
 *
 * Absent entirely when the session cwd is not a repository, which is also the
 * honest signal that the feature does not apply here. Re-reads when a turn
 * settles, because that is when the agent has stopped writing files.
 */
export function GitControl({ running, cwd }: { running: boolean; cwd?: string | null }) {
  const git = useGitStatus(running, cwd);
  const [open, setOpen] = useState(false);
  const chip = git.status ? statusChip(git.status) : null;

  return (
    <>
      <button
        type="button"
        className={`chip git-chip line${git.stale ? " stale" : ""}`}
        aria-label="git"
        onClick={() => {
          git.refresh();
          setOpen(true);
        }}
      >
        {/* Always present, whatever the answer was: a chip that comes and goes
            reads as a bug, and every state it can be in leads somewhere. */}
        <span className="git-chip-head line">{chip?.head ?? "git"}</span>
        {chip?.counts ? <span className="git-chip-counts">{chip.counts}</span> : null}
      </button>
      {open ? <GitSheet git={git} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/**
 * The whole git surface for the session's directory: working tree, history,
 * branches, and the remote.
 *
 * One card with tabs rather than a stack of sheets, so switching between "what
 * changed" and "which branch" never loses the commit message being typed.
 */
export function GitSheet({ git, onClose }: { git: Git; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("changes");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [confirming, setConfirming] = useState<GitAction | null>(null);

  const status = git.status;

  /**
   * Everything the tabs trigger goes through here, so a confirmation cannot be
   * skipped. False means it did not run: either it failed or it is waiting to
   * be confirmed, and in both cases the caller keeps what the user typed.
   */
  async function run(action: GitAction): Promise<boolean> {
    if (confirmationFor(action)) {
      setConfirming(action);
      return false;
    }
    const ok = await git.run(action);
    if (ok) setDetail(null);
    return ok;
  }

  if (detail) {
    return (
      <ModalCard overlay className="git-sheet">
        <header className="picker-head">
          <button type="button" className="ghost icon" aria-label="back" onClick={() => setDetail(null)}>
            <ChevronLeftIcon />
          </button>
          <h2 className="line tail">
            {isolate(detail.kind === "file" ? detail.path : detail.commit.subject)}
          </h2>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </header>
        {detail.kind === "commit" ? (
          <p className="muted git-summary line">
            <code className="git-sha">{detail.commit.sha}</code> {detail.commit.author}
          </p>
        ) : (
          <p className="muted git-summary line">{detail.staged ? "Staged changes" : "Working tree changes"}</p>
        )}
        <div className="scroll-y">
          <DiffPane
            subject={detail.kind === "file" ? `${detail.staged}:${detail.path}` : detail.commit.sha}
            load={() =>
              detail.kind === "file"
                ? git.diff({ path: detail.path, staged: detail.staged })
                : git.diff({ commit: detail.commit.sha })
            }
          />
        </div>
      </ModalCard>
    );
  }

  return (
    <ModalCard overlay className="git-sheet">
      <PickerHeader
        title={status ? (status.branch ?? `detached at ${status.head ?? "?"}`) : "Git"}
        onCancel={onClose}
        action={
          <button
            type="button"
            className="ghost icon"
            aria-label="refresh"
            disabled={git.busy}
            onClick={git.refresh}
          >
            <RefreshIcon />
          </button>
        }
      />

      {!status ? (
        <>
          {git.error ? <GitFailure git={git} error={git.error} run={run} /> : null}
          <p className="muted">
            {git.loading ? "Reading…" : "This directory is not a git repository."}
          </p>
          {!git.loading && git.missing ? (
            <button
              type="button"
              className="primary"
              disabled={git.busy}
              onClick={() => void run({ type: "init" })}
            >
              Initialize repository
            </button>
          ) : null}
        </>
      ) : (
        <>
          <SyncBar status={status} git={git} run={run} />

          {status.operation ? (
            <div className="banner warn git-confirm">
              <span className="git-confirm-text">
                A {status.operation} is in progress.
                {status.conflicted > 0
                  ? " Resolve the conflicts, stage them, then continue."
                  : " Continue it or throw it away."}
              </span>
              <span className="row">
                <button type="button" disabled={git.busy} onClick={() => void run({ type: "abort" })}>
                  Abort
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={git.busy || status.conflicted > 0}
                  onClick={() => void run({ type: "continue" })}
                >
                  Continue
                </button>
              </span>
            </div>
          ) : null}
          {git.error ? <GitFailure git={git} error={git.error} run={run} /> : null}
          {git.notice ? (
            <div className="banner git-confirm">
              <span className="git-output">{git.notice}</span>
              <span className="row">
                <button type="button" onClick={git.clearMessages}>
                  Dismiss
                </button>
              </span>
            </div>
          ) : null}

          {confirming ? (
            <ConfirmBar
              text={confirmationFor(confirming) ?? ""}
              confirmLabel={confirmLabel(confirming)}
              onCancel={() => setConfirming(null)}
              alt={
                confirming.type === "delete_branch" && !confirming.force
                  ? {
                      label: "Force delete",
                      onClick: () => {
                        const action = { ...confirming, force: true };
                        setConfirming(null);
                        void git.run(action);
                      },
                    }
                  : undefined
              }
              onConfirm={() => {
                const action = confirming;
                setConfirming(null);
                void git.run(action);
              }}
            />
          ) : null}

          <nav className="git-tabs" role="tablist">
            {(["changes", "history", "branches"] as Tab[]).map((name) => (
              <button
                type="button"
                key={name}
                role="tab"
                aria-selected={tab === name}
                className={tab === name ? "git-tab active" : "git-tab"}
                onClick={() => setTab(name)}
              >
                {label(name, status)}
              </button>
            ))}
          </nav>

          {tab === "changes" ? (
            <ChangesTab
              git={git}
              run={run}
              onOpenDiff={(path, staged) => setDetail({ kind: "file", path, staged })}
            />
          ) : null}
          {tab === "history" ? (
            <HistoryTab git={git} onOpenCommit={(commit) => setDetail({ kind: "commit", commit })} />
          ) : null}
          {tab === "branches" ? <BranchesTab git={git} run={run} /> : null}
        </>
      )}
    </ModalCard>
  );
}

/** Git's refusal, with the one command that would clear it. */
function GitFailure({ git, error, run }: { git: Git; error: string; run: GitRun }) {
  const recovery = recoveryFor(error);
  return (
    <div className="banner error git-confirm">
      <span className="git-output">{error}</span>
      <span className="row wrap">
        <button type="button" onClick={git.clearMessages}>
          Dismiss
        </button>
        {recovery ? (
          <button type="button" disabled={git.busy} onClick={() => void run(recovery.action)}>
            {recovery.label}
          </button>
        ) : null}
      </span>
    </div>
  );
}

function label(tab: Tab, status: GitStatus): string {
  if (tab !== "changes") return tab[0]!.toUpperCase() + tab.slice(1);
  const count = status.staged + status.unstaged + status.untracked + status.conflicted;
  return count ? `Changes ${count}` : "Changes";
}

/**
 * The remote row: fetch, pull, push, and what each of them would do.
 *
 * Counts are read from local refs, so they are only as fresh as the last
 * fetch; the fetch button is next to them for that reason. The extra
 * variants (prune, rebase, force) are one tap away rather than on the row,
 * because the plain form is right nearly always.
 */
function SyncBar({ status, git, run }: { status: GitStatus; git: Git; run: GitRun }) {
  const [more, setMore] = useState(false);

  if (status.remotes.length === 0) {
    return <p className="muted git-summary line">No remote configured.</p>;
  }

  const ahead = status.upstream?.ahead ?? 0;
  const behind = status.upstream?.behind ?? 0;
  const publish = !status.upstream;

  return (
    <div className="git-sync">
      <div className="row">
        <button
          type="button"
          className="git-sync-btn"
          disabled={git.busy}
          onClick={() => void run({ type: "fetch" })}
        >
          <RefreshIcon />
          {git.pending === "fetch" ? "Fetching…" : "Fetch"}
        </button>
        <button
          type="button"
          className="git-sync-btn"
          disabled={git.busy || publish || behind === 0}
          onClick={() => void run({ type: "pull" })}
        >
          <DownloadIcon />
          {git.pending === "pull" ? "Pulling…" : behind ? `Pull ${behind}` : "Pull"}
        </button>
        <button
          type="button"
          className="git-sync-btn"
          disabled={git.busy || (!publish && ahead === 0)}
          onClick={() => void run({ type: "push", setUpstream: publish })}
        >
          <UploadIcon />
          {git.pending === "push" ? "Pushing…" : publish ? "Publish" : `Push ${ahead}`}
        </button>
        <button
          type="button"
          className="ghost git-more-toggle"
          aria-label="more remote actions"
          aria-expanded={more}
          onClick={() => setMore((open) => !open)}
        >
          ⋯
        </button>
      </div>
      {more ? (
        // One line, so the sheet's height does not depend on a disclosure:
        // the verbs above name the operation, these only qualify it.
        <div className="row git-sync-more">
          <button type="button" disabled={git.busy} onClick={() => void run({ type: "fetch", prune: true })}>
            Prune
          </button>
          <button
            type="button"
            disabled={git.busy || publish}
            onClick={() => void run({ type: "pull", rebase: true })}
          >
            Rebase
          </button>
          <button
            type="button"
            className="danger"
            disabled={git.busy || publish}
            onClick={() => void run({ type: "push", force: true })}
          >
            Force push
          </button>
        </div>
      ) : null}
      <p className="muted git-upstream line">
        {status.upstream
          ? `${status.upstream.name} · ↑${ahead} ↓${behind}`
          : `No upstream · publishing goes to ${status.defaultRemote ?? "the remote"}`}
      </p>
    </div>
  );
}

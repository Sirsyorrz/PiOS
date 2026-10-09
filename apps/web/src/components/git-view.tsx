import { useEffect, useState, type ReactNode } from "react";
import type { GitAction, GitLogEntry, GitStash, GitStatus } from "@pios/protocol";
import {
  confirmationFor,
  confirmLabel,
  recoveryFor,
  stashTitle,
  statusChip,
  type DiffSubject,
  type Git,
} from "../git.ts";
import { isolate } from "../format.ts";
import { BranchesTab } from "./git/branches.tsx";
import { ChangesTab, type CommitDraft } from "./git/changes.tsx";
import { HistoryTab } from "./git/history.tsx";
import { StashesTab } from "./git/stashes.tsx";
import { ConfirmBar, DiffPane } from "./git/parts.tsx";
import {
  BranchIcon,
  ChevronLeftIcon,
  DownloadIcon,
  MinusIcon,
  PlusIcon,
  RefreshIcon,
  UploadIcon,
} from "./icons.tsx";

type Tab = "changes" | "history" | "branches" | "stashes";

const TABS: Tab[] = ["changes", "history", "branches", "stashes"];

/** Runs an action, or opens its confirmation. False means nothing ran. */
export type GitRun = (action: GitAction) => Promise<boolean>;

/** A patch the view is showing instead of a tab. */
type Detail =
  | { kind: "file"; path: string; staged: boolean }
  | { kind: "commit"; commit: GitLogEntry }
  | { kind: "stash"; stash: GitStash };

/**
 * Unsent commit messages by repository, so leaving for the chat and coming
 * back does not lose one. Memory only: a message is minutes old, not a draft.
 */
const commitDrafts = new Map<string, CommitDraft>();

/**
 * The chat header's git affordance: branch and counts, opening the git view.
 *
 * Always present, whatever the answer was: a chip that comes and goes reads as
 * a bug, and every state it can be in leads somewhere.
 */
export function GitChip({ git, onOpen }: { git: Git; onOpen: () => void }) {
  const chip = git.status ? statusChip(git.status) : null;
  return (
    <button
      type="button"
      className={`chip git-chip${git.stale ? " stale" : ""}`}
      aria-label={git.status?.branch ? `git, on ${git.status.branch}` : "git"}
      onClick={() => {
        git.refresh();
        onOpen();
      }}
    >
      <BranchIcon />
      {chip?.operation ? <span className="git-chip-op">{chip.operation}</span> : null}
      {chip?.counts ? <span className="git-chip-counts">{chip.counts}</span> : null}
    </button>
  );
}

/**
 * The whole git surface for the session's directory: working tree, history,
 * branches, stashes and the remote.
 *
 * Full screen, like the file editor: a diff needs the width, and a commit
 * message needs the keyboard, and a card over the transcript has room for
 * neither.
 */
export function GitView({ git, onClose }: { git: Git; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("changes");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [confirming, setConfirming] = useState<GitAction | null>(null);

  const status = git.status;
  const draftKey = status?.root ?? "";
  const [draft, setDraftState] = useState<CommitDraft>(
    () => commitDrafts.get(draftKey) ?? { message: "", amend: false },
  );
  useEffect(() => {
    setDraftState(commitDrafts.get(draftKey) ?? { message: "", amend: false });
  }, [draftKey]);
  function setDraft(next: CommitDraft) {
    setDraftState(next);
    if (next.message || next.amend) commitDrafts.set(draftKey, next);
    else commitDrafts.delete(draftKey);
  }

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

  function confirm(action: GitAction) {
    setConfirming(null);
    void git.run(action).then((ok) => ok && setDetail(null));
  }

  const banners = (
    <>
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
              ? { label: "Force delete", onClick: () => confirm({ ...confirming, force: true }) }
              : undefined
          }
          onConfirm={() => confirm(confirming)}
        />
      ) : null}
    </>
  );

  if (detail) {
    return (
      <DetailScreen
        detail={detail}
        git={git}
        run={run}
        banners={banners}
        onBack={() => setDetail(null)}
      />
    );
  }

  return (
    <section className="subview git-view">
      <header className="subview-head">
        <button type="button" className="ghost icon" aria-label="back to chat" onClick={onClose}>
          <ChevronLeftIcon />
        </button>
        <h2 className="line">
          {status ? isolate(status.branch ?? `detached at ${status.head ?? "?"}`) : "Git"}
        </h2>
        <button
          type="button"
          className="ghost icon"
          aria-label="refresh"
          disabled={git.busy}
          onClick={git.refresh}
        >
          <RefreshIcon />
        </button>
      </header>

      {!status ? (
        <>
          {banners}
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
          {status.operation ? <OperationBanner status={status} git={git} run={run} /> : null}
          {banners}

          <nav className="git-tabs" role="tablist">
            {TABS.map((name) => (
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
              draft={draft}
              onDraft={setDraft}
              onOpenDiff={(path, staged) => setDetail({ kind: "file", path, staged })}
            />
          ) : null}
          {tab === "history" ? (
            <HistoryTab git={git} onOpenCommit={(commit) => setDetail({ kind: "commit", commit })} />
          ) : null}
          {tab === "branches" ? <BranchesTab git={git} run={run} /> : null}
          {tab === "stashes" ? (
            <StashesTab git={git} run={run} onOpenStash={(stash) => setDetail({ kind: "stash", stash })} />
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * One patch, full width. A file's patch carries the verb that moves it
 * between the tree and the index, so reviewing and staging is one place.
 */
function DetailScreen({ detail, git, run, banners, onBack }: {
  detail: Detail;
  git: Git;
  run: GitRun;
  banners: ReactNode;
  onBack: () => void;
}) {
  const { title, summary, subject, key } = describe(detail);
  return (
    <section className="subview git-view">
      <header className="subview-head">
        <button type="button" className="ghost icon" aria-label="back" onClick={onBack}>
          <ChevronLeftIcon />
        </button>
        <h2 className="line tail">{isolate(title)}</h2>
        {detail.kind === "file" ? (
          <button
            type="button"
            className="ghost icon"
            aria-label={detail.staged ? `unstage ${detail.path}` : `stage ${detail.path}`}
            disabled={git.busy}
            onClick={() =>
              void run(
                detail.staged
                  ? { type: "unstage", paths: [detail.path] }
                  : { type: "stage", paths: [detail.path] },
              )
            }
          >
            {detail.staged ? <MinusIcon /> : <PlusIcon />}
          </button>
        ) : null}
      </header>
      {banners}
      <p className="muted git-summary line">{summary}</p>
      {detail.kind === "stash" ? (
        <div className="row git-stash-actions">
          <button
            type="button"
            className="danger"
            disabled={git.busy}
            onClick={() => void run({ type: "stash_drop", ref: detail.stash.ref })}
          >
            Drop
          </button>
          <button
            type="button"
            disabled={git.busy}
            onClick={() => void run({ type: "stash_apply", ref: detail.stash.ref })}
          >
            Apply
          </button>
          <button
            type="button"
            className="primary"
            disabled={git.busy}
            onClick={() => void run({ type: "stash_pop", ref: detail.stash.ref })}
          >
            Pop
          </button>
        </div>
      ) : null}
      <div className="scroll-y">
        <DiffPane subject={key} load={() => git.diff(subject)} />
      </div>
    </section>
  );
}

function describe(detail: Detail): {
  title: string;
  summary: ReactNode;
  subject: DiffSubject;
  key: string;
} {
  switch (detail.kind) {
    case "file":
      return {
        title: detail.path,
        summary: detail.staged ? "Staged changes" : "Working tree changes",
        subject: { path: detail.path, staged: detail.staged },
        key: `${detail.staged}:${detail.path}`,
      };
    case "commit":
      return {
        title: detail.commit.subject,
        summary: (
          <>
            <code className="git-sha">{detail.commit.sha}</code> {detail.commit.author}
          </>
        ),
        subject: { commit: detail.commit.sha },
        key: detail.commit.sha,
      };
    case "stash":
      return {
        title: stashTitle(detail.stash),
        summary: detail.stash.branch ? `${detail.stash.ref} · on ${detail.stash.branch}` : detail.stash.ref,
        subject: { stash: detail.stash.ref },
        // Refs shift as stashes are dropped; the message and time do not.
        key: `${detail.stash.ref}:${detail.stash.at}`,
      };
  }
}

function OperationBanner({ status, git, run }: { status: GitStatus; git: Git; run: GitRun }) {
  return (
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
  const name = tab[0]!.toUpperCase() + tab.slice(1);
  const count =
    tab === "changes"
      ? status.staged + status.unstaged + status.untracked + status.conflicted
      : tab === "stashes"
        ? status.stashes
        : 0;
  return count ? `${name} ${count}` : name;
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
        // The verbs above name the operation; these only qualify it.
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

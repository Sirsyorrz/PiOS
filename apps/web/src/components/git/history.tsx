import { useEffect, useState } from "react";
import { relativeTime } from "../../format.ts";
import type { Git, GitLogEntry } from "../../git.ts";
import { Empty } from "./parts.tsx";

const PAGE = 40;

/** Commits, newest first, each one tappable for its patch. */
export function HistoryTab({ git, onOpenCommit }: {
  git: Git;
  onOpenCommit: (commit: GitLogEntry) => void;
}) {
  const [commits, setCommits] = useState<GitLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [end, setEnd] = useState(false);

  const { log } = git;
  // Re-reads whenever the head moves, so a fresh commit is at the top without
  // the user having to know to reopen the tab.
  const head = git.status?.head ?? "";

  useEffect(() => {
    let cancelled = false;
    log({ limit: PAGE })
      .then((page) => {
        if (cancelled) return;
        setCommits(page);
        setEnd(page.length < PAGE);
      })
      .catch((cause: unknown) => !cancelled && setError(String((cause as Error)?.message ?? cause)));
    return () => {
      cancelled = true;
    };
  }, [log, head]);

  async function more() {
    if (!commits) return;
    setLoadingMore(true);
    try {
      const page = await log({ skip: commits.length, limit: PAGE });
      setCommits([...commits, ...page]);
      setEnd(page.length < PAGE);
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
    } finally {
      setLoadingMore(false);
    }
  }

  if (error) return <p className="banner error">{error}</p>;
  if (!commits) return <Empty>Reading…</Empty>;
  if (commits.length === 0) return <Empty>No commits yet.</Empty>;

  return (
    <div className="scroll-y">
      {commits.map((commit) => (
        <button
          type="button"
          className="list-row git-commit-row-item"
          key={commit.sha}
          onClick={() => onOpenCommit(commit)}
        >
          <span className="line">{commit.subject}</span>
          <span className="row-sub">
            <code className="git-sha">{commit.sha}</code> {commit.author} ·{" "}
            {relativeTime(commit.at)}
          </span>
          {commit.refs.length > 0 ? (
            <span className="git-refs">
              {commit.refs.map((ref) => (
                <span className="git-ref" key={ref}>
                  {ref}
                </span>
              ))}
            </span>
          ) : null}
        </button>
      ))}
      {end ? null : (
        <button type="button" className="git-more" disabled={loadingMore} onClick={() => void more()}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

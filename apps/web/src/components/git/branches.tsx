import { useEffect, useMemo, useState } from "react";
import { relativeTime } from "../../format.ts";
import type { Git, GitAction, GitBranch, GitBranches } from "../../git.ts";
import type { GitRun } from "../git-view.tsx";
import { PlusIcon } from "../icons.tsx";
import { Empty, GitSection } from "./parts.tsx";

/**
 * Branches, local first.
 *
 * A tapped branch opens its actions rather than switching immediately: on a
 * phone a checkout is one mis-tap away from throwing the user onto another
 * branch mid-turn, and the useful verbs (merge, delete) have nowhere else to
 * live.
 */
export function BranchesTab({ git, run }: { git: Git; run: GitRun }) {
  const [data, setData] = useState<GitBranches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState("");
  const [selected, setSelected] = useState<GitBranch | null>(null);

  const { branches } = git;
  // The status object changes after every action, which is exactly when the
  // branch list can have moved.
  const stamp = `${git.status?.branch}:${git.status?.head}`;

  useEffect(() => {
    let cancelled = false;
    branches()
      .then((result) => !cancelled && setData(result))
      .catch((cause: unknown) => !cancelled && setError(String((cause as Error)?.message ?? cause)));
    return () => {
      cancelled = true;
    };
  }, [branches, stamp]);

  const needle = filter.trim().toLowerCase();
  const match = useMemo(
    () => (list: GitBranch[]) =>
      needle ? list.filter((b) => b.name.toLowerCase().includes(needle)) : list,
    [needle],
  );

  if (error) return <p className="banner error">{error}</p>;
  if (!data) return <Empty>Reading…</Empty>;

  const local = match(data.local);
  const remote = match(data.remote);

  async function create() {
    const name = creating.trim();
    if (!name) return;
    // A rejected name stays in the field, where it can be corrected.
    if (await run({ type: "checkout", branch: name, create: true })) setCreating("");
  }

  /** A remote branch is checked out as a local one that tracks it. */
  function checkoutRemote(branch: GitBranch) {
    const short = branch.name.split("/").slice(1).join("/");
    const existing = data?.local.some((b) => b.name === short);
    void run(
      existing
        ? { type: "checkout", branch: short }
        : { type: "checkout", branch: short, create: true, from: branch.name },
    );
    setSelected(null);
  }

  return (
    <>
      <div className="field">
        <input
          value={creating}
          placeholder="New branch from HEAD"
          onChange={(event) => setCreating(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }}
        />
        <button
          type="button"
          className="ghost icon"
          aria-label="create branch"
          disabled={git.busy || creating.trim().length === 0}
          onClick={() => void create()}
        >
          <PlusIcon />
        </button>
      </div>

      {data.local.length + data.remote.length > 8 ? (
        <div className="field">
          <input
            value={filter}
            placeholder="Filter branches"
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      ) : null}

      {selected ? (
        <BranchActions
          branch={selected}
          current={data.current}
          busy={git.busy}
          onClose={() => setSelected(null)}
          onRun={(action) => {
            void run(action);
            setSelected(null);
          }}
          onCheckoutRemote={() => checkoutRemote(selected)}
        />
      ) : null}

      <div className="scroll-y">
        <GitSection title={`Local (${local.length})`}>
          {local.length === 0 ? <Empty>No matching branches.</Empty> : null}
          {local.map((branch) => (
            <BranchRow key={branch.name} branch={branch} onSelect={() => setSelected(branch)} />
          ))}
        </GitSection>

        {data.remote.length > 0 ? (
          <GitSection title={`Remote (${remote.length})`}>
            {remote.length === 0 ? <Empty>No matching branches.</Empty> : null}
            {remote.map((branch) => (
              <BranchRow key={branch.name} branch={branch} onSelect={() => setSelected(branch)} />
            ))}
          </GitSection>
        ) : null}
      </div>
    </>
  );
}

function BranchRow({ branch, onSelect }: { branch: GitBranch; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`list-row git-branch${branch.current ? " current" : ""}`}
      onClick={onSelect}
    >
      <span className="line">
        {branch.current ? <span className="git-current-dot" aria-label="current branch" /> : null}
        {branch.name}
        {branch.behind ? <span className="git-count">↓{branch.behind}</span> : null}
        {branch.ahead ? <span className="git-count">↑{branch.ahead}</span> : null}
        {branch.gone ? <span className="git-count warn">gone</span> : null}
      </span>
      <span className="row-sub line">
        <code className="git-sha">{branch.sha}</code> {branch.subject || "no subject"} ·{" "}
        {relativeTime(branch.at)}
      </span>
    </button>
  );
}

function BranchActions({ branch, current, busy, onClose, onRun, onCheckoutRemote }: {
  branch: GitBranch;
  current: string | null;
  busy: boolean;
  onClose: () => void;
  onRun: (action: GitAction) => void;
  onCheckoutRemote: () => void;
}) {
  const isCurrent = branch.name === current;
  return (
    <div className="banner git-actions">
      <span className="line git-actions-name">{branch.name}</span>
      <span className="row wrap">
        {isCurrent ? null : (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              branch.remote ? onCheckoutRemote() : onRun({ type: "checkout", branch: branch.name })
            }
          >
            Checkout
          </button>
        )}
        {isCurrent ? null : (
          <button type="button" disabled={busy} onClick={() => onRun({ type: "merge", branch: branch.name })}>
            Merge into {current ?? "HEAD"}
          </button>
        )}
        {isCurrent || branch.remote ? null : (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => onRun({ type: "delete_branch", branch: branch.name })}
          >
            Delete
          </button>
        )}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </span>
    </div>
  );
}

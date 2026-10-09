import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitAction,
  GitBranches,
  GitFile,
  GitLogEntry,
  GitStash,
  GitStatus,
} from "@pios/protocol";
import type { FileAccess } from "./files.ts";
import { messageOf } from "./format.ts";

/** Actions that can take a while and whose progress text is worth showing. */
function isRemote(action: GitAction): boolean {
  return action.type === "fetch" || action.type === "pull" || action.type === "push";
}

/**
 * A sentence naming what an action will do, for anything not plainly undoable.
 *
 * Null means it just runs. Everything destructive is named in full because the
 * caller cannot see the tree it is about to change.
 */
export function confirmationFor(action: GitAction): string | null {
  switch (action.type) {
    case "discard":
      return `Discard changes to ${action.paths.join(", ")}? They are stashed, so \`git stash pop\` brings them back.`;
    case "stash_drop":
      return `Drop ${action.ref}? A dropped stash is not recoverable from the UI.`;
    case "abort":
      return "Abort the operation in progress? Everything it had applied is undone.";
    case "delete_branch":
      return action.force
        ? `Force-delete ${action.branch}? Unmerged commits on it are lost.`
        : `Delete ${action.branch}?`;
    case "commit":
      return action.amend ? "Amend the last commit? It gets a new hash." : null;
    case "push":
      return action.force
        ? "Force-push with lease? It overwrites the remote branch unless someone else pushed first."
        : null;
    default:
      return null;
  }
}

/**
 * The one action that unsticks a failure, when there is one.
 *
 * A refused fast-forward is the common remote failure and its fix is a rebase
 * pull; offering it beside the error saves reading git's hint block, which
 * suggests commands there is no terminal here to run.
 */
export function recoveryFor(error: string): { label: string; action: GitAction } | null {
  if (/diverg|fast-forward|fast forward/i.test(error)) {
    return { label: "Pull with rebase", action: { type: "pull", rebase: true } };
  }
  return null;
}

/** The verb on the confirm button, so it names the deed and not the dialog. */
export function confirmLabel(action: GitAction): string {
  switch (action.type) {
    case "discard":
      return "Discard";
    case "stash_drop":
      return "Drop";
    case "abort":
      return "Abort";
    case "delete_branch":
      return "Delete";
    case "commit":
      return "Amend";
    case "push":
      return "Force push";
    default:
      return "Confirm";
  }
}

async function call(
  access: FileAccess,
  path: string,
  init?: RequestInit & { search?: Record<string, string | undefined> },
): Promise<unknown> {
  if (!access.baseUrl) throw new Error("not connected");
  const url = new URL(path, access.baseUrl);
  // A draft's id names no session the daemon knows, so a directory addresses
  // the repository instead. Sending both would resolve to the session.
  if (init?.search?.cwd === undefined) url.searchParams.set("session", access.sessionId);
  for (const [key, value] of Object.entries(init?.search ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${access.deviceToken}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    // The daemon reports a failed git invocation verbatim; it is the only
    // useful thing to show, and inventing a friendlier message would hide it.
    throw new Error(
      typeof body?.message === "string" ? body.message : `request failed (${response.status})`,
    );
  }
  return body;
}

/** What a patch is read from: a file in the tree or index, a commit, or a stash. */
export type DiffSubject = { path?: string; staged?: boolean; commit?: string; stash?: string };

export interface Git {
  /** Last status read, kept across a failed refresh so the chip never blanks. */
  status: GitStatus | null;
  /** The daemon answered, and the directory is not a repository. */
  missing: boolean;
  /** Showing an older read because the last one failed. */
  stale: boolean;
  loading: boolean;
  error: string | null;
  /** Git's own output from the last remote operation, cleared on the next one. */
  notice: string | null;
  busy: boolean;
  /** Names the running action so a button can show where the wait is. */
  pending: GitAction["type"] | null;
  refresh: () => void;
  clearMessages: () => void;
  run: (action: GitAction) => Promise<boolean>;
  diff: (options: DiffSubject) => Promise<string>;
  log: (options?: { skip?: number; limit?: number }) => Promise<GitLogEntry[]>;
  branches: () => Promise<GitBranches | null>;
  stashes: () => Promise<GitStash[]>;
}

/**
 * Git state for the active session's working directory.
 *
 * Polled on demand rather than pushed: this is ambient state of a directory,
 * not conversation state, so it must not ride the entry stream whose ids are
 * the resync cursor. `settled` re-reads once a turn finishes, which is when
 * the agent has stopped writing files, and returning to the app re-reads
 * whatever happened in a terminal while it was away.
 *
 * A draft's access carries its directory, because the daemon has no session
 * to look it up by yet.
 */
export function useGitStatus(access: FileAccess | null, settled: unknown): Git {
  const cwd = access?.cwd;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<GitAction["type"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const sessionId = access?.sessionId;
  const baseUrl = access?.baseUrl;
  // Reads started before a refresh must not overwrite the newer answer.
  const generation = useRef(0);

  useEffect(() => {
    if (!access?.baseUrl) return;
    const mine = ++generation.current;
    setLoading(true);
    call(access, "/git/status", { search: { cwd, fresh: tick > 0 ? "1" : undefined } })
      .then((body) => {
        if (generation.current !== mine) return;
        const next = ((body as { status?: GitStatus | null })?.status ?? null) as GitStatus | null;
        // A null status is the daemon saying "no repository here", which is a
        // different fact from "the read failed" and leads somewhere else.
        setStatus(next);
        setMissing(next === null);
        setStale(false);
        setError(null);
      })
      .catch((cause) => {
        if (generation.current !== mine) return;
        // Keep the last known counts: a dropped request says nothing about
        // the tree, and a chip that vanishes reads as "no repository".
        setStale(true);
        setError(messageOf(cause));
      })
      .finally(() => {
        if (generation.current === mine) setLoading(false);
      });
    // `access` is memoised by the provider; the identity fields are listed so
    // a re-render with the same session does not refetch.
  }, [baseUrl, sessionId, cwd, settled, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // Work happens in a terminal while the app is backgrounded; coming back is
  // the moment someone looks at the chip, and the cheapest time to be right.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);
  const clearMessages = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  const run = useCallback(
    async (action: GitAction) => {
      if (!access) return false;
      setPending(action.type);
      setError(null);
      setNotice(null);
      try {
        const body = (await call(access, "/git/action", {
          method: "POST",
          body: JSON.stringify(action),
          search: { cwd },
        })) as { status?: GitStatus | null; output?: string };
        // The action response carries the recomputed status, so the view
        // redraws without a second round trip.
        setStatus(body?.status ?? null);
        setMissing((body?.status ?? null) === null);
        setStale(false);
        if (isRemote(action) && body?.output) setNotice(body.output);
        return true;
      } catch (cause) {
        setError(messageOf(cause));
        return false;
      } finally {
        setPending(null);
      }
    },
    [access, cwd],
  );

  const diff = useCallback(
    async (options: DiffSubject) => {
      if (!access) return "";
      const body = await call(access, "/git/diff", {
        search: {
          cwd,
          path: options.path,
          staged: options.staged ? "1" : undefined,
          commit: options.commit,
          stash: options.stash,
        },
      });
      return typeof (body as { diff?: unknown })?.diff === "string"
        ? (body as { diff: string }).diff
        : "";
    },
    [access, cwd],
  );

  const log = useCallback(
    async (options: { skip?: number; limit?: number } = {}) => {
      if (!access) return [];
      const body = await call(access, "/git/log", {
        search: {
          cwd,
          skip: options.skip ? String(options.skip) : undefined,
          limit: String(options.limit ?? 40),
        },
      });
      return ((body as { commits?: GitLogEntry[] })?.commits ?? []) as GitLogEntry[];
    },
    [access, cwd],
  );

  const branches = useCallback(async () => {
    if (!access) return null;
    const body = await call(access, "/git/branches", { search: { cwd } });
    return ((body as { branches?: GitBranches | null })?.branches ?? null) as GitBranches | null;
  }, [access, cwd]);

  const stashes = useCallback(async () => {
    if (!access) return [];
    const body = await call(access, "/git/stashes", { search: { cwd } });
    return ((body as { stashes?: GitStash[] })?.stashes ?? []) as GitStash[];
  }, [access, cwd]);

  return useMemo(
    () => ({
      status,
      missing,
      stale,
      loading,
      error,
      notice,
      busy: pending !== null,
      pending,
      refresh,
      clearMessages,
      run,
      diff,
      log,
      branches,
      stashes,
    }),
    [status, missing, stale, loading, error, notice, pending, refresh, clearMessages, run, diff, log, branches, stashes],
  );
}

/**
 * The chat header's summary, sized for a row it shares with the title.
 *
 * The branch is left to the git view's own title; the header only says whether
 * anything is pending. Conflicts stay apart from other changes because they
 * block the next commit. An operation in progress is named: being mid-merge
 * matters more than any count.
 */
export function statusChip(status: GitStatus): { operation: string | null; counts: string } {
  const counts: string[] = [];
  if (status.upstream?.behind) counts.push(`↓${status.upstream.behind}`);
  if (status.upstream?.ahead) counts.push(`↑${status.upstream.ahead}`);
  if (status.conflicted > 0) counts.push(`!${status.conflicted}`);
  const changed = status.staged + status.unstaged + status.untracked;
  if (changed > 0) counts.push(`±${changed}`);
  return { operation: status.operation?.toUpperCase() ?? null, counts: counts.join(" ") };
}

/** A stash's own words, without the "On <branch>:" git puts in front of them. */
export function stashTitle(stash: GitStash): string {
  return stash.message.replace(/^(?:WIP on|On) [^:]+: /, "") || stash.message;
}

/** Single-letter label for a file row, worst state first. */
export function fileMark(file: GitFile): { mark: string; tone: "add" | "remove" | "warn" | "muted" } {
  if (file.unmerged) return { mark: "!", tone: "warn" };
  if (file.untracked) return { mark: "?", tone: "muted" };
  const code = file.index !== "." ? file.index : file.work;
  if (code === "D") return { mark: "D", tone: "remove" };
  if (code === "A") return { mark: "A", tone: "add" };
  if (code === "R") return { mark: "R", tone: "add" };
  return { mark: "M", tone: "add" };
}

/** What the working tree amounts to, in words, for the changes list. */
export function summarise(status: GitStatus): string {
  const parts: string[] = [];
  if (status.conflicted) parts.push(`${status.conflicted} conflicted`);
  if (status.staged) parts.push(`${status.staged} staged`);
  if (status.unstaged) parts.push(`${status.unstaged} changed`);
  if (status.untracked) parts.push(`${status.untracked} untracked`);
  return parts.length ? parts.join(" · ") : "Working tree clean";
}

export type PatchLine = { kind: "add" | "remove" | "same" | "meta"; text: string };

/** Above this a patch is not readable on a phone and not worth the DOM. */
const MAX_PATCH_LINES = 1200;

/**
 * Splits a unified diff into renderable lines, keeping hunk headers as meta.
 *
 * The indentation every line shares carries no information but costs the whole
 * width of a phone, so it is removed: a deeply nested hunk otherwise starts
 * off screen and has to be scrolled to before it can be read at all. The
 * change markers keep their column, and headers are left alone.
 */
export function patchLines(patch: string): PatchLine[] {
  const lines = patch.split("\n").slice(0, MAX_PATCH_LINES);
  const out: { kind: PatchLine["kind"]; marker: string; body: string }[] = [];

  for (const text of lines) {
    // "\ No newline at end of file" is a note about the patch, not a line of
    // the file: counting its zero indentation would defeat the trim below.
    if (
      text.startsWith("+++") ||
      text.startsWith("---") ||
      text.startsWith("@@") ||
      text.startsWith("\\")
    ) {
      out.push({ kind: "meta", marker: "", body: text });
      continue;
    }
    if (text.startsWith("diff ") || text.startsWith("index ") || text.startsWith("new ")) continue;

    const kind = text.startsWith("+") ? "add" : text.startsWith("-") ? "remove" : "same";
    // Every content line carries a one-character marker column, including the
    // space on a context line, so the body starts one character in.
    out.push({ kind, marker: text.slice(0, 1), body: text.slice(1) });
  }

  // A trailing blank from the final newline is not a line of the patch.
  if (out.at(-1)?.body === "" && out.at(-1)?.marker === "") out.pop();

  const shared = commonIndent(out.filter((line) => line.kind !== "meta").map((line) => line.body));
  return out.map((line) => ({
    kind: line.kind,
    text: line.marker + (line.kind === "meta" ? line.body : line.body.slice(shared)),
  }));
}

/**
 * Length of the leading whitespace every non-blank line shares.
 *
 * Blank lines are skipped: they have no indentation to speak of, and counting
 * them as zero would defeat the trim on every hunk that contains one.
 */
function commonIndent(bodies: string[]): number {
  let shared: string | null = null;
  for (const body of bodies) {
    if (body.trim() === "") continue;
    const indent = body.slice(0, body.length - body.trimStart().length);
    if (shared === null) {
      shared = indent;
      continue;
    }
    let i = 0;
    while (i < shared.length && i < indent.length && shared[i] === indent[i]) i++;
    shared = shared.slice(0, i);
    if (shared === "") break;
  }
  return shared?.length ?? 0;
}

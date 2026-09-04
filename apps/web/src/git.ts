import { useCallback, useEffect, useState } from "react";
import { useFileAccess, type FileAccess } from "./files.ts";

/** Mirrors `@pios/server`'s git module. Local operations only, no remotes. */

export interface GitFile {
  path: string;
  index: string;
  work: string;
  from?: string;
  untracked?: boolean;
  unmerged?: boolean;
}

export interface GitStatus {
  root: string;
  prefix: string;
  branch: string | null;
  head: string | null;
  upstream: { name: string; ahead: number; behind: number } | null;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  files: GitFile[];
  truncated: boolean;
}

export type GitAction =
  | { type: "stage"; paths: string[] }
  | { type: "stage_all" }
  | { type: "unstage"; paths: string[] }
  | { type: "unstage_all" }
  | { type: "discard"; paths: string[] }
  | { type: "commit"; message: string }
  | { type: "stash" }
  | { type: "stash_pop" };

/** Destructive enough that the sheet asks first. */
export function needsConfirmation(action: GitAction): boolean {
  return action.type === "discard";
}

async function call(
  access: FileAccess,
  path: string,
  init?: RequestInit & { search?: Record<string, string | undefined> },
): Promise<unknown> {
  if (!access.baseUrl) throw new Error("not connected");
  const url = new URL(path, access.baseUrl);
  url.searchParams.set("session", access.sessionId);
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

export interface Git {
  /** Null while loading, or when the session cwd is not a repository. */
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  refresh: () => void;
  run: (action: GitAction) => Promise<void>;
  diff: (path: string, staged: boolean) => Promise<string>;
}

/**
 * Git state for the active session's working directory.
 *
 * Polled on demand rather than pushed: this is ambient state of a directory,
 * not conversation state, so it must not ride the entry stream whose ids are
 * the resync cursor. `settled` re-reads once a turn finishes, which is when
 * the agent has stopped writing files.
 */
export function useGitStatus(settled: unknown): Git {
  const access = useFileAccess();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const sessionId = access?.sessionId;
  const baseUrl = access?.baseUrl;

  useEffect(() => {
    if (!access?.baseUrl) return;
    let cancelled = false;
    setLoading(true);
    call(access, "/git/status")
      .then((body) => {
        if (cancelled) return;
        setStatus(((body as { status?: GitStatus | null })?.status ?? null) as GitStatus | null);
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `access` is memoised by the provider; the identity fields are listed so
    // a re-render with the same session does not refetch.
  }, [baseUrl, sessionId, settled, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const run = useCallback(
    async (action: GitAction) => {
      if (!access) return;
      setBusy(true);
      try {
        const body = await call(access, "/git/action", {
          method: "POST",
          body: JSON.stringify(action),
        });
        // The action response carries the recomputed status, so the sheet
        // redraws without a second round trip.
        setStatus((body as { status?: GitStatus | null })?.status ?? null);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [access],
  );

  const diff = useCallback(
    async (path: string, staged: boolean) => {
      if (!access) return "";
      const body = await call(access, "/git/diff", {
        search: { path, staged: staged ? "1" : undefined },
      });
      return typeof (body as { diff?: unknown })?.diff === "string"
        ? ((body as { diff: string }).diff)
        : "";
    },
    [access],
  );

  return { status, loading, error, busy, refresh, run, diff };
}

/** Short summary for the chat header: branch plus what is uncommitted. */
export function statusChip(status: GitStatus): string {
  const parts: string[] = [status.branch ?? status.head ?? "detached"];
  if (status.conflicted > 0) parts.push(`!${status.conflicted}`);
  if (status.staged > 0) parts.push(`+${status.staged}`);
  if (status.unstaged > 0) parts.push(`~${status.unstaged}`);
  if (status.untracked > 0) parts.push(`?${status.untracked}`);
  return parts.join(" ");
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

export type PatchLine = { kind: "add" | "remove" | "same" | "meta"; text: string };

/** Above this a patch is not readable on a phone and not worth the DOM. */
const MAX_PATCH_LINES = 1200;

/** Splits a unified diff into renderable lines, keeping hunk headers as meta. */
export function patchLines(patch: string): PatchLine[] {
  const lines = patch.split("\n").slice(0, MAX_PATCH_LINES);
  const out: PatchLine[] = [];
  for (const text of lines) {
    if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("@@")) {
      out.push({ kind: "meta", text });
    } else if (text.startsWith("diff ") || text.startsWith("index ") || text.startsWith("new ")) {
      continue;
    } else if (text.startsWith("+")) out.push({ kind: "add", text });
    else if (text.startsWith("-")) out.push({ kind: "remove", text });
    else out.push({ kind: "same", text });
  }
  // A trailing blank from the final newline is not a line of the patch.
  if (out.at(-1)?.text === "") out.pop();
  return out;
}

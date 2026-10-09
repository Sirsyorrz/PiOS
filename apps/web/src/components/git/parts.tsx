import { useEffect, useState, type ReactNode } from "react";
import type { GitFile } from "@pios/protocol";
import { fileMark, patchLines } from "../../git.ts";

/** Pieces shared by the git view's tabs. Nothing here fetches on its own. */

/**
 * A tiny keyed store for what a tab drew last.
 *
 * Bounded, because the key is a commit id: an hour of committing would
 * otherwise keep every list the session ever rendered.
 */
export function lastSeen<T>(limit = 4) {
  const entries = new Map<string, T>();
  return {
    get: (key: string) => entries.get(key),
    set(key: string, value: T) {
      entries.delete(key);
      entries.set(key, value);
      for (const stale of [...entries.keys()].slice(0, entries.size - limit)) entries.delete(stale);
    },
  };
}

export function GitSection({ title, action, children }: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="git-block">
      <h3 className="git-section">
        <span>{title}</span>
        {action}
      </h3>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted git-empty">{children}</p>;
}

/**
 * One changed file: a wide tap target for the diff, then its controls.
 *
 * The controls are siblings of the row, not children: a button inside a
 * button is not a thing the DOM has.
 */
export function FileRow({ file, onSelect, controls }: {
  file: GitFile;
  onSelect: () => void;
  controls: ReactNode;
}) {
  const { mark, tone } = fileMark(file);
  return (
    <div className="git-row">
      <button type="button" className="list-row iconic" onClick={onSelect}>
        <span className={`row-icon git-mark ${tone}`}>{mark}</span>
        <span className="row-main line">
          {file.from ? `${file.from} → ${file.path}` : file.path}
        </span>
      </button>
      {controls}
    </div>
  );
}

export function IconButton({ label, disabled, danger, onClick, children }: {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={danger ? "ghost icon danger" : "ghost icon"}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A named consequence with a way out. Used for everything destructive. */
export function ConfirmBar({ text, confirmLabel, onConfirm, onCancel, alt }: {
  text: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** A harsher variant of the same intent, offered rather than hidden. */
  alt?: { label: string; onClick: () => void };
}) {
  return (
    <div className="banner warn git-confirm">
      <span className="git-confirm-text">{text}</span>
      <span className="row wrap">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        {alt ? (
          <button type="button" className="danger" onClick={alt.onClick}>
            {alt.label}
          </button>
        ) : null}
        <button type="button" className="primary" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </span>
    </div>
  );
}

/**
 * A patch, loaded once per subject.
 *
 * The loader is keyed by `subject` rather than by identity: a caller building
 * a closure per render would otherwise refetch on every keystroke elsewhere.
 */
export function DiffPane({ subject, load }: { subject: string; load: () => Promise<string> }) {
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPatch(null);
    setError(null);
    load()
      .then((text) => !cancelled && setPatch(text))
      .catch((cause: unknown) => !cancelled && setError(String((cause as Error)?.message ?? cause)));
    return () => {
      cancelled = true;
    };
  }, [subject]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="banner error">{error}</p>;
  if (patch === null) return <Empty>Reading…</Empty>;
  if (patch.trim() === "") return <Empty>No changes to show.</Empty>;

  return (
    <pre className="diff">
      {patchLines(patch).map((line, index) => (
        <div key={index} className={line.kind === "meta" ? "diff-meta" : `diff-${line.kind}`}>
          {line.text || " "}
        </div>
      ))}
    </pre>
  );
}

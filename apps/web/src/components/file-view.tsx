import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { FileAccess } from "../files.ts";
import {
  dropDraft,
  loadDraft,
  loadTextFile,
  loadTree,
  saveDraft,
  saveTextFile,
  searchFiles,
  type TextFile,
  type TreeListing,
} from "../file-edit.ts";
import { isolate } from "../format.ts";
import type { EditorHandle } from "./code-editor.tsx";
import {
  ChevronLeftIcon,
  CloseIcon,
  FileIcon,
  FolderIcon,
  RedoIcon,
  UndoIcon,
} from "./icons.tsx";
import { ListRowButton, SearchField } from "./ui.tsx";

const CodeEditor = lazy(() =>
  import("./code-editor.tsx").then((module) => ({ default: module.CodeEditor })),
);

const REFUSALS: Record<NonNullable<TextFile["reason"]>, string> = {
  too_large: "Too large to edit. Showing the start of the file.",
  binary: "Not a text file. Showing the start of it as text.",
  long_lines: "Lines are too long to edit. Showing the start of the file.",
};

/**
 * Reading and editing a file in the session's directory.
 *
 * Full screen rather than a sheet: the software keyboard takes most of a
 * phone, and an editor squeezed into what is left is not one.
 */
export function FileView({ access, cwd, path, onOpen, onClose }: {
  access: FileAccess;
  /** Session directory, so paths are shown and stored relative to it. */
  cwd: string;
  /** Null shows the picker. */
  path: string | null;
  onOpen: (path: string | null) => void;
  onClose: () => void;
}) {
  if (!path) {
    return (
      <FilePicker
        access={access}
        onPick={(picked) => onOpen(relativeTo(cwd, picked))}
        onClose={onClose}
      />
    );
  }
  return (
    <FileEditor
      access={access}
      path={path}
      onBrowse={() => onOpen(null)}
      onClose={onClose}
    />
  );
}

/** Fuzzy search when there is a query, the directory tree when there is not. */
function FilePicker({ access, onPick, onClose }: {
  access: FileAccess;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<string[]>([]);
  const [listing, setListing] = useState<TreeListing | null>(null);
  const [at, setAt] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) return;
    let live = true;
    // The daemon caches its index, so a keystroke is cheap; a debounce would
    // cost more in perceived lag than it saves in requests.
    void searchFiles(access, query)
      .then((files) => live && setMatches(files))
      .catch(() => live && setError("Search unavailable."));
    return () => {
      live = false;
    };
  }, [access, query]);

  useEffect(() => {
    let live = true;
    void loadTree(access, at)
      .then((next) => live && setListing(next))
      .catch(() => live && setError("This directory could not be read."));
    return () => {
      live = false;
    };
  }, [access, at]);

  const browsing = !query.trim();
  // At the top it is the project; below it, the path inside the project.
  const here = listing ? (listing.parent ? relativeTo(listing.root, listing.path) : listing.name) : null;
  return (
    <section className="file-view">
      <header className="file-head">
        <button type="button" className="ghost icon" aria-label="back to chat" onClick={onClose}>
          <ChevronLeftIcon />
        </button>
        <h2 className="line tail">{here ? isolate(here) : "Files"}</h2>
      </header>

      <SearchField value={query} placeholder="Search files" onChange={setQuery} />
      {error ? <p className="banner error">{error}</p> : null}

      <div className="scroll-y file-list">
        {browsing ? (
          <>
            {listing?.parent ? (
              <ListRowButton icon={<FolderIcon />} onClick={() => setAt(listing.parent!)}>
                ..
              </ListRowButton>
            ) : null}
            {listing?.entries.map((entry) => (
              <ListRowButton
                key={entry.path}
                icon={entry.dir ? <FolderIcon /> : <FileIcon />}
                onClick={() => (entry.dir ? setAt(entry.path) : onPick(entry.path))}
              >
                {isolate(entry.name)}
              </ListRowButton>
            ))}
          </>
        ) : (
          matches.map((match) => (
            <ListRowButton key={match} icon={<FileIcon />} onClick={() => onPick(match)}>
              {isolate(match)}
            </ListRowButton>
          ))
        )}
      </div>
    </section>
  );
}

type Conflict = { etag: string };

function FileEditor({ access, path, onBrowse, onClose }: {
  access: FileAccess;
  path: string;
  onBrowse: () => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<TextFile | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [restored, setRestored] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const handle = useRef<EditorHandle | null>(null);

  useEffect(() => {
    let live = true;
    setFile(null);
    setError(null);
    setConflict(null);
    setRestored(false);
    setDirty(false);
    setEditing(false);

    void (async () => {
      try {
        const loaded = await loadTextFile(access, path);
        const draft = await loadDraft(access.sessionId, path);
        if (!live) return;
        setFile(loaded);
        // A draft from an older version of the file is still the user's work:
        // it is shown, and the stale etag surfaces as a conflict on save.
        setText(draft ? draft.text : loaded.text);
        setDirty(Boolean(draft));
        setRestored(Boolean(draft));
        if (draft) setEditing(true);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : "Unavailable");
      }
    })();
    return () => {
      live = false;
    };
  }, [access, path]);

  function edited(next: string) {
    setText(next);
    setDirty(true);
    if (file) {
      void saveDraft({ sessionId: access.sessionId, path, text: next, etag: file.etag });
    }
  }

  async function save(force = false): Promise<void> {
    if (!file) return;
    setSaving(true);
    setError(null);
    const result = await saveTextFile(access, path, text, {
      ...file,
      etag: force ? "*" : file.etag,
    });
    setSaving(false);

    if (result.ok) {
      setFile({ ...file, etag: result.etag });
      setDirty(false);
      setRestored(false);
      setConflict(null);
      void dropDraft(access.sessionId, path);
      return;
    }
    if (result.conflict) setConflict({ etag: result.etag });
    else setError(result.message);
  }

  async function reload(): Promise<void> {
    const loaded = await loadTextFile(access, path);
    setFile(loaded);
    setText(loaded.text);
    setDirty(false);
    setRestored(false);
    setConflict(null);
    void dropDraft(access.sessionId, path);
  }

  function leave(go: () => void) {
    // The draft is already on disk, so this asks about attention, not data.
    if (dirty && !window.confirm("Leave with unsaved changes? They are kept as a draft.")) return;
    go();
  }

  const readOnly = !editing || !file?.editable;
  return (
    <section className="file-view">
      <header className="file-head">
        <button
          type="button"
          className="ghost icon"
          aria-label="back to chat"
          onClick={() => leave(onClose)}
        >
          <ChevronLeftIcon />
        </button>
        <h2 className="line tail" onClick={() => leave(onBrowse)}>
          {isolate(path)}
          {dirty ? <span className="dirty-dot" aria-label="unsaved changes" /> : null}
        </h2>
        {file?.editable ? (
          editing ? (
            <button
              type="button"
              className="primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          ) : (
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
          )
        ) : null}
      </header>

      {error ? <p className="banner error">{error}</p> : null}
      {file && !file.editable ? <p className="banner warn">{REFUSALS[file.reason!]}</p> : null}
      {restored ? <p className="banner">Restored unsaved edits from this device.</p> : null}

      {conflict ? (
        <div className="banner warn file-conflict">
          <span>This file changed on disk since you opened it.</span>
          <span className="row">
            <button type="button" onClick={() => void reload()}>
              Reload
            </button>
            <button type="button" className="danger" onClick={() => void save(true)}>
              Overwrite
            </button>
          </span>
        </div>
      ) : null}

      {file ? (
        <Suspense fallback={<p className="muted">Loading editor…</p>}>
          <CodeEditor
            text={text}
            path={path}
            readOnly={readOnly}
            handle={handle}
            onChange={edited}
          />
        </Suspense>
      ) : error ? null : (
        <p className="muted">Reading…</p>
      )}

      {editing && file?.editable ? (
        // Above the keyboard: the keys a code editor needs that a phone
        // keyboard does not have.
        <div className="file-keys row">
          <button type="button" onClick={() => handle.current?.outdent()} aria-label="outdent">
            ⇤
          </button>
          <button type="button" onClick={() => handle.current?.indent()} aria-label="indent">
            ⇥
          </button>
          <button type="button" onClick={() => handle.current?.undo()} aria-label="undo">
            <UndoIcon />
          </button>
          <button type="button" onClick={() => handle.current?.redo()} aria-label="redo">
            <RedoIcon />
          </button>
          <button
            type="button"
            className="ghost icon"
            aria-label="stop editing"
            onClick={() => setEditing(false)}
          >
            <CloseIcon />
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** Paths are shown, stored and sent relative to the session directory. */
function relativeTo(root: string, path: string): string {
  if (path === root) return ".";
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

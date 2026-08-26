import { useCallback, useEffect, useState } from "react";
import { ChevronRightIcon, FolderIcon, FolderUpIcon } from "./icons.tsx";
import { ListRowButton, ModalCard, PickerHeader } from "./ui.tsx";

interface Listing {
  root: string;
  path: string;
  name: string;
  parent: string | null;
  entries: { name: string; path: string }[];
}

/** Browses the daemon's home directory to pick a session cwd. */
export function DirectoryPicker({ baseUrl, token, startPath, onPick, onCancel }: {
  baseUrl: string;
  token: string;
  /** Where to open the browser; the current session's cwd when there is one. */
  startPath?: string | null;
  onPick: (path: string, trustProject: boolean) => void;
  onCancel: () => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Checked by default: a session without project extensions and settings is
  // not what someone picking their own project directory expects.
  const [trust, setTrust] = useState(true);
  const [path, setPath] = useState<string | null>(null);

  const load = useCallback(
    async (target: string | null, fallbackToRoot = false): Promise<void> => {
      setError(null);
      const url = new URL("/dirs", baseUrl);
      if (target) url.searchParams.set("path", target);
      try {
        const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(`listing failed (${response.status})`);
        const next = (await response.json()) as Listing;
        setListing(next);
        setPath(next.path);
      } catch (cause) {
        // A session cwd outside the daemon's home is not browsable; the root
        // listing is still better than an empty picker.
        if (fallbackToRoot) return await load(null);
        setError(String(cause instanceof Error ? cause.message : cause));
      }
    },
    [baseUrl, token],
  );

  useEffect(() => {
    void load(startPath ?? null, startPath != null);
  }, [load, startPath]);

  return (
    <ModalCard className="picker">
      <PickerHeader
        title="New session"
        onCancel={onCancel}
        action={
          <button type="button" disabled={!path} onClick={() => path && onPick(path, trust)}>
            Start here
          </button>
        }
      />
      <p className="muted path">{path ?? "loading..."}</p>
      {error ? <p className="error">{error}</p> : null}

      <label className="row inline">
        <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
        {/* Trust loads project-local extensions and settings, which is code
            execution the user has to be able to decline. */}
        <span>Trust this directory (loads project extensions and settings)</span>
      </label>

      <ul className="dirlist scroll-y">
        {listing?.parent ? (
          <li>
            <ListRowButton icon={<FolderUpIcon />} onClick={() => void load(listing.parent)}>
              <span className="name line">../</span>
            </ListRowButton>
          </li>
        ) : null}
        {listing?.entries.map((entry) => (
          <li key={entry.path}>
            <ListRowButton
              icon={<FolderIcon />}
              trailing={<ChevronRightIcon />}
              onClick={() => void load(entry.path)}
            >
              <span className="name line">{entry.name}</span>
            </ListRowButton>
          </li>
        ))}
      </ul>
    </ModalCard>
  );
}

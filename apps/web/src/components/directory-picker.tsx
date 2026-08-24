import { useCallback, useEffect, useState } from "react";

interface Listing {
  root: string;
  path: string;
  name: string;
  parent: string | null;
  entries: { name: string; path: string }[];
}

/** Browses the daemon's home directory to pick a session cwd. */
export function DirectoryPicker({ baseUrl, token, onPick, onCancel }: {
  baseUrl: string;
  token: string;
  onPick: (path: string, trustProject: boolean) => void;
  onCancel: () => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState(false);
  const [path, setPath] = useState<string | null>(null);

  const load = useCallback(
    async (target: string | null) => {
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
        setError(String(cause instanceof Error ? cause.message : cause));
      }
    },
    [baseUrl, token],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="screen centered">
      <div className="card">
        <h1>New session</h1>
        <p className="muted">{path ?? "loading..."}</p>
        {error ? <p className="error">{error}</p> : null}

        <ul className="dirlist">
          {listing?.parent ? (
            <li>
              <button type="button" onClick={() => void load(listing.parent)}>
                ../
              </button>
            </li>
          ) : null}
          {listing?.entries.map((entry) => (
            <li key={entry.path}>
              <button type="button" onClick={() => void load(entry.path)}>
                {entry.name}/
              </button>
            </li>
          ))}
        </ul>

        <label className="row">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
          {/* Trust loads project-local extensions and settings, which is code
              execution the user has to opt into per session. */}
          Trust this directory (loads project extensions and settings)
        </label>

        <div className="row">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" disabled={!path} onClick={() => path && onPick(path, trust)}>
            Start here
          </button>
        </div>
      </div>
    </div>
  );
}

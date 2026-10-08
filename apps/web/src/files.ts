import { createContext, useContext, useEffect, useState } from "react";

export interface FileAccess {
  /** HTTP origin of the daemon, or null while no endpoint is chosen. */
  baseUrl: string | null;
  deviceToken: string;
  /** Session whose cwd a relative path is resolved against. */
  sessionId: string;
  /** Set for a draft, which has a directory before it has a session. */
  cwd?: string;
}

/** Query naming the project a file request is about. */
export function projectQuery(access: FileAccess): string {
  const session = `session=${encodeURIComponent(access.sessionId)}`;
  return access.cwd ? `${session}&cwd=${encodeURIComponent(access.cwd)}` : session;
}

export const FileAccessContext = createContext<FileAccess | null>(null);

export function useFileAccess(): FileAccess | null {
  return useContext(FileAccessContext);
}

/** Paths the browser can load on its own; everything else goes through /file. */
export function isDirectSrc(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

const cache = new Map<string, string>();

/**
 * Object URL for a file served by the daemon.
 *
 * `/file` needs a bearer token, and an `<img src>` cannot carry one, so the
 * bytes are fetched and handed to the DOM as a blob. Object URLs are cached
 * per request URL and never revoked: the same image reappears on every
 * re-render of the transcript, and a revoked URL renders as a broken image.
 */
export function useFileObjectUrl(path: string | null): {
  url: string | null;
  error: string | null;
} {
  const access = useFileAccess();
  const key =
    access?.baseUrl && path
      ? `${access.baseUrl}/file?${projectQuery(access)}&path=${encodeURIComponent(path)}`
      : null;
  const [url, setUrl] = useState<string | null>(() => (key ? (cache.get(key) ?? null) : null));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!key || !access) {
      setUrl(null);
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setUrl(hit);
      setError(null);
      return;
    }

    let live = true;
    setUrl(null);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(key, {
          headers: { authorization: `Bearer ${access.deviceToken}` },
        });
        if (!response.ok) throw new Error(response.status === 404 ? "not found" : "unavailable");
        const objectUrl = URL.createObjectURL(await response.blob());
        cache.set(key, objectUrl);
        if (live) setUrl(objectUrl);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : "unavailable");
      }
    })();
    return () => {
      live = false;
    };
  }, [key, access?.deviceToken]);

  return { url, error };
}
